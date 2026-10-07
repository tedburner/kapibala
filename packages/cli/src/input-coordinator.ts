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
  private closed = false;
  private readonly signalHandler = () => this.interrupt();
  private readonly keyHandler = (_value: string, key: readline.Key) => {
    if (key?.name === 'escape' && this.pending) this.cancel();
  };

  constructor(options: CliInputOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.interactive =
      options.interactive ??
      Boolean((this.input as NodeJS.ReadStream).isTTY && (this.output as NodeJS.WriteStream).isTTY);
    const guardedOutput = new Writable({
      write: (chunk, _encoding, callback) => {
        if (!this.pending?.secret) this.output.write(chunk);
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
    });
    this.rl.pause();
    this.rl.on('line', (line) => {
      if (this.pending) this.pending.finish(line);
      else this.lineHandler?.(line);
    });
    let finish!: () => void;
    this.whenClosed = new Promise((resolve) => {
      finish = resolve;
    });
    this.rl.on('close', () => {
      this.closed = true;
      this.cancel();
      this.input.removeListener('keypress', this.keyHandler);
      process.off('SIGINT', this.signalHandler);
      finish();
    });
    this.rl.on('SIGINT', this.signalHandler);
    this.input.on('keypress', this.keyHandler);
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

  /** 使用同一 readline 问一个问题；取消、EOF、非 TTY 和同时读者均立即明确结束。 */
  async question(
    prompt: string,
    options?: { signal?: AbortSignal; secret?: boolean },
  ): Promise<string> {
    if (!this.interactive) throw new Error('交互输入不可用，请在 TTY 终端操作');
    if (this.closed) throw new Error('Input closed');
    if (this.pending) throw new Error('Input is busy / 输入已被占用');
    if (options?.signal?.aborted) throw new Error('Input cancelled');
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => finish(undefined, new Error('Input cancelled'));
      const finish = (value?: string, error?: Error) => {
        if (!this.pending || this.pending.finish !== finish) return;
        const secret = this.pending.secret;
        this.pending = undefined;
        options?.signal?.removeEventListener('abort', onAbort);
        (this.rl as unknown as { line: string }).line = '';
        (this.rl as unknown as { cursor: number }).cursor = 0;
        if (secret) this.output.write('\n');
        if (error) reject(error);
        else resolve(value ?? '');
      };
      this.pending = { finish, secret: options?.secret ?? false };
      options?.signal?.addEventListener('abort', onAbort, { once: true });
      this.output.write(prompt);
      this.rl.resume();
    });
  }

  /** 密钥输入不回显，也不转发为后续菜单、审批或聊天输入。 */
  readSecret(prompt: string): Promise<string> {
    return this.question(prompt, { secret: true });
  }

  /** 菜单在非 TTY 返回取消，不创建第二套 stdin/readline；Esc/Ctrl+C/EOF 只取消本菜单。 */
  async select<T>(config: SelectConfig<T>): Promise<T | null> {
    if (!this.interactive || !config.options.length) return null;
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

  /** 审批展示完整安全转义的参数与命令，输入由本协调器独占，非 TTY 明确拒绝。 */
  async approve(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalChoice> {
    if (!this.interactive) return 'deny_once';
    if (signal?.aborted) return 'cancel';
    const target = request.shell
      ? `解释器: ${escapeApprovalText(request.shell.executablePath ?? request.shell.interpreter)}\n工作目录: ${escapeApprovalText(request.shell.cwd)}\n完整命令: ${escapeApprovalText(request.shell.command)}`
      : `工具: ${escapeApprovalText(request.toolName)}\n参数: ${escapeApprovalText(JSON.stringify(request.input))}`;
    try {
      const answer = (
        await this.question(
          `\n${target}\n[1] 本次允许 ${request.sessionAllowed ? '[2] 本会话允许 ' : ''}[3] 拒绝 [4] 本会话拒绝\n选择: `,
          { signal },
        )
      ).trim();
      if (answer === '1') return 'allow_once';
      if (answer === '2' && request.sessionAllowed) return 'allow_session';
      if (answer === '4') return 'deny_session';
      return 'deny_once';
    } catch {
      return 'cancel';
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
  /** 空闲且交互时刷新提示符；忙碌期调用不打印、不打断当前问答。 */
  prompt(value: string): void {
    if (!this.closed && !this.pending && this.interactive) {
      this.rl.setPrompt(value);
      this.rl.prompt();
    }
  }
  clearLine(): void {
    (this.rl as unknown as { line: string }).line = '';
    (this.rl as unknown as { cursor: number }).cursor = 0;
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
