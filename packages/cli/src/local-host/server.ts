import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { SessionManager } from '@kiturone/kapibala';
import { ExternalSessionService } from '@kiturone/kapibala-host/internal';
import {
  DEFAULT_LIMITS,
  type JsonValue,
  type PendingApproval,
  type WireRequest,
  negotiateProtocol,
} from '@kiturone/kapibala-host/protocol';
import { RpcPeer } from '@kiturone/kapibala-host/transport';
import type { LocalTransport } from '@kiturone/kapibala-host/transport';
import { describeApproval } from './approval-description.js';
import { RpcApprovalChannel } from './approval.js';
import { LocalHostError } from './errors.js';
import {
  toExternalHarnessWire,
  toExternalProbeWire,
  toExternalSessionWire,
  toExternalSnapshotWire,
  toExternalTemplateWire,
} from './external-wire.js';
import { redactText, sanitizeDisplayText } from './redaction.js';
import { SessionRegistry } from './registry.js';
import { loadCredentialSecrets } from './resources.js';
import { SnapshotPager } from './snapshots.js';
import type { ResourceFactory } from './types.js';

/** socket 必须提供 token；stdio 依赖父进程管道，不能公开到网络。 */
export interface LocalHostOptions extends ResourceFactory {
  token?: string;
  homeDir?: string;
  external?: ExternalSessionService;
  onShutdown?(): void;
}

/** 相对工作区会隐式依赖宿主 cwd，直接按参数错误拒绝，避免身份漂移。 */
function requireAbsolute(value: string): void {
  if (!path.isAbsolute(value)) throw new Error('INVALID_PARAMS');
}

/** 双向服务入口；同一注册表服务多个连接，所有业务调用均先完成初始化。 */
export class LocalHostServer {
  readonly registry: SessionRegistry;
  readonly external: ExternalSessionService;
  private readonly peers = new Map<string, RpcPeer>();
  private readonly approvals = new Map<string, RpcApprovalChannel>();
  /** 外部会话单控制者登记（sessionId -> clientId），防止非控制连接抢答审批或越权关闭。 */
  private readonly externalControllers = new Map<string, string>();
  private stopping = false;
  private stopped = false;
  private stoppedNotified = false;
  private shutdownTask?: Promise<void>;

  constructor(private readonly options: LocalHostOptions) {
    this.external = options.external ?? new ExternalSessionService({ homeDir: options.homeDir });
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
    const negotiatedCapabilities = new Set<string>();
    const subscriptions = new Map<string, () => void>();
    const externalSubscriptions = new Map<string, () => void>();
    const pager = new SnapshotPager();
    const requireExternalCapability = (): void => {
      if (!negotiatedCapabilities.has('external-session')) {
        throw new Error('PROTOCOL_MISMATCH');
      }
    };

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
        for (const cap of protocol.value.capabilities) negotiatedCapabilities.add(cap);
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
        case 'watch/list': {
          // 与 session/snapshot 同门禁：先 attach 才允许读取该会话的观察面。
          if (!subscriptions.has(request.params.sessionId)) throw new Error('CONTROL_REQUIRED');
          const entry = this.registry.get(request.params.sessionId);
          return {
            items: (entry.resources.watches?.list() ?? []).map((item) => ({
              watchId: item.watchId,
              kind: item.kind,
              target: item.target,
              state: item.state,
              armedAt: item.armedAt,
              deadlineAt: item.deadlineAt,
              closedAt: item.closedAt ?? null,
              detail: item.detail ?? null,
            })),
          };
        }
        case 'watch/cancel': {
          const entry = this.registry.control(request.params.sessionId, clientId, request.params);
          const watches = entry.resources.watches;
          // 未布置触发源的宿主明确拒绝，避免客户端把空操作当成已取消。
          if (!watches) throw new LocalHostError('INVALID_REQUEST');
          await watches.cancel(request.params.watchId);
          return { cancelled: true };
        }
        case 'evidence/read': {
          // 与 watch/list 同门禁：先 attach 才允许读取该会话的观察面。
          if (!subscriptions.has(request.params.sessionId)) throw new Error('CONTROL_REQUIRED');
          const entry = this.registry.get(request.params.sessionId);
          if (!entry.resources.evidence) throw new LocalHostError('INVALID_REQUEST');
          // ViewEvidence 全部由 JSON 原生值组成；readonly 只是编译期约束，不改变 wire 形状。
          return (await entry.resources.evidence()) as unknown as JsonValue;
        }
        case 'external/harnesses': {
          requireExternalCapability();
          const { harnesses, templates } = this.external.listHarnesses();
          return {
            harnesses: harnesses.map(toExternalHarnessWire),
            templates: templates.map(toExternalTemplateWire),
          } as unknown as JsonValue;
        }
        case 'external/harnessSave': {
          requireExternalCapability();
          const p = request.params;
          const harnesses = p.builtin
            ? this.external.saveBuiltinOverride(p.id, {
                ...(p.command !== undefined ? { command: p.command } : {}),
                ...(p.args !== undefined ? { args: p.args } : {}),
                ...(p.envFrom !== undefined ? { envFrom: p.envFrom } : {}),
                ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
              })
            : this.external.saveCustomHarness({
                id: p.id,
                name: p.name ?? p.id,
                command: p.command ?? '',
                args: p.args ?? [],
                ...(p.registryId ? { registryId: p.registryId } : {}),
                ...(p.envFrom ? { envFrom: p.envFrom } : {}),
                enabled: p.enabled ?? true,
              });
          return {
            harnesses: harnesses.map(toExternalHarnessWire),
          } as unknown as JsonValue;
        }
        case 'external/harnessReset': {
          requireExternalCapability();
          return {
            harnesses: this.external
              .resetBuiltinOverride(request.params.id)
              .map(toExternalHarnessWire),
          } as unknown as JsonValue;
        }
        case 'external/harnessToggle': {
          requireExternalCapability();
          return {
            harnesses: this.external
              .toggleHarness(request.params.id, request.params.enabled)
              .map(toExternalHarnessWire),
          } as unknown as JsonValue;
        }
        case 'external/harnessDelete': {
          requireExternalCapability();
          return {
            harnesses: this.external
              .deleteCustomHarness(request.params.id)
              .map(toExternalHarnessWire),
          } as unknown as JsonValue;
        }
        case 'external/harnessTest': {
          requireExternalCapability();
          if (request.params.workspaceRoot !== undefined) {
            requireAbsolute(request.params.workspaceRoot);
          }
          const probe = await this.external.testHarness(
            request.params.id,
            request.params.workspaceRoot,
          );
          return toExternalProbeWire(probe) as unknown as JsonValue;
        }
        case 'external/list': {
          requireExternalCapability();
          requireAbsolute(request.params.workspaceRoot);
          return {
            items: this.external
              .listSessions(request.params.workspaceRoot)
              .map(toExternalSessionWire),
          } as unknown as JsonValue;
        }
        case 'external/open': {
          requireExternalCapability();
          requireAbsolute(request.params.workspaceRoot);
          const snap = await this.external.openSession(request.params);
          this.externalControllers.set(snap.session.id, clientId);
          return toExternalSnapshotWire(snap) as unknown as JsonValue;
        }
        case 'external/attach': {
          requireExternalCapability();
          const snap = this.external.getSnapshot(request.params.sessionId);
          const resolvedId = snap.session.id;
          if (!this.externalControllers.has(resolvedId)) {
            this.externalControllers.set(resolvedId, clientId);
          }
          externalSubscriptions.get(resolvedId)?.();
          externalSubscriptions.set(
            resolvedId,
            this.external.subscribeSession(resolvedId, (nextSnap) => {
              peer.notifyExternal({
                sessionId: resolvedId,
                sequence: nextSnap.sequence,
                snapshot: toExternalSnapshotWire(nextSnap),
              });
            }),
          );
          return toExternalSnapshotWire(snap) as unknown as JsonValue;
        }
        case 'external/detach': {
          requireExternalCapability();
          const resolvedId = this.external.resolveSessionId(request.params.sessionId);
          externalSubscriptions.get(resolvedId)?.();
          externalSubscriptions.delete(resolvedId);
          if (this.externalControllers.get(resolvedId) === clientId) {
            this.externalControllers.delete(resolvedId);
            await this.external.cancelSession(resolvedId).catch(() => {});
          }
          return { detached: true };
        }
        case 'external/snapshot': {
          requireExternalCapability();
          return toExternalSnapshotWire(
            this.external.getSnapshot(request.params.sessionId),
          ) as unknown as JsonValue;
        }
        case 'external/prompt': {
          requireExternalCapability();
          const resolvedId = this.attachOrVerifyExternalController(
            request.params.sessionId,
            clientId,
          );
          const snap = await this.external.promptSession({
            sessionId: resolvedId,
            text: request.params.text,
          });
          return toExternalSnapshotWire(snap) as unknown as JsonValue;
        }
        case 'external/approve': {
          requireExternalCapability();
          const resolvedId = this.attachOrVerifyExternalController(
            request.params.sessionId,
            clientId,
          );
          await this.external.approveSession({
            ...request.params,
            sessionId: resolvedId,
          });
          return { resolved: true };
        }
        case 'external/cancel': {
          requireExternalCapability();
          const resolvedId = this.external.resolveSessionId(request.params.sessionId);
          const owner = this.externalControllers.get(resolvedId);
          if (owner !== undefined && owner !== clientId) {
            throw new Error('CONTROL_REQUIRED');
          }
          await this.external.cancelSession(resolvedId);
          return { cancellationRequested: true };
        }
        case 'external/close': {
          requireExternalCapability();
          const resolvedId = this.attachOrVerifyExternalController(
            request.params.sessionId,
            clientId,
          );
          await this.external.closeSession(resolvedId);
          this.externalControllers.delete(resolvedId);
          return { closed: true };
        }
        case 'external/delete': {
          requireExternalCapability();
          const resolvedId = this.attachOrVerifyExternalController(
            request.params.sessionId,
            clientId,
          );
          externalSubscriptions.get(resolvedId)?.();
          externalSubscriptions.delete(resolvedId);
          const deleted = await this.external.deleteSession(resolvedId);
          this.externalControllers.delete(resolvedId);
          return { deleted };
        }
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
        for (const unsubscribe of externalSubscriptions.values()) unsubscribe();
        externalSubscriptions.clear();
        const ownedExternalIds: string[] = [];
        for (const [extId, ownerId] of this.externalControllers) {
          if (ownerId === clientId) {
            this.externalControllers.delete(extId);
            ownedExternalIds.push(extId);
          }
        }
        this.peers.delete(clientId);
        await Promise.all([
          this.registry.disconnect(clientId),
          ...ownedExternalIds.map((extId) => this.external.cancelSession(extId).catch(() => {})),
        ]);
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
   * 校验当前连接是否持有外部会话控制权（无活跃控制者时自动授予当前连接），
   * 杜绝非控制连接抢答审批或越权关闭他人正在运行的外部会话。
   */
  private attachOrVerifyExternalController(sessionIdOrPrefix: string, clientId: string): string {
    const resolvedId = this.external.resolveSessionId(sessionIdOrPrefix);
    const owner = this.externalControllers.get(resolvedId);
    if (owner !== undefined && owner !== clientId) {
      throw new Error('CONTROL_REQUIRED');
    }
    if (owner === undefined) {
      this.externalControllers.set(resolvedId, clientId);
    }
    return resolvedId;
  }

  /**
   * 首次调用创建可复用的清理任务；失败后清除任务，允许 host/shutdown 重试。
   * 成功后保持 stopping，除 ping/shutdown 外的业务请求继续返回 SHUTTING_DOWN。
   */
  private stopRegistry(): Promise<void> {
    this.stopping = true;
    this.shutdownTask ??= (async () => {
      for (const approval of this.approvals.values()) approval.dispose();
      await Promise.all([this.registry.shutdown(), this.external.dispose()]);
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
