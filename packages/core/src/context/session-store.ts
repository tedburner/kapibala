import fs from 'node:fs';
import path from 'node:path';
import { KapibalaError } from '../errors/index.js';
import { validateProtocolContent } from '../models/protocol-state.js';
import type { CanonicalMessage, ContentBlock } from '../types/index.js';
import { type HistoryRepair, createMessageId, normalizeHistory } from './history.js';
import { readJsonlLines, syncSessionDirectory } from './jsonl-lines.js';
import type { MessageStore } from './store/index.js';

/** 会话正文 schema v1 版本常量（只读兼容）。 */
export const SESSION_SCHEMA_VERSION_V1 = 1;
/** 会话正文 schema v2 版本常量（当前规范）。 */
export const SESSION_SCHEMA_VERSION_V2 = 2;
/** 当前会话正文默认创建与支持的 schema 版本。 */
export const SESSION_SCHEMA_VERSION = SESSION_SCHEMA_VERSION_V2;

/** 默认主分支标识。 */
export const MAIN_BRANCH_ID = 'main';

/** 会话记录类型：header 只出现一次，message 承载正文，其余为分支或全局控制记录。 */
export type SessionRecordType =
  | 'header'
  | 'message'
  | 'run_started'
  | 'run_finished'
  | 'message_state'
  | 'history_repair'
  | 'usage'
  | 'checkpoint'
  | 'context_pruned'
  | 'compaction_state'
  | 'title'
  | 'reset'
  | 'legacy_import'
  | 'branch_created'
  | 'branch_selected'
  | 'branch_summary'
  | 'archive_state';

/**
 * 判断指定记录类型是否属于全局控制记录。
 *
 * 保证：
 * - 全局控制记录的 parentId 为 null，不推进分支上下文叶子；
 * - 其余记录为分支记录，必须有合法的前驱因果 parentId 并推进对应分支的叶子。
 */
export function isGlobalControlRecordType(type: SessionRecordType): boolean {
  return (
    type === 'header' ||
    type === 'branch_created' ||
    type === 'branch_selected' ||
    type === 'title' ||
    type === 'archive_state' ||
    type === 'usage' ||
    type === 'legacy_import'
  );
}

/** 会话文件首条记录：身份与创建环境快照；conversationId 与文件名强绑定。 */
export interface SessionHeader {
  conversationId: string;
  projectRoot: string;
  initialCwd: string;
  createdAt?: number;
  gitBranch?: string;
  /** 旧历史导入的幂等身份；存在时同一来源只导入一次。 */
  importIdentity?: string;
  /** v1 副本升级的幂等来源身份（来源路径 + 源 conversationId + 源内容哈希）。 */
  upgradeIdentity?: string;
  /** 派生或 Fork 来源会话与切点记录 ID。 */
  parentSessionId?: string;
  forkPointRecordId?: string;
}

/** 单条 JSONL 记录封装；v2 引入连续物理 seq 与 prevRecordId，因果 parentId 与 branchId 独立。 */
export interface SessionRecord {
  schemaVersion: number;
  type: SessionRecordType;
  recordId: string;
  timestamp: number;
  /** 物理连续序号（v2，从 0 开始自增；v1 为 undefined）。 */
  seq?: number;
  /** 物理前驱记录 ID（v2 为上一条物理记录 ID，首条记录为 null；v1 为 undefined）。 */
  prevRecordId?: string | null;
  /** 上下文因果父节点记录 ID（分支记录必须有合法更早的父节点；全局控制记录为 null）。 */
  parentId: string | null;
  /** 分支归属标识（v2 分支记录归属；全局控制记录为 null 或 undefined；v1 为 undefined）。 */
  branchId?: string | null;
  payload: Record<string, unknown>;
}

/** loadState 返回的版本化状态视图；记录自最近 reset 起有效。 */
export interface SessionState {
  header: SessionHeader;
  /** 最近 reset 之后的记录；包含正文及状态，不包含头部。 */
  records: SessionRecord[];
  /** 只随正文、修复与 reset 改变，不因 usage 或缓存写入失效。 */
  contentRevision: string;
  /** 物理末记录 ID。 */
  logRevision: string;
  /** 当前活动分支 ID（默认 'main'）。 */
  activeBranchId: string;
  /** 当前活动分支叶子记录 ID。 */
  activeLeafId: string | null;
  /** 所有分支的叶子节点映射表。 */
  branchLeaves: ReadonlyMap<string, string>;
  /** 会话文件 schema 版本。 */
  schemaVersion: number;
}

/** 会话分支元数据信息。 */
export interface BranchInfo {
  /** 分支唯一标识。 */
  branchId: string;
  /** 分支切点记录 ID（主分支 main 为根节点 ID）。 */
  baseRecordId: string;
  /** 分支当前最新叶子节点 ID。 */
  leafRecordId: string;
  /** 分支创建时间（若无记录则为首条记录时间）。 */
  createdAt: number;
  /** 是否为当前活动分支。 */
  isActive: boolean;
  /** 沿该分支因果链回溯的总消息数。 */
  messageCount: number;
}

/** MessageStore 的可选状态能力；旧 SDK Store 不需要实现，宿主据此降级持久压缩。 */
export interface StatefulMessageStore extends MessageStore {
  appendRecord(
    type: Exclude<SessionRecordType, 'header' | 'message'>,
    payload: Record<string, unknown>,
    options?: { branchId?: string; parentId?: string },
  ): Promise<SessionRecord>;
  loadState(options?: { branchId?: string }): Promise<SessionState>;
}

const types = new Set<SessionRecordType>([
  'header',
  'message',
  'run_started',
  'run_finished',
  'message_state',
  'history_repair',
  'usage',
  'checkpoint',
  'context_pruned',
  'compaction_state',
  'title',
  'reset',
  'legacy_import',
  'branch_created',
  'branch_selected',
  'branch_summary',
  'archive_state',
]);

/** 判断 Store 是否支持版本化状态；不读取数据或改变旧 Store。 */
export function supportsSessionState(store: MessageStore): store is StatefulMessageStore {
  return (
    'appendRecord' in store &&
    typeof store.appendRecord === 'function' &&
    'loadState' in store &&
    typeof store.loadState === 'function'
  );
}

/**
 * 校验目标切点是否处于完整闭合的工具事务边界。
 *
 * 保证与约束：
 * - 沿目标切点因果链从根至切点按因果顺序扫描；
 * - 若因果链中包含发起了 tool_use 的 assistant 消息，必须紧随其后且在切点之前包含全部对应的 tool_result 结果；
 * - 若切点位于未闭合工具事务的内部（包括发起 tool_use 的 assistant 自身，或仅回填了部分工具结果的 tool 消息），
 *   抛出 `UNCLOSED_TOOL_TRANSACTION_FORK` 错误拒绝分叉；
 * - 绝不依赖推测修复，保护持久化分支树的历史闭合不变量。
 *
 * @param records 会话中所有可用记录列表
 * @param targetRecordId 切点记录唯一标识
 * @throws {KapibalaError} 当切点位于未闭合工具事务内部或切点不存在时
 */
export function assertClosedToolTransaction(
  records: SessionRecord[],
  targetRecordId: string,
): void {
  const recordMap = new Map<string, SessionRecord>(records.map((r) => [r.recordId, r]));
  const targetRecord = recordMap.get(targetRecordId);
  if (!targetRecord) {
    throw new Error(`Target record not found: ${targetRecordId}`);
  }

  // 严格拦截全局控制记录（title/usage 等非 header 控制记录）作为分支切点（N3）
  if (targetRecord.type !== 'header' && isGlobalControlRecordType(targetRecord.type)) {
    throw new KapibalaError(
      `Cannot fork or branch from a global control record: ${targetRecord.type}`,
      {
        code: 'INVALID_FORK_POINT',
        safeMessage: '无法在全局控制记录处创建分支或派生会话',
      },
    );
  }

  // 沿 parentId 回溯收集切点因果链
  const causalChain: SessionRecord[] = [];
  let curr: string | null = targetRecordId;
  while (curr) {
    const rec = recordMap.get(curr);
    if (!rec) break;
    causalChain.push(rec);
    curr = rec.parentId;
  }
  causalChain.reverse();

  const pendingToolCalls = new Set<string>();

  for (const rec of causalChain) {
    // 识别崩溃恢复的 history_repair 记录并闭合悬挂工具调用（N2）
    if (rec.type === 'history_repair') {
      const payload = rec.payload as unknown as { toolCallId?: string };
      if (payload && typeof payload.toolCallId === 'string') {
        pendingToolCalls.delete(payload.toolCallId);
      }
      continue;
    }

    if (rec.type === 'message') {
      const payload = rec.payload as unknown as CanonicalMessage;
      if (payload.role === 'assistant') {
        if (pendingToolCalls.size > 0) {
          throw new KapibalaError('Cannot fork or branch from an unclosed tool transaction', {
            code: 'UNCLOSED_TOOL_TRANSACTION_FORK',
            safeMessage: '无法在未闭合工具事务处创建分支或派生会话',
          });
        }
        if (Array.isArray(payload.content)) {
          for (const block of payload.content) {
            if (block.type === 'tool_use' && typeof block.id === 'string') {
              pendingToolCalls.add(block.id);
            }
          }
        }
      } else if (payload.role === 'tool') {
        if (Array.isArray(payload.content)) {
          for (const block of payload.content) {
            if (block.type === 'tool_result' && typeof block.toolUseId === 'string') {
              pendingToolCalls.delete(block.toolUseId);
            }
          }
        }
        if (typeof (payload as any).tool_call_id === 'string') {
          pendingToolCalls.delete((payload as any).tool_call_id);
        }
      } else if (payload.role === 'user') {
        if (pendingToolCalls.size > 0) {
          throw new KapibalaError('Cannot fork or branch from an unclosed tool transaction', {
            code: 'UNCLOSED_TOOL_TRANSACTION_FORK',
            safeMessage: '无法在未闭合工具事务处创建分支或派生会话',
          });
        }
      }
    }
  }

  if (pendingToolCalls.size > 0) {
    throw new KapibalaError('Cannot fork or branch from an unclosed tool transaction', {
      code: 'UNCLOSED_TOOL_TRANSACTION_FORK',
      safeMessage: '无法在未闭合工具事务处创建分支或派生会话',
    });
  }
}

/**
 * 版本化消息与上下文状态的单文件存储。所有写入串行并 fsync，失败后拒绝继续写入。
 * 调用者须在打开前取得单写者锁；本类不允许静默跳过中部损坏或重复身份。
 */
export class SessionStore implements StatefulMessageStore {
  readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private records: SessionRecord[] = [];
  private observer?: (record: SessionRecord) => void;
  private onDiagnostic?: (message: string) => void;
  private stamp?: { size: number; mtimeMs: number; ino: number };
  private schemaVersion: number = SESSION_SCHEMA_VERSION_V2;
  private activeBranchId = 'main';
  private branchLeaves = new Map<string, string>();

  private constructor(filePath: string, schemaVersion = SESSION_SCHEMA_VERSION_V2) {
    this.filePath = path.resolve(filePath);
    this.schemaVersion = schemaVersion;
  }

  /** 获取当前会话文件使用的 Schema 版本（1 或 2）。 */
  getSchemaVersion(): number {
    return this.schemaVersion;
  }

  /** 判断当前会话是否为只读历史（v1 历史文件强制只读）。 */
  isReadOnly(): boolean {
    return this.schemaVersion === SESSION_SCHEMA_VERSION_V1;
  }

  /** 获取当前选中的活动分支标识。 */
  getActiveBranchId(): string {
    return this.activeBranchId;
  }

  /** 获取所有分支当前叶子记录 ID 映射快照。 */
  getBranchLeaves(): ReadonlyMap<string, string> {
    return new Map(this.branchLeaves);
  }

  /** 注册可重建缓存的写后通知；缓存失败只诊断，不撤销或毒化已 fsync 的正文。 */
  setAppendObserver(
    observer: (record: SessionRecord) => void,
    onDiagnostic?: (message: string) => void,
  ): void {
    this.observer = observer;
    this.onDiagnostic = onDiagnostic;
  }

  /** 以独占创建方式安装新头部（默认生成 Schema v2 格式），已有文件明确失败，绝不覆盖其它会话。 */
  static async create(filePath: string, header: SessionHeader): Promise<SessionStore> {
    const store = new SessionStore(filePath, SESSION_SCHEMA_VERSION_V2);
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
    const record = store.makeRecord('header', {
      ...header,
      createdAt: header.createdAt ?? Date.now(),
    });
    const fd = fs.openSync(store.filePath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    syncSessionDirectory(path.dirname(store.filePath));
    store.records = [record];
    store.branchLeaves.set('main', record.recordId);
    store.refreshStamp();
    return store;
  }

  /** 打开并验证已有会话；尾部残片先保存到隔离文件，中部损坏与未知版本拒绝恢复。 */
  static async open(filePath: string): Promise<SessionStore> {
    const store = new SessionStore(filePath);
    store.records = store.readFile(true);
    store.refreshStamp();
    return store;
  }

  /** 获取完整记录快照，等候已排队写入后读取；调用者不能借此修改内部记录。 */
  async readRecords(): Promise<SessionRecord[]> {
    // 写失败毒化只应拒绝后续追加；读取必须继续可用，否则释放锁前的回读会把
    // 瞬时存储故障放大成「锁无法释放、活进程内会话被永久占用」。
    await this.queue.catch(() => undefined);
    this.records = this.readFile(false);
    this.refreshStamp();
    return structuredClone(this.records);
  }

  /** 消息级持久化，补稳定身份并保留所有终态字段，成功后方可进入下一次写入。 */
  async append(
    message: CanonicalMessage,
    options?: { branchId?: string; parentId?: string },
  ): Promise<void> {
    validateProtocolContent(message.content);
    const payload = { ...structuredClone(message), id: message.id ?? createMessageId() };
    await this.enqueue('message', payload, options);
    // 为已有 SDK 以同一对象进入内存历史的模式补身份；正文始终独立复制。
    message.id ??= payload.id;
  }

  /** 持久化状态记录，fsync 成功才返回；失败会毒化当前写者，要求重新验证后恢复。 */
  async appendRecord(
    type: Exclude<SessionRecordType, 'header' | 'message'>,
    payload: Record<string, unknown>,
    options?: { branchId?: string; parentId?: string },
  ): Promise<SessionRecord> {
    return this.enqueue(type, structuredClone(payload), options);
  }

  /**
   * 创建新分支记录并推进分支叶子。
   *
   * 约束：
   * - 分支标识必须符合命名规范（字母、数字、下划线、短横线）；
   * - 目标分支必须不存在；
   * - 切点记录 baseRecordId 必须为正文中已存在的合法记录；
   * - 拒绝未闭合工具事务分叉：因果链上不得包含未全部回填 tool_result 的工具调用；
   * - v1 历史会话禁止创建分支。
   */
  async createBranch(branchId: string, baseRecordId: string): Promise<SessionRecord> {
    if (!branchId || typeof branchId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(branchId)) {
      throw new Error(
        'Branch ID must be a non-empty string containing only alphanumeric, hyphen or underscore characters',
      );
    }
    if (this.branchLeaves.has(branchId)) {
      throw new Error(`Branch already exists: ${branchId}`);
    }
    const baseRecord = this.records.find((r) => r.recordId === baseRecordId);
    if (!baseRecord) {
      throw new Error(`Base record not found: ${baseRecordId}`);
    }

    // 拒绝未闭合工具事务分叉
    assertClosedToolTransaction(this.records, baseRecordId);

    return this.appendRecord('branch_created', { branchId, baseRecordId });
  }

  /**
   * 切换活动分支并持久化记录。
   *
   * 约束：
   * - 目标分支必须已被创建或存在；
   * - v1 历史会话禁止切换分支。
   */
  async selectBranch(branchId: string): Promise<SessionRecord> {
    if (!branchId || typeof branchId !== 'string') {
      throw new Error('Branch ID must be a non-empty string');
    }
    if (!this.branchLeaves.has(branchId)) {
      throw new Error(`Branch not found: ${branchId}`);
    }
    return this.appendRecord('branch_selected', { branchId });
  }

  /**
   * 追加逻辑归档控制记录。
   *
   * 约束：
   * - 归档状态记录为全局控制记录（parentId 为 null，不推进分支上下文叶子）；
   * - payload 结构为 { archived: boolean }；
   * - v1 历史会话禁止变更归档状态。
   */
  async setArchiveState(archived: boolean): Promise<SessionRecord> {
    if (this.isReadOnly()) {
      throw new KapibalaError('Cannot modify archive state of legacy v1 session', {
        code: 'LEGACY_SESSION_READ_ONLY',
        safeMessage: '无法变更只读历史会话的归档状态',
      });
    }
    return this.appendRecord('archive_state', { archived });
  }

  /**
   * 查询当前会话是否处于已归档状态。
   */
  async isArchived(): Promise<boolean> {
    const all = await this.readRecords();
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].type === 'archive_state') {
        return Boolean(all[i].payload.archived);
      }
    }
    return false;
  }

  /**
   * 获取当前会话中所有已知分支的元数据与状态列表。
   */
  async getBranches(): Promise<BranchInfo[]> {
    const all = await this.readRecords();
    const headerRecord = all[0];
    const branchCreationMap = new Map<string, { baseRecordId: string; createdAt: number }>();
    branchCreationMap.set(MAIN_BRANCH_ID, {
      baseRecordId: headerRecord.recordId,
      createdAt:
        (headerRecord.payload as unknown as SessionHeader).createdAt ?? headerRecord.timestamp,
    });

    for (const rec of all) {
      if (rec.type === 'branch_created') {
        const bId = rec.payload.branchId as string;
        const baseId = rec.payload.baseRecordId as string;
        if (bId && baseId && !branchCreationMap.has(bId)) {
          branchCreationMap.set(bId, {
            baseRecordId: baseId,
            createdAt: rec.timestamp,
          });
        }
      }
    }

    const branches: BranchInfo[] = [];
    const map = new Map<string, SessionRecord>();
    for (const r of all) map.set(r.recordId, r);

    for (const [bId, leafId] of this.branchLeaves.entries()) {
      const meta = branchCreationMap.get(bId) ?? {
        baseRecordId: headerRecord.recordId,
        createdAt: headerRecord.timestamp,
      };

      // 统计该分支因果链上的消息数
      let messageCount = 0;
      let curr: string | null = leafId;
      while (curr) {
        const r = map.get(curr);
        if (!r) break;
        if (r.type === 'message') messageCount++;
        if (r.type === 'reset') break;
        curr = r.parentId;
      }

      branches.push({
        branchId: bId,
        baseRecordId: meta.baseRecordId,
        leafRecordId: leafId,
        createdAt: meta.createdAt,
        isActive: bId === this.activeBranchId,
        messageCount,
      });
    }

    return branches;
  }

  /** 重建指定分支（默认当前活动分支）reset 后的状态视图。 */
  async loadState(options?: { branchId?: string }): Promise<SessionState> {
    const all = await this.readRecords();
    const branchId = options?.branchId ?? this.activeBranchId;
    const targetLeafId = this.branchLeaves.get(branchId) ?? all[0].recordId;

    const recordMap = new Map<string, SessionRecord>();
    for (const r of all) {
      recordMap.set(r.recordId, r);
    }

    // 收集目标分支因果链上的所有记录 ID
    const chainIds = new Set<string>();
    let currId: string | null = targetLeafId;
    while (currId) {
      chainIds.add(currId);
      const rec = recordMap.get(currId);
      if (!rec) break;
      currId = rec.parentId;
    }

    // 找到当前分支因果链上最近的有效 reset 序号
    let resetSeq = -1;
    for (const r of all) {
      if (r.type === 'reset' && chainIds.has(r.recordId)) {
        resetSeq = r.seq ?? all.indexOf(r);
      }
    }

    // 筛选当前分支的有效记录：
    // 1. 位于当前分支最近 reset 之后；
    // 2. 属于当前分支因果链，或者是全局控制记录（如 usage、title、archive_state 等，排除 header）
    const records = all.filter((r) => {
      const seq = r.seq ?? all.indexOf(r);
      if (seq <= resetSeq) return false;
      if (r.type === 'header') return false;
      if (chainIds.has(r.recordId)) return true;
      if (isGlobalControlRecordType(r.type)) return true;
      return false;
    });

    const content = records
      .filter((r) =>
        ['message', 'history_repair', 'message_state', 'reset', 'branch_summary'].includes(r.type),
      )
      .at(-1);
    const lastRecord = all.at(-1);

    return {
      header: structuredClone(all[0].payload) as unknown as SessionHeader,
      records,
      contentRevision: content?.recordId ?? all[0].recordId,
      logRevision: lastRecord?.recordId ?? all[0].recordId,
      activeBranchId: this.activeBranchId,
      activeLeafId: this.branchLeaves.get(this.activeBranchId) ?? null,
      branchLeaves: new Map(this.branchLeaves),
      schemaVersion: this.schemaVersion,
    };
  }

  /**
   * 沿因果 parentId 链从叶子节点回溯，生成合法线性消息序列投影。
   *
   * 保证与约束：
   * - 仅包含回溯因果链上的消息与状态叠加，全局控制记录与其他分支记录被天然隔离；
   * - 支持 reset 边界截断与 history_repair 幂等叠加；
   * - 严格校验工具事务闭合不变量，拒绝半事务破坏；
   * - 修复缺失结果时自动持久化 history_repair（v2 下在目标分支上记录）。
   */
  async buildProjection(options?: {
    branchId?: string;
    leafRecordId?: string;
  }): Promise<CanonicalMessage[]> {
    const all = await this.readRecords();
    const branchId = options?.branchId ?? this.activeBranchId;
    const targetLeafId =
      options?.leafRecordId ?? this.branchLeaves.get(branchId) ?? all[0].recordId;

    const recordMap = new Map<string, SessionRecord>();
    for (const r of all) {
      recordMap.set(r.recordId, r);
    }

    if (!recordMap.has(targetLeafId)) {
      throw new Error(`Target leaf record not found: ${targetLeafId}`);
    }

    // 沿 parentId 回溯收集因果链
    const chain: SessionRecord[] = [];
    let currId: string | null = targetLeafId;
    while (currId) {
      const rec = recordMap.get(currId);
      if (!rec) {
        throw new Error(`Broken causal chain: record ${currId} not found`);
      }
      chain.push(rec);
      currId = rec.parentId;
    }
    chain.reverse();

    // 处理 reset 边界截断
    const lastResetIndex = chain.map((r) => r.type).lastIndexOf('reset');
    const activeRecords = chain.slice(Math.max(1, lastResetIndex + 1));

    // 提取正文消息（含 branch_summary 背景注入）并叠加 message_state
    const raw: CanonicalMessage[] = [];
    for (const record of activeRecords) {
      if (record.type === 'message') {
        raw.push(structuredClone(record.payload) as unknown as CanonicalMessage);
      } else if (record.type === 'branch_summary') {
        const summaryText =
          typeof record.payload.summary === 'string' ? record.payload.summary : '';
        if (summaryText) {
          raw.push({
            id: `summary-${record.recordId}`,
            role: 'system',
            timestamp: record.timestamp,
            content: [{ type: 'text', text: `[分支上下文背景摘要]\n${summaryText}` }],
          });
        }
      }
    }

    for (const record of activeRecords.filter((r) => r.type === 'message_state')) {
      const message = raw.find((m) => m.id === record.payload.messageId);
      if (message) {
        message.state = record.payload.state as CanonicalMessage['state'];
      }
    }

    // 叠加已有的 history_repair
    const repairs = activeRecords
      .filter((r) => r.type === 'history_repair')
      .map((r) => r.payload as unknown as HistoryRepair);

    const overlay = () => {
      const messages: CanonicalMessage[] = [];
      for (let i = 0; i < raw.length; i++) {
        const message = raw[i];
        messages.push(message);
        if (message.role !== 'assistant') continue;
        const associated = repairs.filter((r) => r.assistantId === message.id);
        if (!associated.length) continue;
        const realIds = new Set<string>();
        while (raw[i + 1]?.role === 'tool') {
          const tool = raw[++i];
          messages.push(tool);
          for (const b of tool.content) {
            if (b.type === 'tool_result') realIds.add(b.toolUseId);
          }
        }
        const missing = associated.filter((r) => !realIds.has(r.toolCallId));
        if (missing.length) {
          messages.push({
            id: `repair-${message.id}`,
            role: 'tool',
            timestamp: message.timestamp,
            content: missing.map((r) => structuredClone(r.result)),
          });
        }
      }
      return messages;
    };

    const normalized = normalizeHistory(overlay());
    for (const repair of normalized.repairs) {
      if (
        !repairs.some(
          (r) => r.assistantId === repair.assistantId && r.toolCallId === repair.toolCallId,
        )
      ) {
        if (!this.isReadOnly()) {
          await this.appendRecord('history_repair', { ...repair }, { branchId });
        }
        repairs.push(repair);
      }
    }
    return overlay();
  }

  /**
   * 恢复当前活动分支的原始正文，并将幂等修复叠加到原工具事务。
   */
  async load(): Promise<CanonicalMessage[]> {
    return this.buildProjection({ branchId: this.activeBranchId });
  }

  /** SDK 清空语义通过持久边界实现；此前摘要、剪裁及失败状态不再参与恢复。 */
  async clear(): Promise<void> {
    await this.appendRecord('reset', {});
  }

  /**
   * 生成 Envelope 记录。
   * v2 下严格维护连续物理序号 seq、物理前驱 prevRecordId 与因果 parentId / branchId。
   */
  private makeRecord(
    type: SessionRecordType,
    payload: Record<string, unknown>,
    options?: { branchId?: string; parentId?: string },
  ): SessionRecord {
    if (this.schemaVersion === SESSION_SCHEMA_VERSION_V1) {
      throw new KapibalaError('Legacy v1 session is read-only; upgrade to v2 copy first', {
        code: 'LEGACY_SESSION_READ_ONLY',
        retryPolicy: 'after_user_action',
        safeMessage: 'v1 历史会话为只读模式，请先升级为 v2 副本',
      });
    }

    const recordId = createMessageId();
    const timestamp = Date.now();
    const seq = this.records.length;
    const prevRecordId = this.records.at(-1)?.recordId ?? null;

    let parentId: string | null = null;
    let branchId: string | null = null;

    if (!isGlobalControlRecordType(type)) {
      branchId = options?.branchId ?? this.activeBranchId;
      parentId =
        options?.parentId ?? this.branchLeaves.get(branchId) ?? this.records[0]?.recordId ?? null;
    }

    return {
      schemaVersion: SESSION_SCHEMA_VERSION_V2,
      type,
      recordId,
      timestamp,
      seq,
      prevRecordId,
      parentId,
      branchId,
      payload,
    };
  }

  /** 单写者队列不吞异常；后续写入依赖同一失败 Promise，防止继续污染正文。 */
  private enqueue(
    type: SessionRecordType,
    payload: Record<string, unknown>,
    options?: { branchId?: string; parentId?: string },
  ): Promise<SessionRecord> {
    const operation = this.queue.then(() => {
      if (
        type === 'message' &&
        this.records.some((r) => r.type === 'message' && r.payload.id === payload.id)
      ) {
        throw new Error(`Duplicate message ID: ${payload.id}`);
      }
      const stat = fs.statSync(this.filePath);
      if (
        !this.stamp ||
        stat.size !== this.stamp.size ||
        stat.mtimeMs !== this.stamp.mtimeMs ||
        stat.ino !== this.stamp.ino
      )
        throw new Error('Session changed outside this writer; reopen under a lock');
      const record = this.makeRecord(type, payload, options);
      const fd = fs.openSync(this.filePath, 'a');
      try {
        fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.records.push(record);

      // 同步内存中的分支叶子与选中的分支状态
      if (isGlobalControlRecordType(type)) {
        if (type === 'branch_created') {
          const bId = payload.branchId as string;
          const baseId = payload.baseRecordId as string;
          this.branchLeaves.set(bId, baseId);
        } else if (type === 'branch_selected') {
          this.activeBranchId = payload.branchId as string;
        }
      } else {
        const bId = record.branchId ?? this.activeBranchId;
        this.branchLeaves.set(bId, record.recordId);
      }

      this.refreshStamp();
      try {
        this.observer?.(structuredClone(record));
      } catch {
        try {
          this.onDiagnostic?.('Session metadata update failed; the durable record is preserved');
        } catch {
          /* 诊断不影响正文。 */
        }
      }
      return structuredClone(record);
    });
    this.queue = operation;
    return operation;
  }

  /** 保存当前写者的正文版本，拒绝未经锁保护的第二写者继续追加。 */
  private refreshStamp(): void {
    const stat = fs.statSync(this.filePath);
    this.stamp = { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
  }

  /** 校验每个完整记录，只有最后非空行的 JSON 残片可隔离，语义损坏绝不作为残片吞掉。 */
  private readFile(recover: boolean): SessionRecord[] {
    const iterator = readJsonlLines(this.filePath);
    let lastTerminated = true;
    let blankSeen = false;
    const records: SessionRecord[] = [];
    const identities = new Set<string>();
    const messages = new Set<string>();
    this.branchLeaves.clear();
    this.activeBranchId = MAIN_BRANCH_ID;
    let detectedSchemaVersion: number | null = null;

    let i = -1;
    for (const line of iterator) {
      i++;
      lastTerminated = line.terminated;
      if (!line.text.trim()) {
        blankSeen = true;
        continue;
      }
      if (blankSeen) throw new Error(`Session corrupt at line ${i + 1}`);
      let record: SessionRecord;
      try {
        record = JSON.parse(line.text);
      } catch {
        if (
          !recover ||
          this.schemaVersion === SESSION_SCHEMA_VERSION_V1 ||
          !records.length ||
          Array.from(iterator).some((next) => next.text.trim())
        )
          throw new Error(`Session corrupt at line ${i + 1}`);
        fs.writeFileSync(
          `${this.filePath}.corrupt-${createMessageId()}`,
          line.text + (line.terminated ? '\n' : ''),
          { flag: 'wx' },
        );
        const fd = fs.openSync(this.filePath, 'r+');
        try {
          fs.ftruncateSync(fd, line.offset);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        break;
      }

      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error(`Session corrupt at line ${i + 1}`);
      }

      if (detectedSchemaVersion === null) {
        if (
          record.schemaVersion !== SESSION_SCHEMA_VERSION_V1 &&
          record.schemaVersion !== SESSION_SCHEMA_VERSION_V2
        ) {
          throw new Error('Unsupported session schema version');
        }
        detectedSchemaVersion = record.schemaVersion;
        this.schemaVersion = detectedSchemaVersion;
      } else if (record.schemaVersion !== detectedSchemaVersion) {
        throw new Error(`Session corrupt schema version mismatch at line ${i + 1}`);
      }

      if (
        !types.has(record.type) ||
        typeof record.recordId !== 'string' ||
        !record.recordId ||
        !Number.isFinite(record.timestamp) ||
        !record.payload ||
        typeof record.payload !== 'object' ||
        Array.isArray(record.payload)
      ) {
        throw new Error(`Session corrupt at line ${i + 1}`);
      }

      if (identities.has(record.recordId)) {
        throw new Error(`Duplicate record ID: ${record.recordId}`);
      }

      if (records.length === 0) {
        if (
          record.type !== 'header' ||
          typeof record.payload.conversationId !== 'string' ||
          typeof record.payload.projectRoot !== 'string' ||
          typeof record.payload.initialCwd !== 'string'
        ) {
          throw new Error('Session corrupt header');
        }
      } else if (record.type === 'header') {
        throw new Error('Session corrupt: repeated header');
      }

      if (this.schemaVersion === SESSION_SCHEMA_VERSION_V1) {
        if (record.parentId !== (records.at(-1)?.recordId ?? null)) {
          throw new Error(`Session corrupt parent at line ${i + 1}`);
        }
        this.branchLeaves.set(MAIN_BRANCH_ID, record.recordId);
      } else {
        // v2 Schema 约束与校验
        if (typeof record.seq !== 'number' || record.seq !== records.length) {
          throw new Error(`Session corrupt seq at line ${i + 1}`);
        }
        const expectedPrev = records.at(-1)?.recordId ?? null;
        if (record.prevRecordId !== expectedPrev) {
          throw new Error(`Session corrupt prevRecordId at line ${i + 1}`);
        }

        if (isGlobalControlRecordType(record.type)) {
          if (record.parentId !== null) {
            throw new Error(`Session corrupt control record parent at line ${i + 1}`);
          }
          if (record.type === 'header') {
            this.branchLeaves.set(MAIN_BRANCH_ID, record.recordId);
            this.activeBranchId = MAIN_BRANCH_ID;
          } else if (record.type === 'branch_created') {
            const bId = record.payload.branchId;
            const baseId = record.payload.baseRecordId;
            if (typeof bId !== 'string' || !bId) {
              throw new Error(`Session corrupt branch_created branchId at line ${i + 1}`);
            }
            if (this.branchLeaves.has(bId)) {
              throw new Error(`Duplicate branch ID: ${bId}`);
            }
            if (typeof baseId !== 'string' || !identities.has(baseId)) {
              throw new Error(`Session corrupt branch_created baseRecordId at line ${i + 1}`);
            }
            this.branchLeaves.set(bId, baseId);
          } else if (record.type === 'branch_selected') {
            const bId = record.payload.branchId;
            if (typeof bId !== 'string' || !this.branchLeaves.has(bId)) {
              throw new Error(`Selected branch not found: ${bId}`);
            }
            this.activeBranchId = bId;
          }
        } else {
          // 分支记录
          const bId = record.branchId;
          if (typeof bId !== 'string' || !this.branchLeaves.has(bId)) {
            throw new Error(`Session corrupt branchId at line ${i + 1}`);
          }
          if (typeof record.parentId !== 'string' || !identities.has(record.parentId)) {
            throw new Error(`Session corrupt parent at line ${i + 1}`);
          }
          this.branchLeaves.set(bId, record.recordId);
        }
      }

      identities.add(record.recordId);
      if (record.type === 'message') {
        if (
          typeof record.payload.id !== 'string' ||
          !['user', 'assistant', 'system', 'tool'].includes(String(record.payload.role)) ||
          !Array.isArray(record.payload.content)
        ) {
          throw new Error(`Session corrupt message at line ${i + 1}`);
        }
        if (messages.has(record.payload.id)) {
          throw new Error(`Duplicate message ID: ${record.payload.id}`);
        }
        messages.add(record.payload.id);
        validateProtocolContent(record.payload.content as ContentBlock[]);
      }
      records.push(record);
    }

    if (!records.length) {
      throw new Error('Session corrupt header');
    }

    if (
      recover &&
      !lastTerminated &&
      records.length === i + 1 &&
      this.schemaVersion !== SESSION_SCHEMA_VERSION_V1
    ) {
      const fd = fs.openSync(this.filePath, 'a');
      try {
        fs.writeFileSync(fd, '\n');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    return records;
  }
}
