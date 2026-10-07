import type {
  AgentSession,
  ManagedSession,
  SessionEvent,
  SessionManager,
} from '@kiturone/kapibala';

/** 句柄与已初始化会话的成对持有；两者同生共死，清理时一起销毁。 */
interface ActiveSession {
  handle: ManagedSession;
  session: AgentSession;
}
/** {@link ActiveSessionController} 的构造参数。 */
export interface ActiveSessionControllerOptions {
  manager: SessionManager;
  /** 只负责把句柄包装成 AgentSession（含工具注册与绑定装载），不调用 init；发布前由控制器统一执行。 */
  factory: (handle: ManagedSession) => Promise<AgentSession>;
  /** 初始活动会话；调用方需保证其已 init 完成。 */
  current: ActiveSession;
  onDiagnostic?: (message: string) => void;
  /** 会话发布成功后回调；此时旧会话可能尚未清理完成。 */
  onSwitched?: (event: Extract<SessionEvent, { type: 'session_switched' }>) => void;
}

/** CLI 的活动会话唯一所有者；先准备目标，发布后再回收旧资源，不回滚已关闭实例。 */
export class ActiveSessionController {
  private current: ActiveSession;
  private switching = false;
  private closing = false;
  private closed = false;
  private abortController?: AbortController;
  private pendingOperation?: Promise<void>;
  private pendingSwitch?: Promise<void>;
  /** 已被替换但尚未完成清理的旧会话；清理失败保留在此，供 close() 重试。 */
  private readonly retired = new Map<string, ActiveSession>();

  constructor(private readonly options: ActiveSessionControllerOptions) {
    this.current = options.current;
  }

  /** 每次动作开始读取当前引用，命令和渲染层不得缓存旧 Session。 */
  get session(): AgentSession {
    return this.current.session;
  }
  get handle(): ManagedSession {
    return this.current.handle;
  }
  get manager(): SessionManager {
    return this.options.manager;
  }
  /** 取消后的清理仍占用执行门，不因已发出 abort 而提前允许切换。 */
  isBusy(): boolean {
    return this.closing || this.switching || !!this.pendingOperation || this.session.isBusy();
  }

  /** 新建并切换，原文件保持可恢复；执行/摘要/清理期间拒绝开始。 */
  async newSession(): Promise<void> {
    await this.switchTo(() => this.manager.create());
  }

  /** 完整 ID 或唯一前缀恢复；目标加载失败保持当前实例和存储绑定。 */
  async resume(id: string): Promise<void> {
    await this.switchTo(() => this.manager.open(id));
  }

  /** 运行当前任务，同时拥有取消与退出等待句柄；不在切换期间缓存旧实例。 */
  async *run(prompt: string, options?: { signal?: AbortSignal }): AsyncGenerator<SessionEvent> {
    yield* this.execute((signal) => this.session.run(prompt, { signal }), options?.signal);
  }

  /** 手动摘要使用同一 busy、取消和退出等待规则，不生成用户消息。 */
  async *compact(options?: { signal?: AbortSignal }): AsyncGenerator<SessionEvent> {
    yield* this.execute((signal) => this.session.compact({ signal }), options?.signal);
  }

  /** 只发出取消信号，直到运行 finally 完成仍保持 busy。 */
  abort(): void {
    this.abortController?.abort();
  }

  /** 中止并等候在途操作及旧清理，然后才释放所有写锁；失败资源保持受管供重试。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    this.abort();
    await this.pendingOperation;
    await this.pendingSwitch;
    const failures: unknown[] = [];
    for (const entry of [this.current, ...this.retired.values()]) {
      try {
        await this.cleanup(entry);
        this.retired.delete(entry.handle.conversationId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Session cleanup failed; writer locks are retained');
    this.closed = true;
  }

  /** 目标准备与发布串行，目标清理失败和旧 teardown 失败均保留句柄而非释放未知资源。 */
  private async switchTo(open: () => Promise<ManagedSession>): Promise<void> {
    this.assertIdle();
    this.switching = true;
    let finish!: () => void;
    this.pendingSwitch = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let target: ManagedSession | undefined;
    let prepared: AgentSession | undefined;
    let published = false;
    try {
      target = await open();
      if (target.conversationId === this.handle.conversationId) return;
      if (this.retired.has(target.conversationId))
        throw new Error('Previous session cleanup is incomplete');
      prepared = await this.options.factory(target);
      await prepared.init();
      const previous = this.current;
      this.current = { handle: target, session: prepared };
      published = true;
      this.retired.set(previous.handle.conversationId, previous);
      try {
        this.options.onSwitched?.({
          type: 'session_switched',
          conversationId: target.conversationId,
          previousConversationId: previous.handle.conversationId,
        });
      } catch {
        this.report('Session switched; host notification failed');
      }
      try {
        await this.cleanup(previous);
        this.retired.delete(previous.handle.conversationId);
      } catch {
        this.report(
          'Previous session cleanup failed; active target is retained and old writer lock remains managed',
        );
      }
    } catch (error) {
      if (
        !published &&
        target &&
        target.conversationId !== this.handle.conversationId &&
        !this.retired.has(target.conversationId)
      ) {
        if (prepared) {
          const entry = { handle: target, session: prepared };
          try {
            await this.cleanup(entry);
          } catch {
            this.retired.set(target.conversationId, entry);
          }
        } else await target.release();
      }
      throw error;
    } finally {
      this.switching = false;
      this.pendingSwitch = undefined;
      finish();
    }
  }

  /** 操作结束（含消费者提前 return）后等待 Session 清理，再发布空闲状态。 */
  private async *execute(
    operation: (signal: AbortSignal) => AsyncIterable<SessionEvent>,
    signal?: AbortSignal,
  ): AsyncGenerator<SessionEvent> {
    this.assertIdle();
    const controller = new AbortController();
    this.abortController = controller;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    let finish!: () => void;
    this.pendingOperation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      yield* operation(controller.signal);
    } finally {
      controller.abort();
      signal?.removeEventListener('abort', abort);
      this.abortController = undefined;
      this.pendingOperation = undefined;
      finish();
    }
  }

  private assertIdle(): void {
    if (this.isBusy()) throw new Error('Session is busy; wait for execution and cleanup to finish');
  }
  private async cleanup(entry: ActiveSession): Promise<void> {
    await entry.session.destroy();
    await entry.handle.release();
  }
  private report(message: string): void {
    try {
      this.options.onDiagnostic?.(message);
    } catch {
      /* 诊断不改变发布状态。 */
    }
  }
}
