/**
 * @fileoverview 保留型委派会话的宿主侧读取与索引重建。
 *
 * 约束、边界与为什么：
 * 1. 只读头文件：重建幂等索引只需要每条会话的首行 header，不扫描正文、不取写锁、不写 sidecar；
 * 2. 桶内隔离：只读当前 SessionManager 所属项目桶，不跨项目猜测身份；
 * 3. 结构校验：header.delegation.requestReceipt 视为不透明快照，字段不全就跳过，
 *    绝不凭残缺数据伪造「已派发」状态。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  type DelegationHeader,
  KapibalaError,
  type RestoredDelegationRequest,
  type SessionHeader,
  type SessionManager,
  type SessionMetadata,
  type SessionRecord,
  type SpawnAgentReceipt,
} from '@kiturone/kapibala';

/** 每个项目桶保留的终态委派会话上限；新建前先按空闲超期与容量策略尝试自动淘汰。 */
export const MAX_RETAINED_DELEGATIONS = 20;

/** 终态委派会话默认最长空闲保留时间（7 天）；超出且未置顶、非锁定时自动清理。 */
export const DEFAULT_DELEGATION_MAX_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

/** 首行 header 的读取上限；正常 header 远小于该值，超出视为异常文件并跳过。 */
const HEADER_READ_LIMIT_BYTES = 64 * 1024;

/** 增量索引最多记住多少个项目桶；超出按最近最少使用淘汰，避免长驻宿主无界持有。 */
const DELEGATION_INDEX_BUCKET_LIMIT = 8;

/** 读取文件首行；失败或空文件返回 undefined，不抛错。 */
function readFirstLine(filePath: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(HEADER_READ_LIMIT_BYTES);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes <= 0) return undefined;
    const text = buffer.subarray(0, bytes).toString('utf8');
    const newline = text.indexOf('\n');
    return (newline === -1 ? text : text.slice(0, newline)).trim() || undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 关闭失败不影响只读结果 */
      }
    }
  }
}

type DelegationHeaderProbe =
  | { status: 'ready'; entry?: { delegation: DelegationHeader; conversationId: string } }
  | { status: 'retry' };

/**
 * 解析一条委派会话 header。
 *
 * 返回值区分「已读出结论」与「暂不可判」：首行为空、读取失败或 JSON 不完整时返回
 * `retry`（文件可能还在创建中，不能把半行写坏当成永久否定），其余返回 `ready`。
 * header 首行创建后不再改写，因此 `ready` 的否定结论可以安全缓存。
 */
function probeDelegationHeader(filePath: string): DelegationHeaderProbe {
  const line = readFirstLine(filePath);
  if (!line) return { status: 'retry' };
  try {
    const record = JSON.parse(line) as SessionRecord;
    if (record.type !== 'header') return { status: 'ready' };
    const header = record.payload as unknown as SessionHeader;
    const delegation = header.delegation;
    if (!delegation || delegation.kind !== 'delegation') return { status: 'ready' };
    if (!delegation.requestId || !delegation.requestSignature || !delegation.requestReceipt)
      return { status: 'ready' };
    return { status: 'ready', entry: { delegation, conversationId: header.conversationId } };
  } catch {
    return { status: 'retry' };
  }
}

/** 校验持久回执快照的最小结构；缺少运行身份字段即放弃重建。 */
function parseReceipt(value: unknown): SpawnAgentReceipt | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.agentId !== 'string' ||
    typeof record.role !== 'string' ||
    typeof record.description !== 'string' ||
    typeof record.rootTaskId !== 'string' ||
    typeof record.workspaceRoot !== 'string' ||
    typeof record.executionCwd !== 'string' ||
    typeof record.depth !== 'number'
  )
    return undefined;
  return {
    agentId: record.agentId,
    status: 'accepted',
    role: record.role as SpawnAgentReceipt['role'],
    description: record.description,
    depth: record.depth,
    rootTaskId: record.rootTaskId,
    modelRole: (record.modelRole as SpawnAgentReceipt['modelRole'] | undefined) ?? 'inherit',
    workspaceRoot: record.workspaceRoot,
    executionCwd: record.executionCwd,
    ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
  };
}

/** 单桶增量索引：已扫描文件名与其中发现的幂等条目；两者一一对应便于文件删除时同步移除。 */
interface DelegationIndex {
  scanned: Set<string>;
  entries: Map<string, RestoredDelegationRequest>;
}

/**
 * 按项目桶维护的增量索引。
 *
 * 为什么需要：本函数在每次会话资源创建时被调用，若每次都重读桶内全部会话头，
 * 长期驻留的宿主（daemon/桌面）会随会话数增长产生 O(N²) 的字节分配，把 RSS 推高。
 * header 首行在创建后不再改写，因此只需解析每个文件一次；这里按目录缓存解析结论，
 * 仅对新增文件做 IO，文件被删除时同步移除条目。
 */
const delegationIndexes = new Map<string, DelegationIndex>();

/** 取指定桶的增量索引；命中时刷新 LRU 次序，超出上限淘汰最久未用的桶。 */
function delegationIndexFor(directory: string): DelegationIndex {
  const existing = delegationIndexes.get(directory);
  if (existing) {
    delegationIndexes.delete(directory);
    delegationIndexes.set(directory, existing);
    return existing;
  }
  const created: DelegationIndex = { scanned: new Set(), entries: new Map() };
  delegationIndexes.set(directory, created);
  if (delegationIndexes.size > DELEGATION_INDEX_BUCKET_LIMIT) {
    const oldest = delegationIndexes.keys().next().value;
    if (oldest !== undefined) delegationIndexes.delete(oldest);
  }
  return created;
}

/**
 * 从当前项目桶的委派会话头重建 spawn 幂等索引条目。
 *
 * 用途：进程重启后同一个 requestId 不得重复派发第二个委派会话。
 * 边界：只重建 spawn 侧索引；runtime 的任务记录与续聊上下文不跨进程，
 * 因此重放只返回原回执，模型侧 send_agent 仍不可用（用户级续聊走 `/delegations open`）。
 *
 * 每次调用只解析上次扫描后新增的文件（增量索引），返回值与缓存共享对象引用，
 * 调用方不得原地修改；桶内文件被删除时对应条目在下次调用时移除。
 *
 * @param manager 当前项目桶的会话管理器
 * @returns 可直接传给 AgentRuntime.restoredRequests 的条目；损坏或不全的会话被跳过
 */
export function readDelegationRequestEntries(manager: SessionManager): RestoredDelegationRequest[] {
  const directory = manager.directory;
  let files: string[];
  try {
    files = fs.readdirSync(directory).filter((name) => /^\d+_[a-zA-Z0-9-]+\.jsonl$/.test(name));
  } catch {
    return [];
  }

  const index = delegationIndexFor(directory);
  const present = new Set(files);
  for (const fileName of index.scanned) {
    if (present.has(fileName)) continue;
    index.scanned.delete(fileName);
    index.entries.delete(fileName);
  }

  for (const fileName of files) {
    if (index.scanned.has(fileName)) continue;
    const probe = probeDelegationHeader(path.join(directory, fileName));
    if (probe.status === 'retry') continue;
    index.scanned.add(fileName);
    if (!probe.entry) continue;
    const receipt = parseReceipt(probe.entry.delegation.requestReceipt);
    if (!receipt) continue;
    index.entries.set(fileName, {
      requestId: probe.entry.delegation.requestId!,
      signature: probe.entry.delegation.requestSignature!,
      // 回执快照在会话创建前生成、无从得知自身 ID；以 header.conversationId 补齐，
      // 让重启后的幂等重放直接指向可续聊的委派会话。
      receipt: { ...receipt, sessionId: receipt.sessionId ?? probe.entry.conversationId },
    });
  }
  return [...index.entries.values()];
}

/** 面向 `/delegations` 面板的委派会话摘要；不包含正文。 */
export interface DelegationSessionSummary {
  /** 委派会话 ID（用户可见的唯一凭据）。 */
  readonly sessionId: string;
  /** 展示名（`委派名 · 父会话名`，创建时写入）。 */
  readonly title: string;
  /** 委派任务名（首次派发的 description）。 */
  readonly taskName: string;
  /** 发起派发的父会话 ID。 */
  readonly parentSessionId: string;
  /** 父会话标题快照。 */
  readonly parentTitle?: string;
  /** 最后活动时间（毫秒）。 */
  readonly lastActivityAt: number;
  /** 是否已归档；归档会话仍占用保留预算，需显式删除才释放。 */
  readonly archived: boolean;
}

/** 分页读取全部会话元数据；`SessionManager.list` 单页上限 100，这里只做完整遍历。 */
async function readAllMetadata(manager: SessionManager): Promise<SessionMetadata[]> {
  const items: SessionMetadata[] = [];
  for (let page = 1; ; page++) {
    const result = await manager.list(page, { pageSize: 100, includeArchived: true });
    items.push(...result.items);
    if (page >= result.pages) break;
  }
  return items;
}

/**
 * 列出当前项目桶内全部保留型委派会话（含已归档）。
 *
 * 边界：只读元数据（sidecar/header），不读取正文、不取写锁；
 * 运行状态不在这里推导，调用方应结合 AgentRuntime 的任务快照展示「运行中/可续聊」。
 */
export async function listDelegationSessions(
  manager: SessionManager,
): Promise<DelegationSessionSummary[]> {
  const metadata = await readAllMetadata(manager);
  return metadata
    .filter((item) => item.delegation)
    .map((item) => ({
      sessionId: item.conversationId,
      title: item.title || item.delegation!.taskName,
      taskName: item.delegation!.taskName,
      parentSessionId: item.delegation!.parentSessionId,
      ...(item.delegation!.parentTitle ? { parentTitle: item.delegation!.parentTitle } : {}),
      lastActivityAt: item.lastActivityAt,
      archived: Boolean(item.archived),
    }))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

/**
 * 统计当前项目桶内仍占用保留预算的委派会话数量（含已归档）。
 *
 * 为什么包含归档：归档只是逻辑标记，文件仍占磁盘与保留名额；
 * 只有 `/delegations delete` 或自动淘汰的物理删除才真正释放。
 */
export async function countRetainedDelegations(manager: SessionManager): Promise<number> {
  return (await listDelegationSessions(manager)).length;
}

/**
 * 委派会话自动淘汰（`pruneDelegationSessions`）策略参数。
 */
export interface PruneDelegationOptions {
  /** 允许保留的最大委派会话数（默认 `MAX_RETAINED_DELEGATIONS = 20`）；超出部分从最旧活动项起淘汰。 */
  readonly maxRetained?: number;
  /** 未置顶终态委派会话的最大空闲毫秒数（默认 7 天）；早于该阈值的会话优先清理。 */
  readonly maxIdleMs?: number;
  /** 当前仍在运行中的子会话 ID 集合；集合内条目绝不删除。 */
  readonly activeSessionIds?: ReadonlySet<string>;
  /** 可选时钟注入（毫秒时间戳），仅供确定性测试使用。 */
  readonly now?: number;
  /** 每次淘汰成功时发出的诊断日志回调。 */
  readonly onDiagnostic?: (message: string) => void;
}

/**
 * 按最旧活动时间优先顺序（oldest-`lastActivityAt`-first）自动清理过期或超限的保留型委派会话。
 *
 * 前置约束与安全边界：
 * - 置顶（`pinned === true`）、运行中（命中 `activeSessionIds`）或被当前/外部存活进程持锁（`SESSION_IN_USE` /
 *   `SESSION_LOCKED`）的委派会话一律跳过，绝不抢锁或中断活跃任务；
 * - 满足「距今超过 `maxIdleMs`（默认 7 天）」或「当前总保留数仍高于 `maxRetained`（默认 20）」的可淘汰项
 *   将被物理删除并返回已删 `sessionId` 列表，供调用方同步执行 `runtime.forgetDelegationSession`。
 */
export async function pruneDelegationSessions(
  manager: SessionManager,
  options?: PruneDelegationOptions,
): Promise<string[]> {
  const maxRetained = Math.max(0, options?.maxRetained ?? MAX_RETAINED_DELEGATIONS);
  const maxIdleMs = Math.max(0, options?.maxIdleMs ?? DEFAULT_DELEGATION_MAX_IDLE_MS);
  const now = options?.now ?? Date.now();
  const activeIds = options?.activeSessionIds;

  const metadata = (await readAllMetadata(manager)).filter((item) => Boolean(item.delegation));
  if (metadata.length === 0) return [];

  // 按最后活动时间升序排列，确保先淘汰最久未活动的终态委派会话。
  const ordered = [...metadata].sort(
    (a, b) =>
      a.lastActivityAt - b.lastActivityAt || a.conversationId.localeCompare(b.conversationId),
  );

  let remaining = ordered.length;
  const deleted: string[] = [];
  for (const item of ordered) {
    if (item.pinned === true) continue;
    if (activeIds?.has(item.conversationId)) continue;

    const expired = now - item.lastActivityAt > maxIdleMs;
    const overCapacity = remaining > maxRetained;
    if (!expired && !overCapacity) continue;

    try {
      await manager.deleteSession(item.conversationId);
      deleted.push(item.conversationId);
      remaining--;
      try {
        options?.onDiagnostic?.(
          `[delegations] pruned retained delegation session ${item.conversationId} (${expired ? 'idle_expired' : 'over_capacity'})`,
        );
      } catch {
        /* 诊断回调异常不阻断清理循环 */
      }
    } catch (error) {
      if (
        error instanceof KapibalaError &&
        (error.code === 'SESSION_IN_USE' ||
          error.code === 'SESSION_LOCKED' ||
          error.code === 'SESSION_NOT_FOUND')
      ) {
        if (error.code === 'SESSION_NOT_FOUND') remaining--;
        continue;
      }
      throw error;
    }
  }

  return deleted;
}
