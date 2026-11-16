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
import type {
  DelegationHeader,
  RestoredDelegationRequest,
  SessionHeader,
  SessionManager,
  SessionMetadata,
  SessionRecord,
  SpawnAgentReceipt,
} from '@kiturone/kapibala';

/** 每个项目桶保留的终态委派会话上限（MVP：达上限拒绝新建，不做自动淘汰）。 */
export const MAX_RETAINED_DELEGATIONS = 20;

/** 首行 header 的读取上限；正常 header 远小于该值，超出视为异常文件并跳过。 */
const HEADER_READ_LIMIT_BYTES = 64 * 1024;

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

/** 解析一条委派会话 header；非委派或缺少幂等字段时返回 undefined。 */
function parseDelegationHeader(
  filePath: string,
): { delegation: DelegationHeader; conversationId: string } | undefined {
  const line = readFirstLine(filePath);
  if (!line) return undefined;
  try {
    const record = JSON.parse(line) as SessionRecord;
    if (record.type !== 'header') return undefined;
    const header = record.payload as unknown as SessionHeader;
    const delegation = header.delegation;
    if (!delegation || delegation.kind !== 'delegation') return undefined;
    if (!delegation.requestId || !delegation.requestSignature || !delegation.requestReceipt)
      return undefined;
    return { delegation, conversationId: header.conversationId };
  } catch {
    return undefined;
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

/**
 * 从当前项目桶的委派会话头重建 spawn 幂等索引条目。
 *
 * 用途：进程重启后同一个 requestId 不得重复派发第二个委派会话。
 * 边界：只重建 spawn 侧索引；runtime 的任务记录与续聊上下文不跨进程，
 * 因此重放只返回原回执，模型侧 send_agent 仍不可用（用户级续聊走 `/delegations open`）。
 *
 * @param manager 当前项目桶的会话管理器
 * @returns 可直接传给 AgentRuntime.restoredRequests 的条目；损坏或不全的会话被跳过
 */
export function readDelegationRequestEntries(manager: SessionManager): RestoredDelegationRequest[] {
  let files: string[];
  try {
    files = fs
      .readdirSync(manager.directory)
      .filter((name) => /^\d+_[a-zA-Z0-9-]+\.jsonl$/.test(name));
  } catch {
    return [];
  }

  const entries: RestoredDelegationRequest[] = [];
  for (const fileName of files) {
    const filePath = path.join(manager.directory, fileName);
    const parsed = parseDelegationHeader(filePath);
    if (!parsed) continue;
    const receipt = parseReceipt(parsed.delegation.requestReceipt);
    if (!receipt) continue;
    entries.push({
      requestId: parsed.delegation.requestId!,
      signature: parsed.delegation.requestSignature!,
      // 回执快照在会话创建前生成、无从得知自身 ID；以 header.conversationId 补齐，
      // 让重启后的幂等重放直接指向可续聊的委派会话。
      receipt: { ...receipt, sessionId: receipt.sessionId ?? parsed.conversationId },
    });
  }
  return entries;
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
 * 只有 `/delegations delete` 的物理删除才真正释放。
 */
export async function countRetainedDelegations(manager: SessionManager): Promise<number> {
  return (await listDelegationSessions(manager)).length;
}
