import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { SessionManager } from '@kiturone/kapibala';
import {
  DEFAULT_LIMITS,
  type JsonValue,
  type PendingApproval,
  type WireRequest,
  negotiateProtocol,
} from '../protocol/index.js';
import { RpcPeer } from '../transport/rpc.js';
import type { LocalTransport } from '../transport/types.js';
import { describeApproval } from './approval-description.js';
import { RpcApprovalChannel } from './approval.js';
import { redactText, sanitizeDisplayText } from './redaction.js';
import { SessionRegistry } from './registry.js';
import { loadCredentialSecrets } from './resources.js';
import { SnapshotPager } from './snapshots.js';
import type { ResourceFactory } from './types.js';

/** socket 必须提供 token；stdio 依赖父进程管道，不能公开到网络。 */
export interface LocalHostOptions extends ResourceFactory {
  token?: string;
  homeDir?: string;
  onShutdown?(): void;
}

/** 相对工作区会隐式依赖宿主 cwd，直接按参数错误拒绝，避免身份漂移。 */
function requireAbsolute(value: string): void {
  if (!path.isAbsolute(value)) throw new Error('INVALID_PARAMS');
}

/** 双向服务入口；同一注册表服务多个连接，所有业务调用均先完成初始化。 */
export class LocalHostServer {
  readonly registry: SessionRegistry;
  private readonly peers = new Map<string, RpcPeer>();
  private readonly approvals = new Map<string, RpcApprovalChannel>();
  private stopping = false;
  private stopped = false;
  private stoppedNotified = false;
  private shutdownTask?: Promise<void>;

  constructor(private readonly options: LocalHostOptions) {
    this.registry = new SessionRegistry({
      create: options.create,
      approval: (entry) => {
        let channel = this.approvals.get(entry.sessionId);
        if (!channel) {
          channel = new RpcApprovalChannel({
            identity: () =>
              entry.controller && entry.active
                ? {
                    sessionId: entry.sessionId,
                    streamEpoch: entry.streamEpoch,
                    controlEpoch: entry.controller.epoch,
                    runId: entry.active.id,
                  }
                : undefined,
            describe: (request) => describeApproval(request, entry.resources.redact),
            closed: (approvalId) =>
              entry.feed.publish({
                type: 'approval_closed',
                payload: { approvalId },
                ...(entry.active ? { runId: entry.active.id } : {}),
              }),
            request: (prompt, signal) => {
              const peer = entry.controller && this.peers.get(entry.controller.clientId);
              if (!peer) throw new Error('CONTROL_REQUIRED');
              return peer.call('approval/request', prompt, signal);
            },
          });
          this.approvals.set(entry.sessionId, channel);
        }
        return channel;
      },
    });
  }

  /** 认证超时、慢连接或断线都撤销审批并等待该控制者运行清理。 */
  async accept(transport: LocalTransport): Promise<void> {
    if (this.stopping || this.peers.size >= DEFAULT_LIMITS.maxConnections) {
      await transport.close();
      return;
    }
    const clientId = randomUUID();
    let initialized = false;
    const subscriptions = new Map<string, () => void>();
    const pager = new SnapshotPager();

    const timer = setTimeout(() => {
      void peer.close();
    }, DEFAULT_LIMITS.initializationTimeoutMs);
    const handle = async (request: WireRequest): Promise<JsonValue> => {
      if (request.method === 'initialize') {
        if (initialized) throw new Error('UNAUTHORIZED');
        if (this.options.token !== undefined) {
          const actual = Buffer.from(request.params.token ?? '');
          const expected = Buffer.from(this.options.token);
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
            throw new Error('UNAUTHORIZED');
        }
        const protocol = negotiateProtocol(request.params);
        if (!protocol.ok) throw new Error('PROTOCOL_MISMATCH');
        initialized = true;
        clearTimeout(timer);
        return {
          ...protocol.value,
          serverInstanceId: this.registry.serverInstanceId,
          clientId,
          limits: { ...DEFAULT_LIMITS },
        };
      }
      if (!initialized) throw new Error('UNAUTHORIZED');
      if (this.stopping && request.method !== 'ping' && request.method !== 'host/shutdown')
        throw new Error('SHUTTING_DOWN');
      switch (request.method) {
        case 'ping':
          return { alive: true, serverInstanceId: this.registry.serverInstanceId };
        case 'session/create':
          requireAbsolute(request.params.workspaceRoot);
          return this.registry.open(request.params.workspaceRoot);
        case 'session/open':
          requireAbsolute(request.params.workspaceRoot);
          return this.registry.open(request.params.workspaceRoot, request.params.conversationId);
        case 'session/list': {
          requireAbsolute(request.params.workspaceRoot);
          const cursor = request.params.cursor;
          const page =
            cursor === undefined ? 1 : /^[1-9][0-9]*$/.test(cursor) ? Number(cursor) : Number.NaN;
          const limit = request.params.limit ?? 20;
          if (
            !Number.isSafeInteger(page) ||
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > 50
          )
            throw new Error('INVALID_PARAMS');
          const manager = new SessionManager({
            workspaceRoot: request.params.workspaceRoot,
            homeDirectory: this.options.homeDir,
          });
          const result = await manager.list(page, { pageSize: limit });
          // 标题源自首条用户消息，与历史/审批共用同一套凭据替换与单行化规则。
          const secrets = loadCredentialSecrets(request.params.workspaceRoot, this.options.homeDir);
          return {
            items: result.items.map((item) => ({
              conversationId: item.conversationId,
              title: sanitizeDisplayText(redactText(item.title, secrets), 200) ?? '',
            })),
            cursor: page < result.pages ? String(page + 1) : null,
          };
        }
        case 'session/attach': {
          if (
            request.params.serverInstanceId &&
            request.params.serverInstanceId !== this.registry.serverInstanceId
          )
            throw new Error('RESYNC_REQUIRED');
          const entry = this.registry.get(request.params.sessionId);
          if (entry.active && !entry.live?.complete) throw new Error('RESYNC_REQUIRED');
          // 先捕获唯一可能失败的快照，再授予控制权；任何失败都不能让会话被本次连接占住。
          const page = pager.capture(entry.sessionId, {
            history: entry.resources.history(),
            live: entry.active ? (entry.live?.events ?? []) : [],
          });
          const newlyGranted = request.params.mode === 'control' && !entry.controller;
          try {
            const snapshot = this.registry.attach(
              request.params.sessionId,
              clientId,
              request.params.mode,
              this.pendingApprovals(entry.sessionId),
            );
            subscriptions.get(entry.sessionId)?.();
            subscriptions.set(
              entry.sessionId,
              entry.feed.subscribe((event) => peer.notify(event)),
            );
            return { ...snapshot, ...page };
          } catch (error) {
            pager.forget(entry.sessionId);
            if (newlyGranted && entry.controller?.clientId === clientId)
              entry.controller = undefined;
            throw error;
          }
        }
        case 'session/snapshot': {
          if (!subscriptions.has(request.params.sessionId)) throw new Error('CONTROL_REQUIRED');
          if (request.params.cursor)
            return { ...pager.read(request.params.sessionId, request.params.cursor) };
          const entry = this.registry.get(request.params.sessionId);
          if (entry.active && !entry.live?.complete) throw new Error('RESYNC_REQUIRED');
          const page = pager.capture(entry.sessionId, {
            history: entry.resources.history(),
            live: entry.active ? (entry.live?.events ?? []) : [],
          });
          return {
            ...this.registry.snapshot(entry, clientId, this.pendingApprovals(entry.sessionId)),
            ...page,
          };
        }
        case 'session/detach': {
          subscriptions.get(request.params.sessionId)?.();
          subscriptions.delete(request.params.sessionId);
          pager.forget(request.params.sessionId);
          // detach 控制者不能保留无人观察的写任务。
          await this.registry.disconnect(clientId, request.params.sessionId);
          return { detached: true };
        }
        case 'session/close': {
          await this.registry.close(request.params, clientId);
          subscriptions.get(request.params.sessionId)?.();
          subscriptions.delete(request.params.sessionId);
          pager.forget(request.params.sessionId);
          this.approvals.get(request.params.sessionId)?.dispose();
          this.approvals.delete(request.params.sessionId);
          return { closed: true };
        }
        case 'run/start':
          return this.registry.start(
            request.params,
            clientId,
            request.params.clientOperationId,
            request.params.input,
          );
        case 'run/cancel':
          await this.registry.cancel(request.params, clientId, request.params.runId);
          return { cancellationRequested: true };
        case 'host/shutdown':
          await this.stopRegistry();
          return { stopped: true };
        default:
          throw new Error('UNAUTHORIZED');
      }
    };
    const peer = new RpcPeer(transport, {
      prefix: 's',
      request: handle,
      responded: (request) => {
        if (request.method === 'host/shutdown') this.notifyStopped();
      },
      closed: async () => {
        clearTimeout(timer);
        for (const unsubscribe of subscriptions.values()) unsubscribe();
        subscriptions.clear();
        this.peers.delete(clientId);
        await this.registry.disconnect(clientId);
        // 响应可能因对端断开而未送达；清理成功后仍要通知宿主退出。
        if (this.stopping) {
          await this.shutdownTask?.catch(() => {});
          this.notifyStopped();
        }
      },
    });
    this.peers.set(clientId, peer);
    await peer.done.catch(() => {});
  }

  /**
   * 首次调用创建可复用的清理任务；失败后清除任务，允许 host/shutdown 重试。
   * 成功后保持 stopping，除 ping/shutdown 外的业务请求继续返回 SHUTTING_DOWN。
   */
  private stopRegistry(): Promise<void> {
    this.stopping = true;
    this.shutdownTask ??= (async () => {
      for (const approval of this.approvals.values()) approval.dispose();
      await this.registry.shutdown();
      this.stopped = true;
    })().catch((error) => {
      this.shutdownTask = undefined;
      throw error;
    });
    return this.shutdownTask;
  }

  /** 审批通道按会话惰性创建；通道不存在即表示没有待审批。 */
  private pendingApprovals(sessionId: string): PendingApproval[] {
    return this.approvals.get(sessionId)?.pendingApprovals() ?? [];
  }

  /** 仅在资源清理成功后通知一次；响应未送达时由连接关闭路径补发。 */
  private notifyStopped(): void {
    if (!this.stopped || this.stoppedNotified) return;
    this.stoppedNotified = true;
    this.options.onShutdown?.();
  }

  /** 显式关闭全部连接与资源；单步失败不跳过其余清理，全部尝试后传播首个错误。 */
  async shutdown(): Promise<void> {
    this.stopping = true;
    const failures: unknown[] = [];
    try {
      await this.stopRegistry();
    } catch (error) {
      failures.push(error);
    }
    const results = await Promise.allSettled([...this.peers.values()].map((peer) => peer.close()));
    for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
    this.approvals.clear();
    if (failures.length) throw failures[0];
  }
}
