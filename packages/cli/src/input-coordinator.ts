import readline from 'node:readline';
import { type Readable, Writable } from 'node:stream';
import type { ApprovalChoice, ApprovalRequest } from '@kiturone/kapibala';
import { escapeApprovalText } from './ui/approval.js';
import type { SelectConfig } from './ui/select.js';

/**
 * {@link CliInputCoordinator} 的构造参数；input/output 可注入以便测试与宿主复用。
 * `interactive` 缺省按两侧流是否均为 TTY 推断；显式置 false 时菜单按取消、
 * 审批按拒绝处理，问答原语直接抛错。
 */
export interface CliInputOptions {
  input?: Readable;
  output?: Writable;
  interactive?: boolean;
  terminal?: boolean;
}

interface PendingQuestion {
  finish: (value?: string, error?: Error) => void;
  secret: boolean;
}

/** 统一的「能否真实交互」判定：stdin 与 stdout 都是 TTY 才允许菜单/审批改状态。 */
export function isInteractiveTerminal(): boolean {
  return Boolean(
    (process.stdin as NodeJS.ReadStream | undefined)?.isTTY &&
      (process.stdout as NodeJS.WriteStream | undefined)?.isTTY,
  );
}

/** REPL、菜单、向导、审批和密钥的单一输入所有者；任何时刻只有一个问答消费者。 */
export class CliInputCoordinator {
  readonly interactive: boolean;
  /** readline 关闭（EOF / close）后 resolve；宿主据此等待输入循环完全退出。 */
  readonly whenClosed: Promise<void>;
  private readonly rl: readline.Interface;
  private readonly output: Writable;
  private readonly input: Readable;
  private pending?: PendingQuestion;
  private lineHandler?: (line: string) => void;
  private interruptHandler?: () => void;
  private detailToggleHandler?: () => void;
  private completionHandler?: (line: string) => [string[], string];
  private readonly interactionHandlers = new Set<() => void>();
  /** 后台或并发子代理审批在独占问答/密钥录入或多步命令交互期间的 FIFO 等待唤醒队列。 */
  private readonly approvalWaiters: Array<() => void> = [];
  /** 多步交互命令（如 `/model` 分级菜单与补录密钥）嵌套锁计数；大于 0 时阻止后台审批穿插抢占。 */
  private commandSessionDepth = 0;
  /** 后台审批打断空闲输入行时暂存的未提交草稿与光标偏移。 */
  private savedIdleDraft?: { line: string; cursor: number };
  /** 连接模式空闲行读取挂起回调（不占用 `pending`，允许后台审批随时插入并恢复输入行）。 */
  private chatLineWaiters: Array<{
    resolve: (line: string | null) => void;
  }> = [];
  private closed = false;
  /**
   * 只保留聊天问句的进程内历史；审批答案、菜单选项、确认词与密钥不进入，
   * 避免 ↑ 把 `1`、`yes` 或 API Key 重新放回编辑缓冲。
   */
  private readonly chatHistory: string[] = [];
  /** 当前浏览位置：等于长度表示停在未提交草稿，小于长度为历史项下标。 */
  private historyIndex = 0;
  /** 首次上翻时保存的未提交草稿；回到最新项时按原光标恢复。 */
  private unfinished: { line: string; cursor: number } | undefined;
  private readonly signalHandler = () => this.interrupt();
  /** readline 对未绑定 Ctrl+O 会插入控制字节；先路由，再改为其忽略的 Escape，完全不访问秘密缓冲。 */
  private readonly keyHandler = (_value: string, key: readline.Key) => {
    if (key?.name === 'o' && key.ctrl) {
      key.name = 'escape';
      if (this.interactive && !this.pending && !this.closed) this.detailToggleHandler?.();
      return;
    }
    if (key?.name === 'escape' && this.pending) this.cancel();
    // 独占问答期间 ↑/↓ 不碰历史，避免把审批答案顶替成聊天问句；readline 自身历史已关闭。
    if ((key?.name === 'up' || key?.name === 'down') && !this.pending && !this.closed) {
      if (this.navigateHistory(key.name === 'up' ? -1 : 1)) key.name = 'escape';
    }
  };

  constructor(options: CliInputOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.interactive =
      options.interactive ??
      Boolean((this.input as NodeJS.ReadStream).isTTY && (this.output as NodeJS.WriteStream).isTTY);
    const guardedOutput = new Writable({
      write: (chunk, _encoding, callback) => {
        if (!this.pending?.secret) {
          for (const handler of this.interactionHandlers) handler();
          this.output.write(chunk);
        }
        callback();
      },
    });
    Object.defineProperty(guardedOutput, 'columns', {
      get: () => (this.output as NodeJS.WriteStream).columns,
    });
    this.rl = readline.createInterface({
      input: this.input,
      output: guardedOutput,
      terminal: options.terminal ?? this.interactive,
      // readline 默认把所有 line 事件（含审批答案、菜单选项与密钥）自动记入 ↑ 历史；
      // 这里关闭隐式历史，改由 remember() 只记录宿主确认为聊天的输入。
      historySize: 0,
      completer: (line: string) =>
        !this.pending ? (this.completionHandler?.(line) ?? [[], line]) : [[], line],
    });
    this.rl.pause();
    this.rl.on('line', (line) => {
      // 兜底清空 readline 自有历史：即便某个 Node 版本忽略 historySize: 0，
      // 密钥与审批答案也不能停在 ↑ 能召回的位置。
      (this.rl as unknown as { history: string[] }).history.length = 0;
      if (this.pending) this.pending.finish(line);
      else {
        this.remember(line);
        const waiter = this.chatLineWaiters.shift();
        if (waiter) waiter.resolve(line);
        else this.lineHandler?.(line);
      }
    });
    let finish!: () => void;
    this.whenClosed = new Promise((resolve) => {
      finish = resolve;
    });
    this.rl.on('close', () => {
      this.closed = true;
      this.savedIdleDraft = undefined;
      this.cancel();
      for (const waiter of this.chatLineWaiters.splice(0)) waiter.resolve(null);
      for (const wake of this.approvalWaiters.splice(0)) wake();
      this.input.removeListener('keypress', this.keyHandler);
      this.detailToggleHandler = undefined;
      this.completionHandler = undefined;
      this.interactionHandlers.clear();
      process.off('SIGINT', this.signalHandler);
      finish();
    });
    this.rl.on('SIGINT', this.signalHandler);
    this.input.prependListener('keypress', this.keyHandler);
    process.on('SIGINT', this.signalHandler);
  }

  /** 设置普通行消费者；对话执行中输入由宿主判断只读命令或拒绝，不能排队串入审批。 */
  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler;
    this.rl.resume();
  }
  /** 注册宿主中断并启用终端按键读取；返回解绑函数，不消费非交互管道输入。 */
  onInterrupt(handler: () => void): () => void {
    this.interruptHandler = handler;
    if (this.interactive) this.rl.resume();
    return () => {
      if (this.interruptHandler === handler) this.interruptHandler = undefined;
    };
  }
  isBusy(): boolean {
    return !!this.pending;
  }

  /** 本轮详情快捷键沿用同一输入者；独占问答与秘密输入期间完全禁用，不查看编辑缓冲。 */
  onDetailToggle(handler: () => void): () => void {
    this.detailToggleHandler = handler;
    if (this.interactive) this.rl.resume();
    return () => {
      if (this.detailToggleHandler === handler) this.detailToggleHandler = undefined;
    };
  }

  /** 补全读取当前会话的元数据；问答期间不补全，切换会话不缓存旧名称。 */
  setCompleter(handler: (line: string) => [string[], string]): void {
    this.completionHandler = handler;
  }

  /** 菜单、审批或提示符输出前通知宿主失效过程锚点，避免回写其他交互内容。 */
  onInteraction(handler: () => void): () => void {
    this.interactionHandlers.add(handler);
    return () => {
      this.interactionHandlers.delete(handler);
    };
  }

  /** 使用同一 readline 问一个问题；取消、EOF、非 TTY 和同时读者均立即明确结束。 */
  async question(
    prompt: string,
    options?: { signal?: AbortSignal; secret?: boolean },
  ): Promise<string> {
    if (!this.interactive) throw new Error('交互输入不可用，请在 TTY 终端操作');
    if (this.closed) throw new Error('Input closed');
    if (this.pending) throw new Error('Input is busy / 输入已被占用');
    if (options?.signal?.aborted) throw new Error('Input cancelled');
    // 独占问答会清空编辑缓冲，历史浏览必须回到「未提交草稿」起点；
    // 同时立即清空底层 readline 行缓冲，避免用户在问答弹出前按 ↑ 或预敲的字符混入本次审批/输入答案。
    this.resetHistoryNavigation();
    (this.rl as unknown as { line: string }).line = '';
    (this.rl as unknown as { cursor: number }).cursor = 0;
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => finish(undefined, new Error('Input cancelled'));
      const finish = (value?: string, error?: Error) => {
        if (!this.pending || this.pending.finish !== finish) return;
        const secret = this.pending.secret;
        this.pending = undefined;
        options?.signal?.removeEventListener('abort', onAbort);
        (this.rl as unknown as { line: string }).line = '';
        (this.rl as unknown as { cursor: number }).cursor = 0;
        if (secret) {
          this.output.write('\n');
          if (this.secretOutputBuffer.length > 0) {
            for (const chunk of this.secretOutputBuffer) {
              this.output.write(chunk);
            }
            this.secretOutputBuffer.length = 0;
          }
        }
        if (error) reject(error);
        else resolve(value ?? '');
        if (this.commandSessionDepth === 0) {
          // 推迟两个微任务再唤醒后台审批：既让 select -> question 链式微任务先拿到 pending，又不跨越宏任务丢失同步写流输入。
          queueMicrotask(() => {
            queueMicrotask(() => {
              if (!this.pending && this.commandSessionDepth === 0 && !this.closed) {
                this.approvalWaiters.shift()?.();
              }
            });
          });
        }
      };
      this.pending = { finish, secret: options?.secret ?? false };
      for (const handler of this.interactionHandlers) handler();
      options?.signal?.addEventListener('abort', onAbort, { once: true });
      this.output.write(prompt);
      this.rl.resume();
    });
  }

  private readonly secretOutputBuffer: string[] = [];

  /**
   * 当前是否处于不回显的秘密输入状态（如录入 API Key）。
   */
  isSecret(): boolean {
    return Boolean(this.pending?.secret);
  }

  /**
   * 写入受守卫保护的终端输出。
   * 若当前处于秘密输入中，自动将输出缓冲，直到秘密输入完成再按序刷新至终端，
   * 避免后台任务事件打断或泄漏秘密输入提示。
   */
  writeGuarded(chunk: string): void {
    if (this.isSecret()) {
      this.secretOutputBuffer.push(chunk);
      return;
    }
    this.output.write(chunk);
  }

  /** 密钥输入不回显，也不转发为后续菜单、审批或聊天输入。 */
  readSecret(prompt: string): Promise<string> {
    return this.question(prompt, { secret: true });
  }

  /** 菜单在非 TTY 返回取消，不创建第二套 stdin/readline；Esc/Ctrl+C/EOF 只取消本菜单。 */
  async select<T>(config: SelectConfig<T>): Promise<T | null> {
    if (!this.interactive || !config.options.length) return null;
    for (const handler of this.interactionHandlers) handler();
    this.output.write(`\n${config.message}\n`);
    config.options.forEach((option, index) =>
      this.output.write(
        `  ${index + 1}) ${option.label}${option.badge ? ` [${option.badge}]` : ''}${option.description ? ` — ${option.description}` : ''}\n`,
      ),
    );
    try {
      const answer = (
        await this.question(`选择 1–${config.options.length}，Esc/Ctrl+C 取消: `)
      ).trim();
      if (!/^[1-9]\d*$/.test(answer)) return null;
      return config.options[Number(answer) - 1]?.value ?? null;
    } catch (error) {
      if (error instanceof Error && /cancel|closed/i.test(error.message)) return null;
      throw error;
    }
  }

  /** FullAccess 只接受明确 yes；交互不可用时不自动批准。 */
  async confirm(prompt: string): Promise<boolean> {
    return (await this.question(`${prompt} 输入 yes 确认: `)).trim().toLowerCase() === 'yes';
  }

  /**
   * 在多步命令交互（如 `/model` 两步菜单与后续补录密钥）期间维持命令会话锁：
   * 步骤切换间隙不释放给后台子代理审批，整条命令结束后再按 FIFO 唤醒挂起审批。
   */
  async withCommandSession<T>(action: () => Promise<T>): Promise<T> {
    this.commandSessionDepth += 1;
    try {
      return await action();
    } finally {
      this.commandSessionDepth = Math.max(0, this.commandSessionDepth - 1);
      if (this.commandSessionDepth === 0 && !this.pending && !this.closed) {
        this.approvalWaiters.shift()?.();
      }
    }
  }

  /**
   * 空闲提示符下等待下一条普通输入行（不占用 `pending`），允许后台子代理审批随时插入并在完成后无损恢复草稿。
   * 输入流关闭（EOF / `close()`）时返回 `null`。
   */
  async readChatLine(promptText: string): Promise<string | null> {
    if (!this.interactive) throw new Error('交互输入不可用，请在 TTY 终端操作');
    if (this.closed) return null;
    this.rl.resume();
    this.prompt(promptText);
    return new Promise<string | null>((resolve) => {
      if (this.closed) {
        resolve(null);
        return;
      }
      this.chatLineWaiters.push({ resolve });
    });
  }

  /** 审批展示完整安全转义的参数与命令，输入由本协调器独占（忙碌期按序排队），非 TTY 明确拒绝。 */
  async approve(
    request: ApprovalRequest & { readonly formattedTarget?: string },
    signal?: AbortSignal,
  ): Promise<ApprovalChoice> {
    if (!this.interactive) return 'deny_once';
    if (signal?.aborted || this.closed) return 'cancel';
    while ((this.pending || this.commandSessionDepth > 0) && !this.closed) {
      if (signal?.aborted) return 'cancel';
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal?.removeEventListener('abort', onAbort);
          const idx = this.approvalWaiters.indexOf(wake);
          if (idx >= 0) this.approvalWaiters.splice(idx, 1);
          resolve();
        };
        const onAbort = () => wake();
        this.approvalWaiters.push(wake);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (signal?.aborted || this.closed) return 'cancel';
    const rlState = this.rl as unknown as { line: string; cursor: number };
    if (!this.savedIdleDraft && !this.pending && this.commandSessionDepth === 0) {
      this.savedIdleDraft = {
        line: rlState.line ?? '',
        cursor: Math.max(0, Math.min(rlState.cursor ?? 0, (rlState.line ?? '').length)),
      };
    }
    const originHeader = request.subagentOrigin
      ? `[子代理: ${escapeApprovalText(request.subagentOrigin.description)}]\n`
      : '';
    const target = request.formattedTarget
      ? `工具: ${escapeApprovalText(request.toolName)}\n${escapeApprovalText(request.formattedTarget)}`
      : request.shell
        ? `解释器: ${escapeApprovalText(request.shell.executablePath ?? request.shell.interpreter)}\n工作目录: ${escapeApprovalText(request.shell.cwd)}\n完整命令: ${escapeApprovalText(request.shell.command)}`
        : `工具: ${escapeApprovalText(request.toolName)}\n参数: ${escapeApprovalText(JSON.stringify(request.input))}`;
    try {
      const answer = (
        await this.question(
          `\n${originHeader}${target}\n[1] 本次允许 ${request.sessionAllowed ? '[2] 本会话允许 ' : ''}[3] 拒绝 [4] 本会话拒绝\n选择: `,
          { signal },
        )
      ).trim();
      if (answer === '1') return 'allow_once';
      if (answer === '2' && request.sessionAllowed) return 'allow_session';
      if (answer === '4') return 'deny_session';
      return 'deny_once';
    } catch {
      return 'cancel';
    } finally {
      if (
        this.savedIdleDraft &&
        !this.closed &&
        !this.pending &&
        this.approvalWaiters.length === 0
      ) {
        const draft = this.savedIdleDraft;
        this.savedIdleDraft = undefined;
        rlState.line = draft.line;
        rlState.cursor = Math.max(0, Math.min(draft.cursor, draft.line.length));
      }
    }
  }

  /** 取消当前输入并清空编辑缓冲；不结束正在清理的任务，也不把取消字符交给下一流程。 */
  cancel(): void {
    this.pending?.finish(undefined, new Error('Input cancelled'));
  }
  close(): void {
    if (!this.closed) {
      this.cancel();
      this.rl.close();
    }
  }
  /** 空闲且交互时刷新提示符并保留已恢复草稿的光标位置；忙碌期调用不打印、不打断当前问答。 */
  prompt(value: string): void {
    if (!this.closed && !this.pending && this.interactive) {
      for (const handler of this.interactionHandlers) handler();
      this.rl.setPrompt(value);
      this.rl.prompt(true);
    }
  }
  clearLine(): void {
    (this.rl as unknown as { line: string }).line = '';
    (this.rl as unknown as { cursor: number }).cursor = 0;
    this.resetHistoryNavigation();
  }
  /** 记录一条已提交的聊天输入；空白与连续重复项不增加，最多保留最近 100 条。 */
  private remember(line: string): void {
    if (!line.trim()) return;
    if (this.chatHistory.at(-1) !== line) this.chatHistory.push(line);
    if (this.chatHistory.length > 100) this.chatHistory.splice(0, this.chatHistory.length - 100);
    this.resetHistoryNavigation();
  }
  /** 把浏览位置退回未提交草稿；问答开始、清行与提交后调用，避免沿用过期的历史下标。 */
  private resetHistoryNavigation(): void {
    this.historyIndex = this.chatHistory.length;
    this.unfinished = undefined;
  }
  /**
   * 在 readline 编辑缓冲上实现 ↑/↓ 浏览聊天历史，返回是否实际替换了内容。
   * 读取私有重绘方法是因为输入循环只能有一套：历史由本协调器独占，
   * 不能再建第二个 readline；独占问答期间调用方必须已挡掉。
   */
  private navigateHistory(direction: -1 | 1): boolean {
    const rl = this.rl as unknown as {
      line: string;
      cursor: number;
      _refreshLine?: () => void;
    };
    if (direction === -1) {
      if (this.historyIndex <= 0) return false;
      if (this.historyIndex === this.chatHistory.length) {
        this.unfinished = { line: rl.line, cursor: rl.cursor };
      }
      this.historyIndex--;
    } else {
      if (this.historyIndex >= this.chatHistory.length) return false;
      this.historyIndex++;
    }
    if (this.historyIndex === this.chatHistory.length) {
      rl.line = this.unfinished?.line ?? '';
      rl.cursor = this.unfinished?.cursor ?? 0;
    } else {
      rl.line = this.chatHistory[this.historyIndex];
      rl.cursor = rl.line.length;
    }
    rl._refreshLine?.();
    return true;
  }
  /** 只读当前编辑缓冲，用于空闲 Ctrl+C 清行，不访问秘密输入正文。 */
  getLine(): string {
    return this.pending?.secret ? '' : this.rl.line;
  }
  private interrupt(): void {
    if (this.pending) this.cancel();
    else this.interruptHandler?.();
  }
}
