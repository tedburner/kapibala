import { randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CrossProjectSessionCatalog,
  SessionManager,
  SessionReferenceReader,
  computeProjectKey,
  isSamePath,
} from '@kiturone/kapibala';
import {
  CheckpointService,
  ExecutionRootCoordinator,
  ExternalSessionService,
  WorktreeError,
  WorktreeService,
  detectProjectRoot,
  isProjectTrusted,
  loadSettings,
} from '@kiturone/kapibala-host/internal';
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
  checkpoints?: CheckpointService;
  worktrees?: WorktreeService;
  onShutdown?(): void;
}

/** 相对工作区会隐式依赖宿主 cwd，直接按参数错误拒绝，避免身份漂移。 */
function requireAbsolute(value: string): void {
  if (!path.isAbsolute(value)) throw new Error('INVALID_PARAMS');
}

/** 判定客户端是否声明了任一 v0.1.6 协议能力（用于对 v0.1.4/v0.1.5 客户端隐藏新增结构属性）。 */
function hasV016Capability(caps: ReadonlySet<string>): boolean {
  return (
    caps.has('references') || caps.has('retry') || caps.has('worktree') || caps.has('checkpoint')
  );
}

/** 双向服务入口；同一注册表服务多个连接，所有业务调用均先完成初始化。 */
export class LocalHostServer {
  readonly registry: SessionRegistry;
  readonly external: ExternalSessionService;
  readonly checkpoints: CheckpointService;
  readonly worktrees: WorktreeService;
  private readonly peers = new Map<string, RpcPeer>();
  private readonly peerCapabilities = new Map<string, ReadonlySet<string>>();
  private readonly approvals = new Map<string, RpcApprovalChannel>();
  /** 外部会话单控制者登记（sessionId -> clientId），防止非控制连接抢答审批或越权关闭。 */
  private readonly externalControllers = new Map<string, string>();
  private stopping = false;
  private stopped = false;
  private stoppedNotified = false;
  private shutdownTask?: Promise<void>;

  constructor(private readonly options: LocalHostOptions) {
    const coordinator = options.worktrees?.coordinator ?? new ExecutionRootCoordinator();
    this.checkpoints = options.checkpoints ?? new CheckpointService({ homeDir: options.homeDir });
    this.worktrees =
      options.worktrees ?? new WorktreeService({ homeDir: options.homeDir, coordinator });
    this.external =
      options.external ??
      new ExternalSessionService({
        homeDir: options.homeDir,
        checkpoints: this.checkpoints,
        worktrees: this.worktrees,
        executionCoordinator: coordinator,
      });
    this.registry = new SessionRegistry({
      create: options.create,
      approval: (entry) => {
        let channel = this.approvals.get(entry.sessionId);
        if (!channel) {
          channel = new RpcApprovalChannel({
            identity: (request) =>
              entry.controller
                ? {
                    sessionId: entry.sessionId,
                    streamEpoch: entry.streamEpoch,
                    controlEpoch: entry.controller.epoch,
                    runId: entry.active?.id ?? request?.subagentOrigin?.agentId ?? 'background',
                  }
                : undefined,
            describe: (request) => describeApproval(request, entry.resources.redact),
            includeSubagentOrigin: () => {
              const controllerId = entry.controller?.clientId;
              const caps = controllerId ? this.peerCapabilities.get(controllerId) : undefined;
              return Boolean(caps && hasV016Capability(caps));
            },
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
    const requireReferencesCapability = (): void => {
      if (!negotiatedCapabilities.has('references')) {
        throw new Error('PROTOCOL_MISMATCH');
      }
    };
    const requireCheckpointCapability = (): void => {
      if (!negotiatedCapabilities.has('checkpoint')) {
        throw new Error('PROTOCOL_MISMATCH');
      }
    };
    const requireWorktreeCapability = (): void => {
      if (!negotiatedCapabilities.has('worktree')) {
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
        this.peerCapabilities.set(clientId, negotiatedCapabilities);
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
        case 'session/create': {
          requireAbsolute(request.params.workspaceRoot);
          if (request.params.worktree !== undefined) {
            requireWorktreeCapability();
          }
          if (request.params.worktree?.enabled) {
            const { root } = this.resolveTrustedWorkspace(request.params.workspaceRoot);
            const created = await this.worktrees.create({
              projectRoot: root,
              ...(request.params.worktree.branch ? { branch: request.params.worktree.branch } : {}),
              ...(request.params.worktree.baseRef
                ? { baseRef: request.params.worktree.baseRef }
                : {}),
            });
            try {
              const opened = await this.registry.open(root, undefined, {
                worktree: created.binding,
              });
              if (!negotiatedCapabilities.has('worktree') && opened.worktree !== undefined) {
                const { worktree: _omitted, ...legacy } = opened;
                return legacy as unknown as JsonValue;
              }
              return opened as unknown as JsonValue;
            } catch (openErr) {
              await this.worktrees.remove({ id: created.record.id, force: true }).catch(() => {});
              throw openErr;
            }
          }
          const opened = await this.registry.open(request.params.workspaceRoot);
          if (!negotiatedCapabilities.has('worktree') && opened.worktree !== undefined) {
            const { worktree: _omitted, ...legacy } = opened;
            return legacy as unknown as JsonValue;
          }
          return opened as unknown as JsonValue;
        }
        case 'session/open': {
          requireAbsolute(request.params.workspaceRoot);
          const opened = await this.registry.open(
            request.params.workspaceRoot,
            request.params.conversationId,
          );
          if (!negotiatedCapabilities.has('worktree') && opened.worktree !== undefined) {
            const { worktree: _omitted, ...legacy } = opened;
            return legacy as unknown as JsonValue;
          }
          return opened as unknown as JsonValue;
        }
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
          const includeDelegation = hasV016Capability(negotiatedCapabilities);
          return {
            items: result.items.map((item) => {
              const parentTitle = item.delegation?.parentTitle
                ? sanitizeDisplayText(redactText(item.delegation.parentTitle, secrets), 200)
                : undefined;
              return {
                conversationId: item.conversationId,
                title: sanitizeDisplayText(redactText(item.title, secrets), 200) ?? '',
                ...(includeDelegation && item.delegation
                  ? {
                      delegation: {
                        parentSessionId: item.delegation.parentSessionId,
                        ...(parentTitle ? { parentTitle } : {}),
                        taskName:
                          sanitizeDisplayText(redactText(item.delegation.taskName, secrets), 200) ??
                          '',
                      },
                    }
                  : {}),
              };
            }),
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
          const includeRetry = negotiatedCapabilities.has('retry');
          // 先捕获唯一可能失败的快照，再授予控制权；任何失败都不能让会话被本次连接占住。
          const page = pager.capture(entry.sessionId, {
            history: entry.resources.history(),
            live: entry.active
              ? ((includeRetry ? entry.live?.events : entry.live?.baseEvents) ?? [])
              : [],
          });
          const newlyGranted = request.params.mode === 'control' && !entry.controller;
          try {
            const snapshot = this.registry.attach(
              request.params.sessionId,
              clientId,
              request.params.mode,
              this.pendingApprovals(entry.sessionId),
              { includeRetry, capabilities: negotiatedCapabilities },
            );
            subscriptions.get(entry.sessionId)?.();
            subscriptions.set(
              entry.sessionId,
              entry.feed.subscribe((event) => peer.notify(event), { includeRetry }),
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
          const includeRetry = negotiatedCapabilities.has('retry');
          const page = pager.capture(entry.sessionId, {
            history: entry.resources.history(),
            live: entry.active
              ? ((includeRetry ? entry.live?.events : entry.live?.baseEvents) ?? [])
              : [],
          });
          return {
            ...this.registry.snapshot(entry, clientId, this.pendingApprovals(entry.sessionId), {
              includeRetry,
            }),
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
          if (request.params.references && request.params.references.length > 0) {
            requireReferencesCapability();
          }
          return this.registry.start(
            request.params,
            clientId,
            request.params.clientOperationId,
            request.params.input,
            request.params.references,
          );
        case 'run/cancel':
          await this.registry.cancel(request.params, clientId, request.params.runId);
          return { cancellationRequested: true };
        case 'reference/candidates': {
          requireReferencesCapability();
          const { root, home, secrets } = this.resolveTrustedWorkspace(
            request.params.workspaceRoot,
          );
          const reader = new SessionReferenceReader({ homeDirectory: home });
          const candidates = await reader.listCandidates({
            projectRoot: root,
            ...(request.params.limit !== undefined ? { limit: request.params.limit } : {}),
          });
          return {
            items: candidates.map((item) => ({
              sessionId: item.sessionId,
              title: sanitizeDisplayText(redactText(item.title, secrets), 200) ?? '',
              lastActivityAt: item.lastActivityAt,
              messageCount: item.messageCount,
              ...(item.delegation ? { isDelegation: true } : {}),
            })),
          };
        }
        case 'reference/search': {
          requireReferencesCapability();
          const { root, home, secrets } = this.resolveTrustedWorkspace(
            request.params.workspaceRoot,
          );
          const rawQuery = request.params.query;
          const sanitizedQuery = rawQuery.trim().startsWith('re:')
            ? rawQuery
            : rawQuery.replace(/\bproject:\S+/gi, '').trim();
          if (!sanitizedQuery) return { hits: [] };
          const catalog = new CrossProjectSessionCatalog({ homeDirectory: home });
          const bucketKey = computeProjectKey(root);
          const bucketEntries = await catalog.scanSessions({
            projectKey: bucketKey,
            projectRoot: root,
          });
          const titleBySession = new Map(
            bucketEntries.map((entry) => [
              entry.conversationId,
              sanitizeDisplayText(redactText(entry.title, secrets), 200) ??
                entry.conversationId.slice(0, 8),
            ]),
          );
          const searchResult = await catalog.search(sanitizedQuery, {
            project: root,
            limit: request.params.limit ?? 20,
          });
          return {
            hits: searchResult.hits
              .filter((hit) => isSamePath(hit.projectRoot, root))
              .map((hit) => ({
                sessionId: hit.conversationId,
                title: titleBySession.get(hit.conversationId) ?? hit.conversationId.slice(0, 8),
                recordId: hit.recordId,
                branchId: hit.branchId,
                role: hit.role,
                snippet: sanitizeDisplayText(redactText(hit.snippet, secrets), 400) ?? '',
                timestamp: hit.timestamp,
              })),
          };
        }
        case 'reference/read': {
          requireReferencesCapability();
          const { root, home, secrets } = this.resolveTrustedWorkspace(
            request.params.workspaceRoot,
          );
          const reader = new SessionReferenceReader({ homeDirectory: home });
          const readResult = await reader.read({
            projectRoot: root,
            sessionId: request.params.sessionId,
            ...(request.params.recordIds ? { recordIds: request.params.recordIds } : {}),
            ...(request.params.branchId !== undefined ? { branchId: request.params.branchId } : {}),
            ...(request.params.limit !== undefined ? { limit: request.params.limit } : {}),
          });
          const title = readResult.title
            ? sanitizeDisplayText(redactText(readResult.title, secrets), 200)
            : undefined;
          return {
            sessionId: readResult.sessionId,
            ...(title ? { title } : {}),
            branchId: readResult.branchId,
            records: readResult.records.map((rec) => ({
              recordId: rec.recordId,
              role: rec.role,
              branchId: rec.branchId,
              timestamp: rec.timestamp,
              text: redactText(rec.text, secrets),
              truncated: rec.truncated,
            })),
            ...(readResult.partial ? { partial: readResult.partial } : {}),
          };
        }
        case 'checkpoint/list': {
          requireCheckpointCapability();
          if (request.params.external) {
            requireExternalCapability();
            const items = await this.external.listSessionCheckpoints(request.params.sessionId);
            return {
              items: items.map((item) => ({
                ordinal: item.ordinal,
                createdAt: item.createdAt,
                startTree: item.startTree,
                endTree: item.endTree,
                additions: item.additions,
                deletions: item.deletions,
                changedFilesCount: item.changedFilesCount,
                label: item.label ?? null,
              })),
            };
          }
          if (!subscriptions.has(request.params.sessionId)) throw new Error('CONTROL_REQUIRED');
          const entry = this.registry.get(request.params.sessionId);
          if (!entry.resources.checkpoints) throw new LocalHostError('INVALID_REQUEST');
          const items = await entry.resources.checkpoints();
          return {
            items: items.map((item) => ({
              ordinal: item.ordinal,
              createdAt: item.createdAt,
              startTree: item.startTree,
              endTree: item.endTree,
              additions: item.additions,
              deletions: item.deletions,
              changedFilesCount: item.changedFilesCount,
              label: item.label ?? null,
            })),
          };
        }
        case 'checkpoint/diff': {
          requireCheckpointCapability();
          const { ordinal, fromOrdinal, toOrdinal, includeLiveWorktree } = request.params;
          if (request.params.external) {
            requireExternalCapability();
            const diff = await this.external.diffSessionCheckpoints({
              sessionId: request.params.sessionId,
              ...(ordinal !== undefined ? { ordinal } : {}),
              ...(fromOrdinal !== undefined ? { fromOrdinal } : {}),
              ...(toOrdinal !== undefined ? { toOrdinal } : {}),
              ...(includeLiveWorktree !== undefined ? { includeLiveWorktree } : {}),
            });
            return {
              available: diff.available,
              additions: diff.additions,
              deletions: diff.deletions,
              truncated: diff.truncated,
              files: diff.files.map((f) => ({
                path: f.path,
                status: f.status,
                originalPath: f.originalPath ?? null,
                additions: f.additions,
                deletions: f.deletions,
                binary: f.binary,
                patch: f.patch,
                truncated: f.truncated,
              })),
            };
          }
          if (!subscriptions.has(request.params.sessionId)) throw new Error('CONTROL_REQUIRED');
          const entry = this.registry.get(request.params.sessionId);
          if (!entry.resources.checkpointDiff) throw new LocalHostError('INVALID_REQUEST');
          const diff = await entry.resources.checkpointDiff({
            ...(ordinal !== undefined ? { ordinal } : {}),
            ...(fromOrdinal !== undefined ? { fromOrdinal } : {}),
            ...(toOrdinal !== undefined ? { toOrdinal } : {}),
            ...(includeLiveWorktree !== undefined ? { includeLiveWorktree } : {}),
          });
          return {
            available: diff.available,
            additions: diff.additions,
            deletions: diff.deletions,
            truncated: diff.truncated,
            files: diff.files.map((f) => ({
              path: f.path,
              status: f.status,
              originalPath: f.originalPath ?? null,
              additions: f.additions,
              deletions: f.deletions,
              binary: f.binary,
              patch: f.patch,
              truncated: f.truncated,
            })),
          };
        }
        case 'checkpoint/restore': {
          requireCheckpointCapability();
          if (request.params.external) {
            requireExternalCapability();
            const resolvedId = this.attachOrVerifyExternalController(
              request.params.sessionId,
              clientId,
            );
            const outcome = await this.external.restoreSessionCheckpoint({
              sessionId: resolvedId,
              targetOrdinal: request.params.targetOrdinal,
              ...(request.params.force !== undefined ? { force: request.params.force } : {}),
            });
            if (outcome.status === 'conflict') {
              return {
                status: 'conflict',
                restoredFiles: [],
                deletedFiles: [],
                conflicts: [...outcome.conflicts],
              };
            }
            return {
              status: outcome.status,
              restoredFiles: [...outcome.restoredFiles],
              deletedFiles: [...outcome.deletedFiles],
              conflicts: [],
            };
          }
          const entry = this.registry.get(request.params.sessionId);
          if (!entry.controller || entry.controller.clientId !== clientId) {
            throw new Error('CONTROL_REQUIRED');
          }
          const maybeEpochs = request.params as {
            streamEpoch?: string;
            controlEpoch?: string;
          };
          if (
            entry.closing ||
            !entry.streamEpoch ||
            !entry.controller.epoch ||
            !subscriptions.has(entry.sessionId) ||
            (maybeEpochs.streamEpoch !== undefined &&
              maybeEpochs.streamEpoch !== entry.streamEpoch) ||
            (maybeEpochs.controlEpoch !== undefined &&
              maybeEpochs.controlEpoch !== entry.controller.epoch)
          ) {
            throw new Error('STALE_CONTROL');
          }
          if (entry.active || entry.needsCleanup) throw new Error('SESSION_BUSY');
          if (!entry.resources.restoreCheckpoint) throw new LocalHostError('INVALID_REQUEST');
          const outcome = await entry.resources.restoreCheckpoint(
            request.params.targetOrdinal,
            request.params.force,
          );
          if (outcome.status === 'conflict') {
            return {
              status: 'conflict',
              restoredFiles: [],
              deletedFiles: [],
              conflicts: [...outcome.conflicts],
            };
          }
          return {
            status: outcome.status,
            restoredFiles: [...outcome.restoredFiles],
            deletedFiles: [...outcome.deletedFiles],
            conflicts: [],
          };
        }
        case 'worktree/list': {
          requireWorktreeCapability();
          const { root } = this.resolveTrustedWorkspace(request.params.workspaceRoot);
          const items = this.worktrees.list(root).map((rec) => ({
            id: rec.id,
            projectRoot: rec.projectRoot,
            worktreePath: rec.worktreePath,
            branch: rec.branch,
            baseRef: rec.baseRef,
            baseCommit: rec.baseCommit,
            createdAt: rec.createdAt,
          }));
          return { items };
        }
        case 'worktree/create': {
          requireWorktreeCapability();
          const { root } = this.resolveTrustedWorkspace(request.params.workspaceRoot);
          const created = await this.worktrees.create({
            projectRoot: root,
            ...(request.params.name ? { name: request.params.name } : {}),
            ...(request.params.branch ? { branch: request.params.branch } : {}),
            ...(request.params.baseRef ? { baseRef: request.params.baseRef } : {}),
          });
          return {
            id: created.binding.id,
            projectRoot: created.binding.projectRoot,
            worktreePath: created.binding.worktreePath,
            branch: created.binding.branch,
            baseRef: created.binding.baseRef,
            baseCommit: created.binding.baseCommit,
            createdAt: created.binding.createdAt,
          };
        }
        case 'worktree/status': {
          requireWorktreeCapability();
          const { root } = this.resolveTrustedWorkspace(request.params.workspaceRoot);
          this.requireOwnedWorktree(request.params.id, root);
          const status = await this.worktrees.status(request.params.id);
          return {
            id: status.id,
            projectRoot: status.projectRoot,
            worktreePath: status.worktreePath,
            branch: status.branch,
            baseRef: status.baseRef,
            baseCommit: status.baseCommit,
            headCommit: status.headCommit ?? null,
            exists: status.exists,
            linkVerified: status.linkVerified,
            dirty: status.dirty,
            untrackedCount: status.untrackedCount,
            aheadCount: status.aheadCount,
            behindCount: status.behindCount,
            additions: status.additions,
            deletions: status.deletions,
            changedFiles: status.changedFiles.map((f) => ({
              path: f.path,
              status: f.status,
              oldPath: f.oldPath ?? null,
              additions: f.additions,
              deletions: f.deletions,
              binary: f.binary,
            })),
          };
        }
        case 'worktree/diff': {
          requireWorktreeCapability();
          const { root, secrets } = this.resolveTrustedWorkspace(request.params.workspaceRoot);
          this.requireOwnedWorktree(request.params.id, root);
          const diff = await this.worktrees.diff(request.params.id);
          return {
            id: diff.id,
            branch: diff.branch,
            baseCommit: diff.baseCommit,
            headCommit: diff.headCommit,
            additions: diff.additions,
            deletions: diff.deletions,
            truncated: diff.truncated,
            files: diff.files.map((f) => ({
              path: redactText(f.path, secrets),
              status: f.status,
              originalPath: f.oldPath ? redactText(f.oldPath, secrets) : null,
              additions: f.additions,
              deletions: f.deletions,
              binary: f.binary,
              patch: redactText(f.patch, secrets),
              truncated: f.truncated,
            })),
          };
        }
        case 'worktree/previewMerge': {
          requireWorktreeCapability();
          const { root } = this.resolveTrustedWorkspace(request.params.workspaceRoot);
          this.requireOwnedWorktree(request.params.id, root);
          const preview = await this.worktrees.previewMerge(request.params.id);
          return {
            worktreeId: preview.id,
            branch: preview.branch,
            baseRef: preview.targetBranch,
            aheadCount: preview.aheadCount,
            behindCount: preview.behindCount,
            worktreeDirty: preview.worktreeDirty,
            mainDirty: preview.mainDirty,
            canApply: preview.canApply,
            blockingReason: preview.blockingReason ?? null,
            additions: preview.additions,
            deletions: preview.deletions,
            previewToken: preview.previewToken,
            changedFiles: preview.changedFiles.map((f) => ({
              path: f.path,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
            })),
          };
        }
        case 'worktree/applyMerge': {
          requireWorktreeCapability();
          const { root } = this.resolveTrustedWorkspace(request.params.workspaceRoot);
          this.requireOwnedWorktree(request.params.id, root);
          const outcome = await this.worktrees.applyMerge({
            id: request.params.id,
            previewToken: request.params.previewToken,
            ...(request.params.commitMessage
              ? { commitMessage: request.params.commitMessage }
              : {}),
          });
          if (outcome.status === 'conflict') {
            return {
              status: 'conflict',
              mergedCommit: null,
              targetBranch: null,
              conflictedFiles: [...outcome.conflictedFiles],
            };
          }
          return {
            status: 'merged',
            mergedCommit: outcome.mergedCommit,
            targetBranch: outcome.targetBranch,
            conflictedFiles: [],
          };
        }
        case 'worktree/remove': {
          requireWorktreeCapability();
          const { root } = this.resolveTrustedWorkspace(request.params.workspaceRoot);
          this.requireOwnedWorktree(request.params.id, root);
          const outcome = await this.worktrees.remove({
            id: request.params.id,
            ...(request.params.force !== undefined ? { force: request.params.force } : {}),
            onBeforeRemove: async (rec) => {
              await this.registry.closeIdleSessionsInWorktree(rec.worktreePath);
              const matchingExternal = this.external
                .listSessions(root)
                .filter(
                  (ext) =>
                    ext.status === 'idle' &&
                    ext.worktree &&
                    isSamePath(ext.worktree.worktreePath, rec.worktreePath),
                );
              for (const ext of matchingExternal) {
                await this.external.closeSession(ext.id, root).catch(() => {});
              }
            },
          });
          if (!outcome.removed) {
            return {
              removed: false,
              reason: outcome.reason,
              details: [...outcome.details],
            };
          }
          return {
            removed: true,
            reason: null,
            details: [],
          };
        }
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
          const extWireOpts = {
            includeWorktree: negotiatedCapabilities.has('worktree'),
            includeDiffSummary: negotiatedCapabilities.has('checkpoint'),
          };
          return {
            items: this.external
              .listSessions(request.params.workspaceRoot)
              .map((item) => toExternalSessionWire(item, extWireOpts)),
          } as unknown as JsonValue;
        }
        case 'external/open': {
          requireExternalCapability();
          requireAbsolute(request.params.workspaceRoot);
          const extWireOpts = {
            includeWorktree: negotiatedCapabilities.has('worktree'),
            includeDiffSummary: negotiatedCapabilities.has('checkpoint'),
          };
          if (request.params.worktree !== undefined) {
            requireWorktreeCapability();
          }
          if (request.params.worktree?.enabled) {
            const { root } = this.resolveTrustedWorkspace(request.params.workspaceRoot);
            const created = await this.worktrees.create({
              projectRoot: root,
              ...(request.params.title ? { name: request.params.title } : {}),
              ...(request.params.worktree.branch ? { branch: request.params.worktree.branch } : {}),
              ...(request.params.worktree.baseRef
                ? { baseRef: request.params.worktree.baseRef }
                : {}),
            });
            try {
              const snap = await this.external.openSession({
                projectRoot: root,
                workspaceRoot: created.binding.worktreePath,
                worktree: created.binding,
                harnessId: request.params.harnessId,
                ...(request.params.title ? { title: request.params.title } : {}),
              });
              this.externalControllers.set(snap.session.id, clientId);
              return toExternalSnapshotWire(snap, extWireOpts) as unknown as JsonValue;
            } catch (openErr) {
              await this.worktrees.remove({ id: created.record.id, force: true }).catch(() => {});
              throw openErr;
            }
          }
          const { worktree: _unusedWorktreeOpt, ...openParams } = request.params;
          const snap = await this.external.openSession(openParams);
          this.externalControllers.set(snap.session.id, clientId);
          return toExternalSnapshotWire(snap, extWireOpts) as unknown as JsonValue;
        }
        case 'external/attach': {
          requireExternalCapability();
          const extWireOpts = {
            includeWorktree: negotiatedCapabilities.has('worktree'),
            includeDiffSummary: negotiatedCapabilities.has('checkpoint'),
          };
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
                snapshot: toExternalSnapshotWire(nextSnap, extWireOpts),
              });
            }),
          );
          return toExternalSnapshotWire(snap, extWireOpts) as unknown as JsonValue;
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
          const extWireOpts = {
            includeWorktree: negotiatedCapabilities.has('worktree'),
            includeDiffSummary: negotiatedCapabilities.has('checkpoint'),
          };
          return toExternalSnapshotWire(
            this.external.getSnapshot(request.params.sessionId),
            extWireOpts,
          ) as unknown as JsonValue;
        }
        case 'external/prompt': {
          requireExternalCapability();
          const extWireOpts = {
            includeWorktree: negotiatedCapabilities.has('worktree'),
            includeDiffSummary: negotiatedCapabilities.has('checkpoint'),
          };
          const resolvedId = this.attachOrVerifyExternalController(
            request.params.sessionId,
            clientId,
          );
          const snap = await this.external.promptSession({
            sessionId: resolvedId,
            text: request.params.text,
          });
          return toExternalSnapshotWire(snap, extWireOpts) as unknown as JsonValue;
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
        this.peerCapabilities.delete(clientId);
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
   * 规范化跨会话引用目标目录并强制核查项目信任态，杜绝经只读引用接口探测未信任工作区或跨桶历史。
   */
  private resolveTrustedWorkspace(workspaceRoot: string): {
    root: string;
    home: string;
    secrets: string[];
  } {
    requireAbsolute(workspaceRoot);
    let physicalRoot: string;
    try {
      physicalRoot = detectProjectRoot(fs.realpathSync.native(workspaceRoot));
    } catch {
      throw new Error('INVALID_PARAMS');
    }
    const home = fs.realpathSync.native(this.options.homeDir ?? os.homedir());
    const loaded = loadSettings({ cwd: physicalRoot, homeDir: home, includeProject: false });
    if (!isProjectTrusted(loaded.settings, physicalRoot)) {
      throw new Error('TRUST_REQUIRED');
    }
    return {
      root: physicalRoot,
      home,
      secrets: loadCredentialSecrets(physicalRoot, home),
    };
  }

  /**
   * 校验目标工作树记录归属当前已信任工作区根，阻断跨项目通过 worktreeId 越权读取或合并。
   */
  private requireOwnedWorktree(id: string, projectRoot: string): void {
    const rec = this.worktrees.get(id);
    if (!rec || !isSamePath(rec.projectRoot, projectRoot)) {
      throw new WorktreeError('WORKTREE_NOT_FOUND', `Worktree '${id}' not found in workspace`);
    }
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
