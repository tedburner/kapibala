import { type PresentationState, reducePresentation } from '@kiturone/kapibala-host/view-model';
import type {
  Approval,
  DesktopAPI,
  InteractionRequest,
  Notification,
  RunReceipt,
} from '../shared/contracts.js';
import type { Inspection, RuntimeSnapshot } from '../shared/observations.js';
import { SnapshotAssembler } from '../shared/snapshots.js';

type Scope = { workspaceId: string; sessionId: string; subscriptionId: string };
/** 外部事实快照只由 Host 通知更新，React 订阅它，不在 Zustand 复制会话状态。 */
export interface ClientFacts {
  state?: PresentationState;
  valid: boolean;
  runs: Readonly<Record<string, RunReceipt>>;
  approvals: readonly Approval[];
  interactions: readonly InteractionRequest[];
  error?: string;
  runtime?: RuntimeSnapshot;
  runtimeValid?: boolean;
  inspection?: Inspection;
}
/** Renderer 展示安装器；暂存块不污染当前状态，真正缺口冻结发送，不重试 run.start。 */
export class ViewClient {
  private facts: ClientFacts = { valid: false, runs: {}, approvals: [], interactions: [] };
  private scope?: Scope;
  private runtimeSubscription?: string;
  private inspectionHalted = false;
  private installation = 0;
  private halted = false;
  /** 已请求审批的上下文（会话与工具名）；关闭事件只带 approvalId，凭它回查以生成可读诊断。 */
  private readonly approvalContexts = new Map<string, { sessionId: string; toolName: string }>();
  private readonly listeners = new Set<() => void>();
  private readonly assembler = new SnapshotAssembler();
  private readonly unsubscribe: () => void;
  constructor(private readonly api: DesktopAPI) {
    this.unsubscribe = api.onEvent((event) => this.receive(event));
  }
  /** 稳定对象用于 useSyncExternalStore，只有事实变化才替换引用。 */
  snapshot = (): ClientFacts => this.facts;
  /** 组件卸载只停止观察，不取消运行；应用所有者负责最终关闭。 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** 每次切换使用新的订阅身份，迟到块和旧退订不能污染新视图。 */
  async select(scope: { workspaceId: string; sessionId: string }): Promise<void> {
    const previous = this.scope;
    this.installation++;
    this.halted = false;
    const next: Scope = {
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      subscriptionId: crypto.randomUUID(),
    };
    this.scope = next;
    this.inspectionHalted = false;
    this.assembler.reset();
    this.update({
      ...this.facts,
      state: undefined,
      valid: false,
      inspection: undefined,
      error: undefined,
    });
    if (previous) await this.api.presentation.unsubscribe(previous).catch(() => {});
    if (this.scope === next) {
      await this.api.presentation.subscribe(next);
      try {
        const snapshot = await this.api.session.inspect(next);
        if (
          this.scope === next &&
          !this.inspectionHalted &&
          (!this.facts.inspection || snapshot.revision > this.facts.inspection.revision)
        )
          this.update({ ...this.facts, inspection: snapshot });
      } catch {
        /* 观察失败保留正文与独立状态入口。 */
      }
    }
  }
  /** 空间切换只停止观察旧会话；工具仍由 Host 管理，不把旧正文带入新空间。 */
  async clear(): Promise<void> {
    const previous = this.scope;
    this.scope = undefined;
    this.installation++;
    this.assembler.reset();
    this.update({
      ...this.facts,
      state: undefined,
      valid: false,
      inspection: undefined,
      error: undefined,
    });
    if (previous) await this.api.presentation.unsubscribe(previous).catch(() => {});
  }
  /** 显式重同步只更换展示订阅，不创建新的运行操作。 */
  async resync(): Promise<void> {
    if (this.scope) await this.select(this.scope);
  }
  /** 发送只尝试一次；应答不明时冻结发送，必须先查询事实并重同步。 */
  async start(scope: { workspaceId: string; sessionId: string }, input: string): Promise<void> {
    try {
      await this.api.run.start({ ...scope, operationId: crypto.randomUUID(), input });
    } catch (error) {
      this.halted = true;
      this.installation++;
      this.update({
        ...this.facts,
        valid: false,
        error: '发送结果尚未确认，请查询运行状态并重新同步；不会自动重发。',
      });
      throw error;
    }
  }
  /** 等待当前视图完成快照安装确认；超时或视图已失效抛错，调用方不得自动重发任务。 */
  async whenReady(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.facts.valid) {
      if (!this.scope || this.halted || Date.now() > deadline)
        throw new Error('PRESENTATION_STALE');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  /** 独立小型状态查询不依赖正文是否可安装，不创建任何模型请求。 */
  async refreshRun(scope: { workspaceId: string; sessionId: string }): Promise<void> {
    const receipt = await this.api.run.status(scope);
    if (receipt)
      this.update({ ...this.facts, runs: { ...this.facts.runs, [receipt.sessionId]: receipt } });
  }
  /** 全应用仅一份后台摘要，不随详细消息列表切换；旧初始回复不能覆盖较新通知。 */
  async connectRuntime(): Promise<void> {
    const previous = this.runtimeSubscription;
    const subscriptionId = crypto.randomUUID();
    this.runtimeSubscription = subscriptionId;
    this.update({ ...this.facts, runtime: undefined, runtimeValid: false });
    if (previous) await this.api.session.runtimeUnsubscribe(previous).catch(() => {});
    if (this.runtimeSubscription !== subscriptionId) return;
    const snapshot = await this.api.session.runtimeSubscribe(subscriptionId);
    if (this.runtimeSubscription === subscriptionId) this.installRuntime(snapshot);
  }
  private installRuntime(snapshot: RuntimeSnapshot): void {
    if (this.facts.runtime && snapshot.revision <= this.facts.runtime.revision) return;
    const ids = new Set(snapshot.items.map((item) => item.sessionId));
    this.update({
      ...this.facts,
      runtime: snapshot,
      runtimeValid: true,
      runs: Object.fromEntries(Object.entries(this.facts.runs).filter(([id]) => ids.has(id))),
    });
  }
  /** 页面退出释放通知回调；不会把关闭详情当作 Session 销毁。 */
  close(): void {
    this.unsubscribe();
    if (this.runtimeSubscription)
      void this.api.session.runtimeUnsubscribe(this.runtimeSubscription).catch(() => {});
    this.listeners.clear();
    this.assembler.reset();
  }
  private async receive(event: Notification): Promise<void> {
    if (event.type === 'session.runtimeChanged') {
      if (event.subscriptionId === this.runtimeSubscription) this.installRuntime(event.snapshot);
      return;
    }
    if (event.type === 'session.runtimeInvalidated') {
      if (event.subscriptionId === this.runtimeSubscription) {
        this.runtimeSubscription = undefined;
        this.update({ ...this.facts, runtime: undefined, runtimeValid: false });
      }
      return;
    }
    if (event.type === 'theme.changed') {
      document.documentElement.dataset.mode = event.mode;
      return;
    }
    if (event.type === 'host.unavailable') {
      this.runtimeSubscription = undefined;
      this.inspectionHalted = true;
      this.installation++;
      this.halted = true;
      this.assembler.reset();
      this.update({
        ...this.facts,
        valid: false,
        error: event.error.message,
        approvals: [],
        interactions: [],
        runtime: undefined,
        runtimeValid: false,
        inspection: undefined,
      });
      return;
    }
    if (event.type === 'run.changed') {
      this.update({
        ...this.facts,
        runs: { ...this.facts.runs, [event.receipt.sessionId]: event.receipt },
      });
      return;
    }
    if (event.type === 'approval.requested') {
      this.approvalContexts.set(event.approvalId, {
        sessionId: event.sessionId,
        toolName: event.toolName,
      });
      this.update({
        ...this.facts,
        approvals: [
          ...this.facts.approvals.filter((item) => item.approvalId !== event.approvalId),
          event,
        ],
      });
      return;
    }
    if (event.type === 'interaction.requested') {
      // 命令交互请求不进订阅范围过滤：对话框按 requestId 全局路由，应答带会话归属校验。
      this.update({
        ...this.facts,
        interactions: [
          ...this.facts.interactions.filter((item) => item.requestId !== event.requestId),
          event,
        ],
      });
      return;
    }
    if (event.type === 'interaction.closed') {
      this.update({
        ...this.facts,
        interactions: this.facts.interactions.filter((item) => item.requestId !== event.requestId),
      });
      return;
    }
    if (event.type === 'approval.closed') {
      const context = this.approvalContexts.get(event.approvalId);
      this.approvalContexts.delete(event.approvalId);
      // 超时自动拒绝必须显式解释：这是「声称等待用户操作却无审批入口」死锁的唯一可见出口，
      // 不提示的话用户只会看到 PERMISSION_DENIED 和英文错误，无法自救。
      const timeoutDenied = event.reason === 'timeout' && context !== undefined;
      this.update({
        ...this.facts,
        approvals: this.facts.approvals.filter((item) => item.approvalId !== event.approvalId),
        ...(timeoutDenied && context
          ? {
              error: `审批请求超时未被处理，「${context.toolName}」已自动按拒绝收尾。重新发起任务后请在自动弹出的审批卡片中及时确认。`,
            }
          : {}),
      });
      return;
    }
    const scope = this.scope;
    if (
      !scope ||
      event.workspaceId !== scope.workspaceId ||
      event.sessionId !== scope.sessionId ||
      event.subscriptionId !== scope.subscriptionId
    )
      return;
    if (event.type === 'session.inspectionChanged') {
      if (this.inspectionHalted) return;
      if (!this.facts.inspection || event.snapshot.revision > this.facts.inspection.revision)
        this.update({ ...this.facts, inspection: event.snapshot });
      return;
    }
    if (event.type === 'session.inspectionInvalidated') {
      this.inspectionHalted = true;
      this.update({ ...this.facts, inspection: undefined });
      return;
    }
    if (event.type === 'presentation.invalidated') {
      this.installation++;
      this.halted = true;
      this.assembler.reset();
      this.update({
        ...this.facts,
        valid: false,
        error:
          event.reason === 'SNAPSHOT_TOO_LARGE'
            ? '展示快照超过预算，已禁用发送。可停止运行或处理历史后重新打开。'
            : '展示已失效，请重新同步后发送。',
      });
      return;
    }
    if (this.halted) return;
    let installation = this.installation;
    try {
      if (event.type === 'presentation.chunk') {
        const state = this.assembler.accept(event);
        if (!state) return;
        installation = ++this.installation;
        this.update({ ...this.facts, state, valid: false, error: undefined });
        await this.api.presentation.installed({
          ...scope,
          snapshotId: event.snapshotId,
          sequence: state.sequence,
        });
        if (this.scope === scope && this.installation === installation)
          this.update({ ...this.facts, valid: true });
      } else if (event.type === 'presentation.event') {
        // Host 只在安装确认后才发出增量，其中包含先于确认应答重放的缓冲事件；它们与快照序号
        // 连续，必须照常入列——若在确认在途期间丢弃，后续事件必然断档，视图将冻结且无法恢复。
        // valid 只继续门控发送（whenReady / run.start），不再门控增量入列。
        const state = this.facts.state;
        if (!state || event.event.sequence !== state.sequence + 1)
          throw new Error('Presentation sequence gap');
        const next = reducePresentation(state, event.event);
        if (next === state) throw new Error('Rejected presentation event');
        this.update({ ...this.facts, state: next });
      }
    } catch {
      // 异步安装确认的失败只属于发起它的视图，不能冻结已切换或重新安装的新视图。
      if (this.scope !== scope || this.installation !== installation) return;
      this.halted = true;
      this.installation++;
      this.assembler.reset();
      this.update({
        ...this.facts,
        valid: false,
        error: '展示校验未通过，请重新同步；不会自动重发任务。',
      });
    }
  }
  private update(facts: ClientFacts): void {
    this.facts = facts;
    for (const listener of this.listeners) listener();
  }
}
