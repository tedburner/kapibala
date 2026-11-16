/**
 * @fileoverview 跨会话引用的只读读取（SessionReferenceReader）与引用预算常量。
 *
 * 约束、边界与为什么：
 * 1. 只读：只做 `fs` 读取与 JSONL 解析，不建目录、不写 sidecar、不取 SessionLock；
 *    源会话的压缩、归档或删除都不影响已冻结的引用内容。
 * 2. 桶校验：请求的 projectRoot 先经 `fs.realpathSync.native` 规范化，再与源会话 header.projectRoot
 *    比较；不一致即拒绝。跨项目桶引用会绕过项目信任模型，本版明确不做。
 * 3. 零工具重放：只取 user / assistant 的 `text` 块与 `branch_summary` 摘要，
 *    `tool_use` / `tool_result` / `thinking` / `redacted_thinking` / `provider_state` 一律丢弃；
 *    位于未闭合工具事务中的记录不会被引用，避免把别人的工具调用带进当前会话。
 * 4. 双单位预算：每条正文同时受字符与 UTF-8 字节上限约束（CJK 每字约 3 字节），
 *    裁剪按角色取头部或尾部，且不劈开代理对与多字节字符。
 * 5. 默认脱敏：快照阶段的正文先脱敏再计算长度与摘要，用户引用的是内容，不是凭证。
 * 6. 读取预算：复用 `readJsonlLines` / `maxReadBytes`，不为引用另开无界读路径。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReferenceError } from '../errors/index.js';
import type { CanonicalMessage, ContentBlock } from '../types/index.js';
import { readJsonlLines } from './jsonl-lines.js';
import { sanitizeSessionTitle } from './session-manager.js';
import { MAIN_BRANCH_ID, type SessionHeader, type SessionRecord } from './session-store.js';
import { computeProjectKey, isSamePath, toNativePhysicalPath } from './workspace.js';

/** 单轮引用的消息条数上限；超过按 REFERENCE_BUDGET_EXCEEDED 拒绝。 */
export const MAX_REFERENCE_RECORDS_PER_RUN = 8;

/** 单轮引用的源会话数上限；由引用块装配层统一校验。 */
export const MAX_REFERENCE_SESSIONS_PER_RUN = 3;

/** 单条引用正文的字符上限（Unicode code point）。 */
export const MAX_REFERENCE_CHARS_PER_RECORD = 4000;

/** 单条引用正文的 UTF-8 字节上限；必须与字符上限同时满足。 */
export const MAX_REFERENCE_BYTES_PER_RECORD = 8000;

/** 单轮引用正文的总字符上限；引用块装配层与单次读取都以此为准。 */
export const MAX_REFERENCE_CHARS_PER_RUN = 16000;

/** 单轮引用正文的总 UTF-8 字节上限。 */
export const MAX_REFERENCE_BYTES_PER_RUN = 32000;

/** 会话级引用默认取最近 6 条可见消息。 */
export const DEFAULT_REFERENCE_RECORD_LIMIT = 6;

/** 会话级引用单次最多取 12 条可见消息。 */
export const MAX_REFERENCE_RECORD_LIMIT = 12;

/** 候选列表允许扫描的单文件上限；超出按不可读跳过，避免菜单被超大会话拖成全量读盘。 */
const MAX_REFERENCE_SCAN_BYTES = 8 * 1024 * 1024;

/** 引用正文被裁剪时插入的固定标记；正文按角色取头部或尾部，标记放在被裁掉的一侧。 */
const TRUNCATION_MARKER = (originalChars: number) =>
  `…（引用内容已裁剪，原文共 ${originalChars} 字符）…`;

/** 可作为引用来源的角色；工具与系统内容不在白名单内。 */
export type ReferenceSourceRole = 'user' | 'assistant' | 'branch_summary';

/**
 * 一次引用读取请求。
 *
 * 约束：
 * - `projectRoot` 必须是绝对路径，用于与源会话 header 做物理身份比较；
 * - `recordIds` 给出时为消息级读取（最多 8 条），省略时为会话级尾部取样；
 * - `branchId` 省略时取源会话的活动分支；未知分支按记录不在该分支处理并明确失败。
 */
export interface ReferenceReadRequest {
  /** 当前会话所属项目根（绝对路径）；与源会话 header.projectRoot 做 native realpath 比较。 */
  projectRoot: string;
  /** 源会话 ID，支持唯一前缀；前缀歧义按找不到处理。 */
  sessionId: string;
  /** 消息级：精确读取这些 recordId（≤8）。缺省时按会话级读取。 */
  recordIds?: readonly string[];
  /** 分支；缺省取源会话活动分支。 */
  branchId?: string;
  /** 会话级读取条数（默认 6，范围 1–12）；消息级读取忽略该值。 */
  limit?: number;
  /** 单条正文硬上限（字符，默认 4000，最大 4000）。 */
  maxCharsPerRecord?: number;
}

/** 单条可见消息的冻结快照；正文已脱敏、已按预算裁剪。 */
export interface ReferenceRecordSnapshot {
  /** 源记录 ID。 */
  readonly recordId: string;
  /** 源角色；tool / thinking 等不可见内容不会出现在快照里。 */
  readonly role: ReferenceSourceRole;
  /** 读取时使用的源分支 ID。 */
  readonly branchId: string;
  /** 源记录时间戳（毫秒）。 */
  readonly timestamp: number;
  /** 已脱敏、已裁剪的正文。 */
  readonly text: string;
  /** 正文是否被裁剪；为真时正文含固定裁剪标记。 */
  readonly truncated: boolean;
}

/** 读取结果；`partial` 说明为何未取全（多条原因以逗号连接）。 */
export interface ReferenceReadResult {
  /** 源会话 ID。 */
  readonly sessionId: string;
  /** 源会话标题快照（已脱敏、已截断）；源会话没有可用标题时缺省。 */
  readonly title?: string;
  /** 本次读取使用的源分支 ID。 */
  readonly branchId: string;
  /** 按时间正序排列的快照；可能因半事务或不可见内容少于请求条数。 */
  readonly records: readonly ReferenceRecordSnapshot[];
  /** 未取全的原因：corrupt_line_skipped / unclosed_tool_transaction / tool_blocks_stripped。 */
  readonly partial?: string;
}

/** 供 CLI / 桌面 picker 使用的会话级候选；已归档会话不出现。 */
export interface ReferenceSessionCandidate {
  /** 源会话 ID。 */
  readonly sessionId: string;
  /** 标题快照（已脱敏、已截断）。 */
  readonly title: string;
  /** 最后活动时间（毫秒）。 */
  readonly lastActivityAt: number;
  /** 消息条数。 */
  readonly messageCount: number;
  /** 是否为保留型委派会话；header 尚未写入该标记时为 false。 */
  readonly delegation: boolean;
}

/** 会话级候选查询参数。 */
export interface ReferenceCandidateRequest {
  /** 当前会话所属项目根（绝对路径）；只在该项目桶内列候选。 */
  projectRoot: string;
  /** 返回条数上限（默认 20，范围 1–100）。 */
  limit?: number;
}

/** 读取器配置；默认扫描 `~/.kapibala/sessions`，与 SessionManager 同源。 */
export interface ReferenceReaderOptions {
  /** 会话全局存储根目录（缺省为 ~/.kapibala/sessions）。 */
  sessionsDir?: string;
  /** 用户主目录（用于测试隔离）。 */
  homeDirectory?: string;
  /** 诊断回调；只用于损坏行与被跳过记录，不改变返回语义。 */
  onDiagnostic?: (message: string) => void;
}

/** 读取器可选的单文件字节预算；省略时保持与 SessionManager 相同的无总量上限行为。 */
export interface ReferenceReaderReadBudget {
  /** 单文件编码字节总量上限；超限抛 HISTORY_READ_LIMIT，而不是把文件当成损坏。 */
  maxReadBytes?: number;
}

/** 扫描结果：一次读取内复用的会话视图，不写回任何缓存。 */
interface ScannedSession {
  readonly header: SessionHeader;
  readonly headerRecord: SessionRecord;
  readonly records: readonly SessionRecord[];
  readonly activeBranchId: string;
  readonly branchLeaves: ReadonlyMap<string, string>;
  readonly archived: boolean;
  readonly title: string;
  readonly messageCount: number;
  readonly lastActivityAt: number;
  /** 是否跳过了无法解析的行；只用于 partial 说明。 */
  readonly corruptLineSkipped: boolean;
}

/** 因果链上的一条可见记录；只保存候选，不保存工具或思考块。 */
interface VisibleRow {
  readonly record: SessionRecord;
  readonly role: ReferenceSourceRole;
  readonly text: string;
  /** 源消息含被剥离的非文本块。 */
  readonly strippedNonText: boolean;
  /** 该记录上仍敞开、且在分支叶之前从未闭合的工具调用 ID。 */
  readonly unclosedToolCalls: readonly string[];
  /** 在因果链中的位置，用于恢复时间顺序。 */
  readonly order: number;
}

/**
 * 跨会话引用的只读读取器。
 *
 * 保证：
 * - 只读：不取 SessionLock、不建目录、不写 sidecar，可与其他写者并发使用；
 * - 桶隔离：只在请求项目根对应的桶目录内解析，header 身份不符即拒绝；
 * - 内容白名单：只返回 user / assistant 正文与分支摘要，零工具重放；
 * - 失败明确：找不到、跨桶、已归档、记录不存在或不可见都以稳定错误码失败，不静默降级。
 *
 * 不做什么：
 * - 不做活引用，不缓存结果，不建立引用关系图；
 * - 不校验源会话的历史闭合不变量（那是 fork 的语义），遇到半事务只丢弃该条并标记 partial。
 */
export class SessionReferenceReader {
  readonly sessionsDir: string;
  private readonly diagnostic?: (message: string) => void;
  private readonly readOptions: ReferenceReaderReadBudget;

  constructor(options: ReferenceReaderOptions & ReferenceReaderReadBudget = {}) {
    this.sessionsDir = options.sessionsDir
      ? path.resolve(options.sessionsDir)
      : path.join(options.homeDirectory ?? os.homedir(), '.kapibala', 'sessions');
    this.diagnostic = options.onDiagnostic;
    this.readOptions = { maxReadBytes: options.maxReadBytes };
  }

  /**
   * 读取一段源会话历史的冻结快照。
   *
   * 保证：
   * - 返回正文已脱敏、已按单条字符与字节上限裁剪；
   * - 会话级读取尾部优先取样后按时间正序还原，避免大历史挤爆预算；
   * - 半事务记录与不可见内容不会进入结果，并以 partial 说明原因。
   *
   * 何时失败：
   * - 源会话不存在或前缀歧义（REFERENCE_SESSION_NOT_FOUND）；
   * - 源会话不在请求的项目桶（REFERENCE_PROJECT_MISMATCH）；
   * - 源会话已归档（REFERENCE_ARCHIVED）；
   * - recordId 或 branchId 不存在，或记录不在该分支（REFERENCE_RECORD_NOT_FOUND）；
   * - 目标是工具 / 思考等不可见内容（REFERENCE_UNSUPPORTED_ROLE）；
   * - 条数、字符或字节超过上限（REFERENCE_BUDGET_EXCEEDED，调用方应零追加）。
   */
  async read(request: ReferenceReadRequest): Promise<ReferenceReadResult> {
    const canonicalRoot = toNativePhysicalPath(request.projectRoot);
    const recordIds = request.recordIds ? Array.from(new Set(request.recordIds)) : undefined;
    if (recordIds && recordIds.length > MAX_REFERENCE_RECORDS_PER_RUN) {
      throw createReferenceError(
        'REFERENCE_BUDGET_EXCEEDED',
        `Too many reference records: ${recordIds.length} > ${MAX_REFERENCE_RECORDS_PER_RUN}`,
      );
    }
    const limit = this.resolveLimit(request.limit);
    const maxChars = this.resolveMaxCharsPerRecord(request.maxCharsPerRecord);

    const resolved = this.resolveSessionFile(canonicalRoot, request.sessionId);
    const scanned = this.scan(resolved.filePath);
    const headerRoot = scanned.header.projectRoot;
    if (typeof headerRoot !== 'string' || !headerRoot || !isSamePath(canonicalRoot, headerRoot)) {
      throw createReferenceError(
        'REFERENCE_PROJECT_MISMATCH',
        `Session ${resolved.conversationId} belongs to another project bucket`,
      );
    }
    if (scanned.header.conversationId !== resolved.conversationId) {
      throw createReferenceError(
        'REFERENCE_SESSION_NOT_FOUND',
        `Session header identity mismatch: ${resolved.conversationId}`,
      );
    }
    if (scanned.archived) {
      throw createReferenceError(
        'REFERENCE_ARCHIVED',
        `Session ${resolved.conversationId} is archived`,
      );
    }

    const targetBranch = request.branchId ?? scanned.activeBranchId;
    if (!scanned.branchLeaves.has(targetBranch)) {
      throw createReferenceError(
        'REFERENCE_RECORD_NOT_FOUND',
        `Branch not found in session ${resolved.conversationId}: ${targetBranch}`,
      );
    }

    const chain = this.buildCausalChain(scanned, targetBranch);
    const rows = this.collectVisibleRows(chain);
    const rowById = new Map(rows.map((row) => [row.record.recordId, row]));
    const chainById = new Map(chain.map((record) => [record.recordId, record]));
    const partialReasons = new Set<string>();
    if (scanned.corruptLineSkipped) partialReasons.add('corrupt_line_skipped');

    let selected: VisibleRow[];
    if (recordIds) {
      const chosen: VisibleRow[] = [];
      for (const recordId of recordIds) {
        const record = chainById.get(recordId);
        if (!record) {
          throw createReferenceError(
            'REFERENCE_RECORD_NOT_FOUND',
            `Record not found on branch ${targetBranch}: ${recordId}`,
          );
        }
        if (record.type !== 'message' && record.type !== 'branch_summary') {
          throw createReferenceError(
            'REFERENCE_UNSUPPORTED_ROLE',
            `Record is not quotable content: ${recordId} (${record.type})`,
          );
        }
        const row = rowById.get(recordId);
        if (!row) {
          throw createReferenceError(
            'REFERENCE_UNSUPPORTED_ROLE',
            `Record has no visible text: ${recordId}`,
          );
        }
        if (row.unclosedToolCalls.length > 0) {
          partialReasons.add('unclosed_tool_transaction');
          this.report(`Skipped reference record in unclosed tool transaction: ${recordId}`);
          continue;
        }
        if (row.strippedNonText) partialReasons.add('tool_blocks_stripped');
        chosen.push(row);
      }
      chosen.sort((a, b) => a.order - b.order);
      selected = chosen;
    } else {
      const candidates = rows.filter((row) => row.role !== 'branch_summary');
      const blocked = candidates.filter((row) => row.unclosedToolCalls.length > 0);
      if (blocked.length > 0) {
        partialReasons.add('unclosed_tool_transaction');
        this.report(
          `Skipped ${blocked.length} reference candidate(s) in unclosed tool transactions`,
        );
      }
      const eligible = candidates.filter((row) => row.unclosedToolCalls.length === 0);
      selected = eligible.slice(-limit);
      if (selected.some((row) => row.strippedNonText)) {
        partialReasons.add('tool_blocks_stripped');
      }
    }

    const snapshots: ReferenceRecordSnapshot[] = [];
    for (const row of selected) {
      const clipped = this.clipText(this.redact(row.text), row.role, maxChars);
      snapshots.push({
        recordId: row.record.recordId,
        role: row.role,
        branchId: targetBranch,
        timestamp: row.record.timestamp,
        text: clipped.text,
        truncated: clipped.truncated,
      });
    }
    assertReferenceRunBudget(snapshots);

    return {
      sessionId: resolved.conversationId,
      ...(scanned.title ? { title: scanned.title } : {}),
      branchId: targetBranch,
      records: snapshots,
      ...(partialReasons.size > 0 ? { partial: Array.from(partialReasons).join(',') } : {}),
    };
  }

  /**
   * 列出当前项目桶内的会话候选，供 CLI / 桌面 picker 使用。
   *
   * 保证：
   * - 只扫描请求项目根对应的桶目录，不跨桶；
   * - 默认排除已归档会话（引用已归档会话会被 read 拒绝）；
   * - 按最后活动时间倒序，只读不重建 sidecar。
   */
  async listCandidates(request: ReferenceCandidateRequest): Promise<ReferenceSessionCandidate[]> {
    const canonicalRoot = toNativePhysicalPath(request.projectRoot);
    const limit = request.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw createReferenceError(
        'REFERENCE_BUDGET_EXCEEDED',
        `Invalid candidate limit: ${String(request.limit)}`,
      );
    }
    const bucket = path.join(this.sessionsDir, computeProjectKey(canonicalRoot));
    let files: string[];
    try {
      files = fs.readdirSync(bucket).filter((name) => /^\d+_[a-zA-Z0-9-]+\.jsonl$/.test(name));
    } catch {
      return [];
    }

    const candidates: ReferenceSessionCandidate[] = [];
    for (const fileName of files) {
      const filePath = path.join(bucket, fileName);
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_REFERENCE_SCAN_BYTES) {
          this.report(`Skipped oversized reference candidate ${fileName}: ${stat.size} bytes`);
          continue;
        }
        const scanned = this.scan(filePath);
        const headerRoot = scanned.header.projectRoot;
        if (typeof headerRoot !== 'string' || !headerRoot || !isSamePath(canonicalRoot, headerRoot))
          continue;
        if (scanned.archived) continue;
        candidates.push({
          sessionId: scanned.header.conversationId,
          title: scanned.title,
          lastActivityAt: scanned.lastActivityAt,
          messageCount: scanned.messageCount,
          delegation: isDelegationHeader(scanned.headerRecord.payload),
        });
      } catch (error) {
        this.report(
          `Failed to scan reference candidate ${fileName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    candidates.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return candidates.slice(0, limit);
  }

  /** 校验并规范化会话级取样条数；越界属于调用方配置错误，不静默夹取。 */
  private resolveLimit(limit: number | undefined): number {
    const value = limit ?? DEFAULT_REFERENCE_RECORD_LIMIT;
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_REFERENCE_RECORD_LIMIT) {
      throw createReferenceError(
        'REFERENCE_BUDGET_EXCEEDED',
        `Invalid reference limit: ${String(limit)} (expected 1-${MAX_REFERENCE_RECORD_LIMIT})`,
      );
    }
    return value;
  }

  /** 单条字符上限只允许收紧到 (0, 4000]，避免调用方绕过设计基线。 */
  private resolveMaxCharsPerRecord(value: number | undefined): number {
    if (value === undefined) return MAX_REFERENCE_CHARS_PER_RECORD;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw createReferenceError(
        'REFERENCE_BUDGET_EXCEEDED',
        `Invalid per-record char limit: ${String(value)}`,
      );
    }
    return Math.min(value, MAX_REFERENCE_CHARS_PER_RECORD);
  }

  /** 在项目桶内按完整 ID 或唯一前缀定位会话文件；歧义与缺失都按找不到处理。 */
  private resolveSessionFile(
    canonicalProjectRoot: string,
    sessionId: string,
  ): { filePath: string; conversationId: string } {
    if (!sessionId || !/^[a-zA-Z0-9-]+$/.test(sessionId)) {
      throw createReferenceError(
        'REFERENCE_SESSION_NOT_FOUND',
        `Invalid reference session id: ${sessionId}`,
      );
    }
    const bucket = path.join(this.sessionsDir, computeProjectKey(canonicalProjectRoot));
    let files: string[];
    try {
      files = fs.readdirSync(bucket).filter((name) => /^\d+_[a-zA-Z0-9-]+\.jsonl$/.test(name));
    } catch {
      throw createReferenceError(
        'REFERENCE_SESSION_NOT_FOUND',
        `Reference project bucket not found: ${canonicalProjectRoot}`,
      );
    }
    const sessions = files.map((fileName) => ({
      fileName,
      conversationId: fileName.slice(fileName.indexOf('_') + 1, -6),
    }));
    const exact = sessions.find((item) => item.conversationId === sessionId);
    const matches = exact
      ? [exact]
      : sessions.filter((item) => item.conversationId.startsWith(sessionId));
    if (matches.length !== 1) {
      throw createReferenceError(
        'REFERENCE_SESSION_NOT_FOUND',
        `Reference session not found or ambiguous: ${sessionId}`,
      );
    }
    return {
      filePath: path.join(bucket, matches[0].fileName),
      conversationId: matches[0].conversationId,
    };
  }

  /** 流式解析会话文件并重建只读视图；损坏行跳过并标记，不写回任何状态。 */
  private scan(filePath: string): ScannedSession {
    const iterator = readJsonlLines(filePath, this.readOptions);
    const records: SessionRecord[] = [];
    let headerRecord: SessionRecord | undefined;
    let corruptLineSkipped = false;
    try {
      for (const line of iterator) {
        if (!line.text.trim()) continue;
        let record: SessionRecord;
        try {
          record = JSON.parse(line.text) as SessionRecord;
        } catch {
          corruptLineSkipped = true;
          continue;
        }
        if (
          !record ||
          typeof record !== 'object' ||
          typeof record.recordId !== 'string' ||
          typeof record.type !== 'string'
        ) {
          corruptLineSkipped = true;
          continue;
        }
        if (!headerRecord) {
          if (record.type !== 'header') {
            throw createReferenceError(
              'REFERENCE_SESSION_NOT_FOUND',
              `Session file has no header: ${filePath}`,
            );
          }
          headerRecord = record;
          continue;
        }
        records.push(record);
      }
    } finally {
      iterator.return?.(undefined as any);
    }
    if (!headerRecord) {
      throw createReferenceError('REFERENCE_SESSION_NOT_FOUND', `Empty session file: ${filePath}`);
    }
    const header = headerRecord.payload as unknown as SessionHeader;
    if (typeof header.conversationId !== 'string' || !header.conversationId) {
      throw createReferenceError(
        'REFERENCE_SESSION_NOT_FOUND',
        `Session header has no conversationId: ${filePath}`,
      );
    }

    const branchLeaves = new Map<string, string>([[MAIN_BRANCH_ID, headerRecord.recordId]]);
    let activeBranchId = MAIN_BRANCH_ID;
    let archived = false;
    let customTitle: string | undefined;
    let firstUserTitle: string | undefined;
    let messageCount = 0;
    let lastActivityAt = headerRecord.timestamp;

    for (const record of records) {
      if (record.type === 'branch_created') {
        const branchId = record.payload.branchId;
        const baseRecordId = record.payload.baseRecordId;
        if (typeof branchId === 'string' && typeof baseRecordId === 'string') {
          branchLeaves.set(branchId, baseRecordId);
        }
      } else if (record.type === 'branch_selected') {
        const branchId = record.payload.branchId;
        if (typeof branchId === 'string') activeBranchId = branchId;
      } else if (record.type === 'archive_state') {
        archived = Boolean(record.payload.archived);
      } else if (record.type === 'title') {
        const value = String(record.payload.title ?? '').trim();
        if (value) customTitle = sanitizeSessionTitle(this.redact(value));
      } else if (record.type === 'message') {
        messageCount++;
        lastActivityAt = record.timestamp;
        const payload = record.payload as unknown as CanonicalMessage;
        if (!firstUserTitle && payload.role === 'user') {
          const text = extractText(payload.content);
          if (text) firstUserTitle = sanitizeSessionTitle(this.redact(text), 80);
        }
      } else if (record.type === 'run_started') {
        lastActivityAt = record.timestamp;
      }
      // 与 SessionStore.readFile 同口径：分支记录（含 branch_summary）推进所属分支叶子。
      if (typeof record.branchId === 'string') {
        branchLeaves.set(record.branchId, record.recordId);
      }
    }

    return {
      header,
      headerRecord,
      records,
      activeBranchId,
      branchLeaves,
      archived,
      title: customTitle ?? firstUserTitle ?? '新会话',
      messageCount,
      lastActivityAt,
      corruptLineSkipped,
    };
  }

  /** 沿目标分支叶子回溯因果链并裁掉最近一次 reset 之前的内容，返回根到叶的顺序。 */
  private buildCausalChain(scanned: ScannedSession, branchId: string): SessionRecord[] {
    const recordById = new Map<string, SessionRecord>();
    recordById.set(scanned.headerRecord.recordId, scanned.headerRecord);
    for (const record of scanned.records) recordById.set(record.recordId, record);

    const chain: SessionRecord[] = [];
    let cursor: string | null = scanned.branchLeaves.get(branchId) ?? null;
    while (cursor) {
      const record = recordById.get(cursor);
      if (!record) break;
      chain.push(record);
      cursor = record.parentId;
    }
    chain.reverse();
    const lastResetIndex = chain.map((record) => record.type).lastIndexOf('reset');
    return chain.slice(Math.max(1, lastResetIndex + 1));
  }

  /**
   * 按因果顺序提取可见记录，并标注每条记录上仍未闭合的工具调用。
   *
   * 保证：
   * - 只保留 user / assistant 的 text 块与 branch_summary 摘要；
   * - `history_repair` 视为闭合对应工具调用（与 fork 的闭合语义同源）；
   * - 「半事务」指到分支叶为止都没有 tool_result 闭合的调用：assistant 自己发起但随后闭合的
   *   工具调用不算半事务，只有最终仍未闭合的记录在选取阶段被丢弃。
   */
  private collectVisibleRows(chain: readonly SessionRecord[]): VisibleRow[] {
    const pendingToolCalls = new Set<string>();
    const drafts: Array<Omit<VisibleRow, 'unclosedToolCalls'> & { pendingAfter: string[] }> = [];
    let order = 0;

    for (const record of chain) {
      order++;
      if (record.type === 'history_repair') {
        const toolCallId = record.payload.toolCallId;
        if (typeof toolCallId === 'string') pendingToolCalls.delete(toolCallId);
        continue;
      }
      if (record.type === 'branch_summary') {
        const summary = typeof record.payload.summary === 'string' ? record.payload.summary : '';
        const text = summary.trim();
        if (!text) continue;
        drafts.push({
          record,
          role: 'branch_summary',
          text,
          strippedNonText: false,
          pendingAfter: Array.from(pendingToolCalls),
          order,
        });
        continue;
      }
      if (record.type !== 'message') continue;

      const payload = record.payload as unknown as CanonicalMessage;
      const content = Array.isArray(payload.content) ? payload.content : [];
      if (payload.role === 'assistant') {
        for (const block of content) {
          if (block.type === 'tool_use' && typeof block.id === 'string') {
            pendingToolCalls.add(block.id);
          }
        }
      } else if (payload.role === 'tool') {
        for (const block of content) {
          if (block.type === 'tool_result' && typeof block.toolUseId === 'string') {
            pendingToolCalls.delete(block.toolUseId);
          }
        }
        const legacyId = (payload as { tool_call_id?: unknown }).tool_call_id;
        if (typeof legacyId === 'string') pendingToolCalls.delete(legacyId);
        continue;
      }

      if (payload.role !== 'user' && payload.role !== 'assistant') continue;
      if (payload.state && payload.state !== 'completed') continue;
      const text = extractText(content);
      if (!text) continue;
      drafts.push({
        record,
        role: payload.role,
        text,
        strippedNonText: content.some((block) => block.type !== 'text'),
        pendingAfter: Array.from(pendingToolCalls),
        order,
      });
    }

    // 分支叶之前从未闭合的调用集合；只有与它相交的记录才处于半事务中。
    const neverClosed = new Set(pendingToolCalls);
    return drafts.map(({ pendingAfter, ...row }) => ({
      ...row,
      unclosedToolCalls: pendingAfter.filter((id) => neverClosed.has(id)),
    }));
  }

  /**
   * 按角色裁剪正文：user 取头部（问题在前）、assistant 取尾部（结论在后）、摘要取头部。
   *
   * 保证：
   * - 字符与 UTF-8 字节上限同时生效，先到者截止；
   * - 按 code point 切片，不劈开代理对或多字节字符；
   * - 裁剪标记放在被裁掉的一侧，并计入最终正文长度。
   */
  private clipText(
    text: string,
    role: ReferenceSourceRole,
    maxChars: number,
  ): { text: string; truncated: boolean } {
    const points = Array.from(text);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (points.length <= maxChars && bytes <= MAX_REFERENCE_BYTES_PER_RECORD) {
      return { text, truncated: false };
    }
    const fromTail = role === 'assistant';
    // 裁剪标记与其包裹换行都属于最终正文：先预留它们的字符与字节，再按剩余额度取正文，
    // 否则裁剪结果会超出 maxCharsPerRecord / MAX_REFERENCE_BYTES_PER_RECORD。
    // 例外：maxCharsPerRecord 小到放不下标记时只保留标记本身（溯源信息优先于长度）。
    const markerLine = TRUNCATION_MARKER(points.length);
    const wrap = fromTail ? `${markerLine}\n` : `\n${markerLine}`;
    const charBudget = Math.max(0, maxChars - Array.from(wrap).length);
    const byteBudget = Math.max(
      0,
      MAX_REFERENCE_BYTES_PER_RECORD - Buffer.byteLength(wrap, 'utf8'),
    );
    const sequence = fromTail ? [...points].reverse() : points;
    const picked: string[] = [];
    let usedChars = 0;
    let usedBytes = 0;
    for (const char of sequence) {
      const charBytes = Buffer.byteLength(char, 'utf8');
      if (usedChars + 1 > charBudget || usedBytes + charBytes > byteBudget) break;
      picked.push(char);
      usedChars++;
      usedBytes += charBytes;
    }
    const body = fromTail ? picked.reverse().join('') : picked.join('');
    if (!body) return { text: markerLine, truncated: true };
    return {
      text: fromTail ? `${markerLine}\n${body}` : `${body}\n${markerLine}`,
      truncated: true,
    };
  }

  /** 快照阶段默认脱敏：覆盖常见凭据模式并移除终端控制符，保留换行与缩进结构。 */
  private redact(text: string): string {
    return redactReferenceSecrets(text);
  }

  /** 诊断回调失败不改变读取语义。 */
  private report(message: string): void {
    try {
      this.diagnostic?.(message);
    } catch {
      /* 诊断不改变语义 */
    }
  }
}

/**
 * 校验单次读取结果是否仍在单轮引用预算内。
 *
 * 为什么放在读取器：一次读取的正文必然属于同一轮引用，超限说明该轮无论如何都会超限，
 * 提前以稳定错误码失败才能保证调用方「零 append」。跨会话的合计校验由引用块装配层完成。
 */
function assertReferenceRunBudget(snapshots: readonly ReferenceRecordSnapshot[]): void {
  let chars = 0;
  let bytes = 0;
  for (const snapshot of snapshots) {
    chars += Array.from(snapshot.text).length;
    bytes += Buffer.byteLength(snapshot.text, 'utf8');
  }
  if (chars > MAX_REFERENCE_CHARS_PER_RUN || bytes > MAX_REFERENCE_BYTES_PER_RUN) {
    throw createReferenceError(
      'REFERENCE_BUDGET_EXCEEDED',
      `Reference budget exceeded: ${chars} chars / ${bytes} bytes`,
    );
  }
}

/** 判定 header 是否携带保留型委派标记；D0.2 之前写入的会话一律视为普通会话。 */
function isDelegationHeader(payload: Record<string, unknown>): boolean {
  return Boolean(payload.delegation);
}

/** 取文本块正文；工具、思考与协议私有块一律丢弃。 */
function extractText(content: readonly ContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
  }
  return texts.join('\n\n').trim();
}

/**
 * 引用正文脱敏。
 *
 * 与 `sanitizeModelErrorMessage` 同族的凭据模式，但面向正文：
 * 不限长、不压缩空白、保留换行与缩进；URL 只遮蔽凭据与敏感查询参数，不整体抹掉链接。
 * 控制字符（含 ESC）统一替换为空格，引用正文因此不会携带终端控制序列。
 */
function redactReferenceSecrets(value: string): string {
  return value
    .replace(/\p{Cc}/gu, (char) => (char === '\n' || char === '\t' ? char : ' '))
    .replace(
      /\b(?:Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic)\s+[^\s,;"']+/gi,
      'Authorization: [redacted]',
    )
    .replace(/\b(?:Cookie|Set-Cookie)\s*:[^\r\n]*/gi, 'Cookie: [redacted]')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|api|key)-[A-Za-z0-9_-]{5,}/g, '[redacted]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|token|password|secret|authorization|cookie)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      '$1[redacted]',
    )
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => maskUrlCredentials(raw));
}

/** 遮蔽 URL 中的用户名、密码与敏感查询参数；解析失败时原样保留，不伪造结果。 */
function maskUrlCredentials(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = 'redacted';
      url.password = 'redacted';
    }
    for (const key of Array.from(url.searchParams.keys())) {
      if (/(?:token|key|secret|password|auth|sig)/i.test(key)) {
        url.searchParams.set(key, 'redacted');
      }
    }
    return url.toString();
  } catch {
    return raw;
  }
}
