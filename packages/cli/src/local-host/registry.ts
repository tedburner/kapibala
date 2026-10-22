import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ApprovalChannel } from '@kiturone/kapibala';
import { detectProjectRoot } from '../project-root.js';
import {
  DEFAULT_LIMITS,
  type JsonValue,
  type PendingApproval,
  type SessionControl,
  type SnapshotMetadata,
} from '../protocol/index.js';
import { LocalHostError } from './errors.js';
import { SessionEventFeed } from './events.js';
import { redactText, sanitizeDisplayText } from './redaction.js';
import { previewToolResult, summarizeToolTarget } from './tool-projection.js';
import type { ResourceFactory, SessionResources } from './types.js';

/** Windows 路径比较不区分大小写；标准化只用于身份判断，资源仍持有真实大小写。 */
function identityPath(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** 活动运行在迭代结束和 Core 清理后才能清除；取消信号不等于完成。 */
interface ActiveRun {
  id: string;
  abort: AbortController;
  done: Promise<void>;
}

/** 注册表持有的唯一句柄；业务消费者不得直接修改控制者或活动任务。 */
export interface RegisteredSession {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly streamEpoch: string;
  readonly resources: SessionResources;
  readonly feed: SessionEventFeed;
  controller?: { clientId: string; epoch: string };
  active?: ActiveRun;
  closing?: boolean;
  /** 共享在途 dispose；失败后清除，允许同一句柄重试尚未完成的释放步骤。 */
  disposal?: Promise<void>;
  /** Core 仍忙时保留可重试围栏：拒绝新运行，但 close/disconnect/shutdown 必须继续可用。 */
  needsCleanup?: boolean;
  live?: { events: JsonValue[]; bytes: number; complete: boolean };
  operations: Map<string, { inputHash: string; runId: string }>;
}

/** 宿主扩展审批路由，不持久化客户端身份或旧批准。 */
export interface RegistryOptions extends ResourceFactory {
  approval?(entry: RegisteredSession): ApprovalChannel;
}

/**
 * 同宿主单会话单控制者/单运行注册表；打开操作串行，避免并行申请越过容量和存储锁。
 * 会话存储锁不等于跨进程工作区锁，不保证独立 CLI 的其他 conversation 写互斥。
 */
export class SessionRegistry {
  readonly serverInstanceId = randomUUID();
  private readonly sessions = new Map<string, RegisteredSession>();
  private opening: Promise<unknown> = Promise.resolve();
  private shuttingDown = false;

  constructor(private readonly options: RegistryOptions) {}

  /** 按资源工厂使用的真实项目根归组；同一工作树子目录重复打开 conversation 复用句柄。 */
  async open(
    workspaceRoot: string,
    conversationId?: string,
  ): Promise<{ sessionId: string; conversationId: string }> {
    if (!path.isAbsolute(workspaceRoot)) throw new Error('WORKSPACE_ROOT_REQUIRED');
    const root = detectProjectRoot(workspaceRoot);
    const identity = identityPath(root);
    const operation = this.opening
      .catch(() => {})
      .then(async () => {
        if (this.shuttingDown) throw new Error('SHUTTING_DOWN');
        const existing = [...this.sessions.values()].find(
          (entry) =>
            !entry.closing &&
            identityPath(entry.workspaceRoot) === identity &&
            entry.resources.conversationId === conversationId,
        );
        if (existing)
          return {
            sessionId: existing.sessionId,
            conversationId: existing.resources.conversationId,
          };
        if (this.sessions.size >= DEFAULT_LIMITS.maxOpenSessions) throw new Error('RESOURCE_LIMIT');
        const holder: { entry?: RegisteredSession } = {};
        const approval: ApprovalChannel = {
          requestApproval: (request, signal) =>
            holder.entry && this.options.approval
              ? this.options.approval(holder.entry).requestApproval(request, signal)
              : Promise.resolve('cancel'),
        };
        const resources = await this.options.create(root, conversationId, approval);
        const sessionId = randomUUID();
        const streamEpoch = randomUUID();
        const entry: RegisteredSession = {
          sessionId,
          streamEpoch,
          workspaceRoot: root,
          resources,
          operations: new Map(),
          feed: new SessionEventFeed(this.serverInstanceId, sessionId, streamEpoch),
        };
        holder.entry = entry;
        this.sessions.set(sessionId, entry);
        return { sessionId, conversationId: resources.conversationId };
      });
    this.opening = operation;
    return operation;
  }

  /** 只接受本宿主会话 ID，不将 conversation ID 当作已授权控制身份。 */
  get(sessionId: string): RegisteredSession {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error('SESSION_NOT_FOUND');
    return entry;
  }

  /** attach 与水位读取同步完成；订阅接线由服务端在相同同步段完成。 */
  attach(
    sessionId: string,
    clientId: string,
    mode: 'control' | 'observe',
    pendingApprovals: PendingApproval[] = [],
  ): SnapshotMetadata {
    const entry = this.get(sessionId);
    if (entry.closing || this.shuttingDown) throw new Error('SHUTTING_DOWN');
    if (mode === 'control') {
      if (entry.controller && entry.controller.clientId !== clientId)
        throw new Error('SESSION_BUSY');
      entry.controller ??= { clientId, epoch: randomUUID() };
    }
    return this.snapshot(entry, clientId, pendingApprovals);
  }

  /** 控制身份包含实际连接，不把仅知晓 epoch 的观察者当作控制者。 */
  control(sessionId: string, clientId: string, control: SessionControl): RegisteredSession {
    const entry = this.get(sessionId);
    if (!entry.controller || entry.controller.clientId !== clientId)
      throw new Error('CONTROL_REQUIRED');
    if (
      entry.closing ||
      entry.streamEpoch !== control.streamEpoch ||
      entry.controller.epoch !== control.controlEpoch
    )
      throw new Error('STALE_CONTROL');
    return entry;
  }

  /** 只暴露元数据与待审批；历史仍由调用方在申请控制权前捕获，避免重复编码。 */
  snapshot(
    entry: RegisteredSession,
    clientId: string,
    pendingApprovals: PendingApproval[] = [],
  ): SnapshotMetadata {
    return {
      sessionId: entry.sessionId,
      streamEpoch: entry.streamEpoch,
      controlEpoch: entry.controller?.clientId === clientId ? entry.controller.epoch : '',
      serverInstanceId: this.serverInstanceId,
      seq: entry.feed.highWaterMark,
      conversationId: entry.resources.conversationId,
      runId: entry.active?.id ?? null,
      pendingApprovals: pendingApprovals.map((approval) => ({ ...approval })),
      openSessions: this.sessions.size,
      maxOpenSessions: DEFAULT_LIMITS.maxOpenSessions,
    };
  }

  /** 在开始任何模型工作前保留幂等结果；不淘汰操作 ID，满后拒绝新的写任务。 */
  start(
    control: SessionControl,
    clientId: string,
    clientOperationId: string,
    input: string,
  ): { runId: string; accepted: true } {
    const entry = this.control(control.sessionId, clientId, control);
    if (this.shuttingDown) throw new Error('SHUTTING_DOWN');
    const inputHash = createHash('sha256').update(input).digest('hex');
    const prior = entry.operations.get(clientOperationId);
    if (prior) {
      if (prior.inputHash !== inputHash) throw new Error('OPERATION_CONFLICT');
      return { runId: prior.runId, accepted: true };
    }
    if (entry.active || entry.needsCleanup) throw new Error('SESSION_BUSY');
    if (
      entry.operations.size >= DEFAULT_LIMITS.maxOperationIds ||
      [...this.sessions.values()].filter((item) => item.active).length >=
        DEFAULT_LIMITS.maxConcurrentRuns
    )
      throw new Error('RESOURCE_LIMIT');
    const runId = randomUUID();
    const abort = new AbortController();
    entry.operations.set(clientOperationId, { inputHash, runId });
    const active: ActiveRun = { id: runId, abort, done: Promise.resolve() };
    entry.active = active;
    const live = { events: [] as JsonValue[], bytes: 0, complete: true };
    entry.live = live;
    const remember = entry.feed.subscribe((event) => {
      const encoded = JSON.stringify(event);
      const bytes = Buffer.byteLength(encoded);
      if (live.bytes + bytes > DEFAULT_LIMITS.maxSnapshotBytes) {
        live.complete = false;
        abort.abort();
        return;
      }
      if (live.complete) {
        live.events.push(JSON.parse(encoded));
        live.bytes += bytes;
      }
    });
    active.done = Promise.resolve().then(async () => {
      // 缺失终态事件不能默认为成功；仅在 run_finish 明确报告时采用其状态。
      let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';
      let terminal = false;
      let reportedError = false;
      try {
        entry.feed.publish({ type: 'run_started', payload: { clientOperationId }, runId });
        for await (const event of entry.resources.run(input, abort.signal)) {
          if (event.type === 'text_delta' || event.type === 'thinking_delta') {
            const text = event.type === 'text_delta' ? event.text : event.thinking;
            for (let offset = 0; offset < text.length; offset += 16_384)
              entry.feed.publish({
                type: event.type,
                payload: { text: text.slice(offset, offset + 16_384) },
                runId,
              });
          } else if (event.type === 'tool_start') {
            entry.feed.publish({
              type: 'tool_start',
              runId,
              payload: {
                toolId: event.id,
                toolName: event.name,
                target: summarizeToolTarget(event.name, event.input, entry.resources.redact),
              },
            });
          } else if (event.type === 'tool_progress') {
            entry.feed.publish({
              type: 'tool_progress',
              runId,
              payload: {
                toolId: event.id,
                toolName: event.name,
                elapsedMs: event.elapsedMs,
                outputBytes: event.outputBytes,
              },
            });
          } else if (event.type === 'tool_finish') {
            const preview = previewToolResult(event.result, entry.resources.redact);
            entry.feed.publish({
              type: 'tool_finish',
              runId,
              payload: {
                toolId: event.id,
                result: preview.result,
                isError: event.isError,
                truncated: preview.truncated,
              },
            });
          } else if (event.type === 'error') {
            reportedError = true;
            // 取消引发的 AbortError 已由终态表达，不再额外制造错误提示。
            if (!abort.signal.aborted) {
              const raw =
                event.modelError?.message ??
                (event.error instanceof Error ? event.error.message : '运行失败');
              const message = entry.resources.redact
                ? entry.resources.redact(raw)
                : redactText(raw, []);
              entry.feed.publish({
                type: 'diagnostic',
                runId,
                payload: {
                  code: event.modelError?.code || 'RUN_ERROR',
                  message: sanitizeDisplayText(message, 2_000) ?? '运行失败',
                },
              });
            }
          } else if (event.type === 'run_finish') {
            terminal = true;
            outcome = event.metrics.status === 'aborted' ? 'cancelled' : event.metrics.status;
          }
        }
      } catch {
        reportedError = true;
      }
      if (!terminal) {
        outcome = abort.signal.aborted && !reportedError ? 'cancelled' : 'failed';
        entry.feed.publish({
          type: 'diagnostic',
          runId,
          payload: { code: 'RUN_INCOMPLETE', message: '运行结束但未收到终态事件' },
        });
      }
      // run() 迭代完全结束后 Core 已有机会执行 finally；无论清理是否成功都必须清除活动围栏。
      let cleanupFailed = false;
      try {
        cleanupFailed = Boolean(entry.resources.isBusy?.());
      } catch {
        cleanupFailed = true;
      }
      entry.active = undefined;
      cleanupFailed ||= Boolean(entry.needsCleanup);
      entry.needsCleanup = cleanupFailed;
      if (cleanupFailed) {
        outcome = 'failed';
        entry.feed.publish({
          type: 'diagnostic',
          runId,
          payload: { code: 'SESSION_CLEANUP_FAILED', message: '会话仍在清理，可重试关闭' },
        });
      }
      entry.feed.publish({ type: 'run_settled', payload: { outcome }, runId });
    });
    active.done = active.done.finally(remember);
    // 持有并观察运行 Promise，防止宿主订阅/投影故障形成 unhandledRejection。
    void active.done.catch(() => {});
    return { runId, accepted: true };
  }

  /**
   * 仅当前 active.id 的取消可重复受理；已结束、未知或属于旧运行的 ID 均拒绝。
   * 控制权和代际先校验，取消失败不能解除清理围栏，也不能误取消后续运行。
   */
  async cancel(control: SessionControl, clientId: string, runId: string): Promise<void> {
    const entry = this.control(control.sessionId, clientId, control);
    if (entry.active?.id !== runId) throw new LocalHostError('RUN_NOT_FOUND');
    entry.active.abort.abort();
    try {
      await entry.resources.cancelChildren?.();
    } catch (error) {
      entry.needsCleanup = true;
      throw new LocalHostError('SESSION_CLEANUP_FAILED', error);
    }
  }

  /** 连接失效后先取消并等待在途清理，再撤销控制身份；清理错误不阻止释放控制权。 */
  async disconnect(clientId: string, sessionId?: string): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.values()]
        .filter(
          (entry) =>
            entry.controller?.clientId === clientId &&
            (!sessionId || entry.sessionId === sessionId),
        )
        .map(async (entry) => {
          entry.active?.abort.abort();
          try {
            await entry.resources.cancelChildren?.();
          } catch {
            entry.needsCleanup = true;
          } finally {
            await entry.active?.done.catch(() => {});
            entry.controller = undefined;
          }
        }),
    );
  }

  /** 只允许 idle 控制者关闭；销毁失败保留句柄供诊断或重试，且不阻塞控制面。 */
  async close(control: SessionControl, clientId: string): Promise<void> {
    const entry = this.control(control.sessionId, clientId, control);
    if (entry.active) throw new Error('SESSION_BUSY');
    entry.closing = true;
    try {
      await this.disposeEntry(entry);
      this.sessions.delete(entry.sessionId);
    } catch (error) {
      entry.closing = false;
      throw error;
    }
  }

  /** 关闭期间拒绝新工作；单会话释放失败不跳过其它会话，全部尝试后统一上报首个错误。 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.opening.catch(() => {});
    const entries = [...this.sessions.values()];
    for (const entry of entries) entry.active?.abort.abort();
    await Promise.allSettled(entries.map((entry) => entry.active?.done));
    const failures: unknown[] = [];
    for (const entry of entries) {
      entry.closing = true;
      try {
        await this.disposeEntry(entry);
        this.sessions.delete(entry.sessionId);
      } catch (error) {
        // 保留在表中并维持 closing，后续 host/shutdown 可重试尚未完成的释放步骤。
        failures.push(error);
      }
    }
    if (failures.length) throw failures[0];
  }

  /** 每个句柄共享同一在途 dispose；失败后允许重试，成功则永久复用结果。 */
  private disposeEntry(entry: RegisteredSession): Promise<void> {
    entry.disposal ??= entry.resources.dispose().catch((error) => {
      entry.disposal = undefined;
      throw error;
    });
    return entry.disposal;
  }
}
