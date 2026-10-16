/**
 * @fileoverview 跨项目会话目录扫描（CrossProjectSessionCatalog）与有界全文检索。
 *
 * 约束、边界与为什么：
 * 1. 跨项目扫描与增量 Sidecar 校验（Cross-Project Incremental Discovery）：
 *    扫描 ~/.kapibala/sessions 全局项目桶目录，优先通过 sidecar 缓存校验读取元数据；
 *    若缓存缺失或 stat（大小/mtime）失配，流式读取正文重建，严禁将未校验缓存当真源。
 * 2. 有界全文检索（Bounded Full-Text Search）：
 *    - 范围限定：仅搜索 user / assistant 可见文本与 branch_summary 分支摘要，
 *      默认绝对排除 tool_result 原始输出、私有 reasoning、协议私有字段与凭据；
 *    - 检索语法：支持空格 AND、引号短语、project:/branch:/tag: 属性限定与 re: 正则模式；
 *    - 中文检索：按原生字面子串匹配，不依赖第三方分词库；
 *    - 有界保护：单行限长截断、病态正则超时熔断、最大结果数量上限，超限返回 partial 及原因。
 * 3. 逻辑归档隔离（Archive Isolation）：
 *    默认目录列表与全文搜索严格排除已归档（archived: true）会话，除非显式指定 includeArchived。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { KapibalaError } from '../errors/index.js';
import type { CanonicalMessage, ContentBlock } from '../types/index.js';
import { readJsonlLines } from './jsonl-lines.js';
import type { SessionMetadata } from './session-manager.js';
import { normalizedProjectRoot } from './session-manager.js';
import {
  MAIN_BRANCH_ID,
  SESSION_SCHEMA_VERSION_V1,
  SESSION_SCHEMA_VERSION_V2,
  type SessionHeader,
  type SessionRecord,
  isGlobalControlRecordType,
} from './session-store.js';
import { isSamePath } from './workspace.js';

/**
 * 跨项目会话目录项。
 */
export interface SessionCatalogEntry extends SessionMetadata {
  /** 所属项目桶键名（SHA256 哈希）。 */
  readonly projectKey: string;
  /** 会话文件物理绝对路径。 */
  readonly filePath: string;
}

/**
 * 全文检索命中结果项。
 */
export interface SearchHit {
  /** 所属会话 ID。 */
  readonly conversationId: string;
  /** 所属项目根路径。 */
  readonly projectRoot: string;
  /** 所属分支 ID。 */
  readonly branchId: string;
  /** 命中的记录 ID。 */
  readonly recordId: string;
  /** 命中角色（user / assistant / branch_summary）。 */
  readonly role: 'user' | 'assistant' | 'branch_summary';
  /** 命中记录的时间戳。 */
  readonly timestamp: number;
  /** 命中片段摘要（包含关键词的上下文片段）。 */
  readonly snippet: string;
  /** 是否处于可分叉/可续答的合法边界。 */
  readonly canResume: boolean;
}

/**
 * 全文检索选项。
 */
export interface SearchOptions {
  /** 限定项目根路径或 projectKey。 */
  readonly project?: string;
  /** 限定分支名。 */
  readonly branch?: string;
  /** 限定标签。 */
  readonly tag?: string;
  /** 是否包含已归档会话（默认 false）。 */
  readonly includeArchived?: boolean;
  /** 最大返回命中记录数（默认 50，最大 200）。 */
  readonly limit?: number;
  /** 搜索总体超时时间（毫秒，默认 10,000ms）。 */
  readonly timeoutMs?: number;
  /** 取消信号。 */
  readonly signal?: AbortSignal;
}

/**
 * 全文检索结果响应。
 */
export interface SearchResponse {
  /** 命中结果列表。 */
  readonly hits: readonly SearchHit[];
  /** 扫描的会话总数。 */
  readonly totalSessionsScanned: number;
  /** 扫描的记录总数。 */
  readonly totalRecordsScanned: number;
  /** 是否为有界部分截断结果。 */
  readonly isPartial: boolean;
  /** 产生截断或跳过的原因列表。 */
  readonly partialReasons?: readonly string[];
}

/**
 * 目录扫描配置选项。
 */
export interface CatalogOptions {
  /** 会话全局存储根目录（缺省为 ~/.kapibala/sessions）。 */
  readonly sessionsDir?: string;
  /** 用户主目录（用于测试隔离）。 */
  readonly homeDirectory?: string;
  /** 诊断回调。 */
  readonly onDiagnostic?: (message: string) => void;
}

/**
 * 具有超时保护的正则匹配结果。
 */
export interface SafeRegexMatchResult {
  /** 是否匹配成功。 */
  readonly matched: boolean;
  /** 首次匹配的字符起始索引，未匹配为 -1。 */
  readonly matchIndex: number;
  /** 是否因超时而提前终止。 */
  readonly timedOut?: boolean;
  /** 异常信息。 */
  readonly error?: string;
}

interface SafeRegexRequest {
  id: number;
  pattern: string;
  flags: string;
  text: string;
}

interface SafeRegexResponse {
  id: number;
  matched: boolean;
  matchIndex: number;
  error?: string;
}

const REGEX_WORKER_SCRIPT = `
  import { parentPort } from 'node:worker_threads';
  parentPort.on('message', (msg) => {
    try {
      const re = new RegExp(msg.pattern, msg.flags);
      const match = re.exec(msg.text);
      parentPort.postMessage({
        id: msg.id,
        matched: !!match,
        matchIndex: match ? match.index : -1,
      });
    } catch (err) {
      parentPort.postMessage({
        id: msg.id,
        matched: false,
        matchIndex: -1,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
`;

let activeRegexWorker: Worker | undefined;
let nextRegexRequestId = 1;
const pendingRegexRequests = new Map<
  number,
  {
    resolve: (result: SafeRegexMatchResult) => void;
    timer: NodeJS.Timeout;
  }
>();

function getOrCreateRegexWorker(): Worker {
  if (!activeRegexWorker) {
    activeRegexWorker = new Worker(REGEX_WORKER_SCRIPT, { eval: true });
    activeRegexWorker.unref();
    activeRegexWorker.on('message', (msg: SafeRegexResponse) => {
      const pending = pendingRegexRequests.get(msg.id);
      if (pending) {
        pendingRegexRequests.delete(msg.id);
        clearTimeout(pending.timer);
        pending.resolve({
          matched: msg.matched,
          matchIndex: msg.matchIndex,
          ...(msg.error ? { error: msg.error } : {}),
        });
      }
    });
    activeRegexWorker.on('error', (err: Error) => {
      const allPending = Array.from(pendingRegexRequests.values());
      pendingRegexRequests.clear();
      try {
        void activeRegexWorker?.terminate();
      } catch {
        /* 忽略终止异常 */
      }
      activeRegexWorker = undefined;
      for (const p of allPending) {
        clearTimeout(p.timer);
        p.resolve({ matched: false, matchIndex: -1, error: err.message });
      }
    });
  }
  return activeRegexWorker;
}

/**
 * 在独立 Worker 线程中执行正则匹配，并在超时时强制 terminate 线程。
 * 彻底防御主事件循环被 ReDoS 灾难性回溯阻塞。
 *
 * 保证：
 * - 默认复用长寿命常驻 Worker 实例，消除每次匹配 ~93ms 的新建开销；
 * - 超时后强制终止底层卡死 Worker 线程，释放 CPU 资源并重建新实例；
 * - 捕获正则语法异常与执行异常，显式提供 error 字段供诊断，不向上抛出未捕获错误；
 * - 纯内存通信，不产生临时磁盘文件。
 *
 * @param pattern 正则表达式模式文本
 * @param flags 正则表达式修饰符（如 'i', 'm' 等）
 * @param text 待检索的目标文本
 * @param timeoutMs 超时毫秒数（默认 1000ms）
 */
export function safeRegexMatch(
  pattern: string,
  flags: string,
  text: string,
  timeoutMs = 1000,
): Promise<SafeRegexMatchResult> {
  return new Promise((resolve) => {
    const id = nextRegexRequestId++;
    let worker: Worker;
    try {
      worker = getOrCreateRegexWorker();
    } catch (err: unknown) {
      resolve({
        matched: false,
        matchIndex: -1,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const timer = setTimeout(() => {
      pendingRegexRequests.delete(id);
      try {
        void activeRegexWorker?.terminate();
      } catch {
        /* 忽略终止异常 */
      }
      activeRegexWorker = undefined;

      const remaining = Array.from(pendingRegexRequests.values());
      pendingRegexRequests.clear();
      for (const p of remaining) {
        clearTimeout(p.timer);
        p.resolve({ matched: false, matchIndex: -1, timedOut: true });
      }

      resolve({ matched: false, matchIndex: -1, timedOut: true });
    }, timeoutMs);

    pendingRegexRequests.set(id, { resolve, timer });
    worker.postMessage({ id, pattern, flags, text });
  });
}

/**
 * 解析后的查询结构。
 */
interface ParsedQuery {
  readonly isRegex: boolean;
  readonly regex?: RegExp;
  readonly rawRegexPattern?: string;
  readonly rawRegexFlags?: string;
  readonly terms: readonly string[];
  readonly phrases: readonly string[];
  readonly filterProject?: string;
  readonly filterBranch?: string;
  readonly filterTag?: string;
}

/**
 * 跨项目会话目录检索器（CrossProjectSessionCatalog）。
 */
export class CrossProjectSessionCatalog {
  readonly sessionsDir: string;
  private readonly diagnostic?: (message: string) => void;

  constructor(options: CatalogOptions = {}) {
    this.sessionsDir = options.sessionsDir
      ? path.resolve(options.sessionsDir)
      : path.join(options.homeDirectory ?? os.homedir(), '.kapibala', 'sessions');
    this.diagnostic = options.onDiagnostic;
  }

  /**
   * 跨项目流式扫描全局目录下的所有会话元数据。
   *
   * 保证：
   * - 优先校验并利用 sidecar 增量缓存；
   * - 缓存损坏或缺失时从正文重建并持久化 sidecar；
   * - 默认排除已归档（archived）会话。
   */
  async scanSessions(options?: {
    projectRoot?: string;
    projectKey?: string;
    includeArchived?: boolean;
  }): Promise<SessionCatalogEntry[]> {
    if (!fs.existsSync(this.sessionsDir)) {
      return [];
    }

    const entries: SessionCatalogEntry[] = [];
    const projectDirs = fs
      .readdirSync(this.sessionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const pKey of projectDirs) {
      if (options?.projectKey && pKey !== options.projectKey) {
        continue;
      }

      const pPath = path.join(this.sessionsDir, pKey);
      let sessionFiles: string[] = [];
      try {
        sessionFiles = fs
          .readdirSync(pPath)
          .filter((f) => f.endsWith('.jsonl') && /^\d+_[a-zA-Z0-9-]+\.jsonl$/.test(f));
      } catch {
        continue;
      }

      for (const fileName of sessionFiles) {
        const fullPath = path.join(pPath, fileName);
        try {
          const meta = this.resolveMetadata(fullPath);
          if (!meta) continue;

          if (options?.projectRoot && !isSamePath(meta.projectRoot, options.projectRoot)) {
            continue;
          }

          if (!options?.includeArchived && meta.archived) {
            continue;
          }

          entries.push({
            ...meta,
            projectKey: pKey,
            filePath: fullPath,
          });
        } catch {
          this.report(`Failed to parse session metadata for: ${fullPath}`);
        }
      }
    }

    // 按最后活动时间降序排序
    entries.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return entries;
  }

  /**
   * 有界跨项目全文检索。
   *
   * 保证：
   * - 仅搜索可见文本（user / assistant 文字）与分支摘要；
   * - 支持空格 AND、引号短语、project:/branch: 前缀与 re: 正则；
   * - 中文子串字面匹配；
   * - 遵守限长、超时与最大返回限制，返回 partial 标志与原因。
   *
   * @param query 搜索关键词或查询表达式
   * @param options 搜索选项
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? 10_000;
    const deadline = startTime + timeoutMs;
    const maxLimit = Math.min(Math.max(1, options.limit ?? 50), 200);

    const parsed = this.parseQuery(query);
    const filterProj = parsed.filterProject ?? options.project;
    const filterBranch = parsed.filterBranch ?? options.branch;

    // 1. 预过滤候选会话
    const candidateSessions = await this.scanSessions({
      projectRoot: filterProj,
      includeArchived: options.includeArchived,
    });

    const hits: SearchHit[] = [];
    const partialReasons: string[] = [];
    let isPartial = false;
    let totalRecordsScanned = 0;
    let sessionsScannedCount = 0;

    for (const session of candidateSessions) {
      if (options.signal?.aborted) {
        isPartial = true;
        partialReasons.push('search_aborted');
        break;
      }

      // 用 >= 而非 >：timeoutMs 为 0（预算已耗尽）时 Date.now() 可能与 deadline 落在同一毫秒，
      // 严格大于会让搜索"零文件也宣称完整"，部分结果标记变成不可复现的竞态。
      if (Date.now() >= deadline) {
        isPartial = true;
        partialReasons.push('search_timeout');
        break;
      }

      sessionsScannedCount++;
      const sessionHits = await this.searchInSessionFile({
        filePath: session.filePath,
        conversationId: session.conversationId,
        projectRoot: session.projectRoot,
        parsedQuery: parsed,
        filterBranch,
        limitRemaining: maxLimit - hits.length,
        deadline,
        signal: options.signal,
      });

      hits.push(...sessionHits.hits);
      totalRecordsScanned += sessionHits.recordsScanned;

      if (sessionHits.isPartial) {
        isPartial = true;
        if (sessionHits.partialReason) {
          partialReasons.push(sessionHits.partialReason);
        }
      }

      if (hits.length >= maxLimit) {
        isPartial = true;
        partialReasons.push('limit_reached');
        break;
      }
    }

    return {
      hits,
      totalSessionsScanned: sessionsScannedCount,
      totalRecordsScanned,
      isPartial,
      partialReasons: partialReasons.length > 0 ? Array.from(new Set(partialReasons)) : undefined,
    };
  }

  /**
   * 解析查询字符串。
   */
  private parseQuery(rawQuery: string): ParsedQuery {
    const trimmed = rawQuery.trim();
    if (!trimmed) {
      return {
        isRegex: false,
        terms: [],
        phrases: [],
      };
    }

    // 1. 正则模式
    if (trimmed.startsWith('re:')) {
      const pattern = trimmed.slice(3).trim();
      try {
        const regex = new RegExp(pattern, 'i');
        return {
          isRegex: true,
          regex,
          rawRegexPattern: pattern,
          rawRegexFlags: 'i',
          terms: [],
          phrases: [],
        };
      } catch (err) {
        throw new KapibalaError(`Invalid regular expression in search query: ${String(err)}`, {
          code: 'CONFIG_INVALID',
          safeMessage: '搜索正则表达式语法无效',
        });
      }
    }

    // 2. 普通查询模式：提取 project:, branch:, tag: 与短语
    let filterProject: string | undefined;
    let filterBranch: string | undefined;
    let filterTag: string | undefined;

    let remaining = trimmed;

    // 提取 project:
    remaining = remaining.replace(/\bproject:(\S+)/gi, (_, val) => {
      filterProject = val;
      return '';
    });

    // 提取 branch:
    remaining = remaining.replace(/\bbranch:(\S+)/gi, (_, val) => {
      filterBranch = val;
      return '';
    });

    // 提取 tag:
    remaining = remaining.replace(/\btag:(\S+)/gi, (_, val) => {
      filterTag = val;
      return '';
    });

    // 提取引号短语 "..."
    const phrases: string[] = [];
    remaining = remaining.replace(/"([^"]+)"/g, (_, phrase) => {
      if (phrase.trim()) {
        phrases.push(phrase.trim());
      }
      return '';
    });

    // 提取普通空格分词
    const terms = remaining
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);

    return {
      isRegex: false,
      terms,
      phrases,
      filterProject,
      filterBranch,
      filterTag,
    };
  }

  /**
   * 在单个会话文件中流式搜索匹配记录。
   */
  private async searchInSessionFile(params: {
    filePath: string;
    conversationId: string;
    projectRoot: string;
    parsedQuery: ParsedQuery;
    filterBranch?: string;
    limitRemaining: number;
    deadline?: number;
    signal?: AbortSignal;
  }): Promise<{
    hits: SearchHit[];
    recordsScanned: number;
    isPartial: boolean;
    partialReason?: string;
  }> {
    const hits: SearchHit[] = [];
    let recordsScanned = 0;
    let isPartial = false;
    let partialReason: string | undefined;

    const iterator = readJsonlLines(params.filePath);
    let activeBranchId = MAIN_BRANCH_ID;

    try {
      for (const line of iterator) {
        if (params.signal?.aborted) {
          isPartial = true;
          partialReason = 'aborted';
          break;
        }

        if (params.deadline && Date.now() >= params.deadline) {
          isPartial = true;
          partialReason = 'search_timeout';
          break;
        }

        if (!line.text.trim()) continue;
        recordsScanned++;

        let record: SessionRecord;
        try {
          record = JSON.parse(line.text);
        } catch {
          isPartial = true;
          partialReason = 'corrupt_line_skipped';
          continue;
        }

        // 同步分支切换
        if (record.type === 'branch_selected') {
          activeBranchId = String(record.payload.branchId);
          continue;
        }

        const recordBranch = record.branchId ?? activeBranchId;
        if (params.filterBranch && recordBranch !== params.filterBranch) {
          continue;
        }

        // 仅搜索可见内容：message 或 branch_summary
        let searchableText = '';
        let role: 'user' | 'assistant' | 'branch_summary' | undefined;
        let canResume = false;

        if (record.type === 'message') {
          const payload = record.payload as Record<string, unknown>;
          const msgRole = String(payload.role);
          if (msgRole === 'user' || msgRole === 'assistant') {
            role = msgRole as 'user' | 'assistant';
            const content = payload.content as ContentBlock[];
            if (Array.isArray(content)) {
              // 仅提取 text 内容，排除 tool_use、thinking、redacted_thinking
              searchableText = content
                .filter((b) => b.type === 'text')
                .map((b) => b.text)
                .join(' ')
                .trim();

              // 检查可续答性：assistant 不能包含未闭合 tool_use
              if (role === 'assistant') {
                canResume = !content.some((b) => b.type === 'tool_use');
              } else {
                canResume = true;
              }
            }
          }
        } else if (record.type === 'branch_summary') {
          role = 'branch_summary';
          searchableText = String(record.payload.summary ?? '').trim();
          canResume = true;
        }

        if (!searchableText || !role) {
          continue;
        }

        // 进行匹配判定，超时随剩余 deadline 动态收缩
        const matchTimeout = params.deadline
          ? Math.min(1000, Math.max(50, params.deadline - Date.now()))
          : 1000;
        const matchInfo = await this.matches(searchableText, params.parsedQuery, matchTimeout);
        if (matchInfo.timedOut) {
          isPartial = true;
          partialReason = 'regex_timeout';
        }
        if (matchInfo.matched) {
          const snippet = this.generateSnippet(searchableText, matchInfo.matchIndex);
          hits.push({
            conversationId: params.conversationId,
            projectRoot: params.projectRoot,
            branchId: recordBranch,
            recordId: record.recordId,
            role,
            timestamp: record.timestamp,
            snippet,
            canResume,
          });

          if (hits.length >= params.limitRemaining) {
            isPartial = true;
            partialReason = 'limit_reached';
            break;
          }
        }
      }
    } finally {
      iterator.return?.(undefined as any);
    }

    return {
      hits,
      recordsScanned,
      isPartial,
      partialReason,
    };
  }

  /**
   * 判定文本是否匹配查询条件。
   */
  private async matches(
    text: string,
    query: ParsedQuery,
    timeoutMs = 1000,
  ): Promise<SafeRegexMatchResult> {
    if (query.isRegex && query.rawRegexPattern) {
      // 限制匹配长度，防止病态超长文本引发灾难性回溯
      const boundedText = text.length > 65536 ? text.slice(0, 65536) : text;
      return await safeRegexMatch(
        query.rawRegexPattern,
        query.rawRegexFlags ?? 'i',
        boundedText,
        timeoutMs,
      );
    }

    const lower = text.toLowerCase();
    let firstIndex = -1;

    // 检查短语
    for (const phrase of query.phrases) {
      const idx = lower.indexOf(phrase.toLowerCase());
      if (idx === -1) {
        return { matched: false, matchIndex: -1 };
      }
      if (firstIndex === -1 || idx < firstIndex) {
        firstIndex = idx;
      }
    }

    // 检查普通分词
    for (const term of query.terms) {
      const idx = lower.indexOf(term.toLowerCase());
      if (idx === -1) {
        return { matched: false, matchIndex: -1 };
      }
      if (firstIndex === -1 || idx < firstIndex) {
        firstIndex = idx;
      }
    }

    return { matched: true, matchIndex: Math.max(0, firstIndex) };
  }

  /**
   * 生成关键词周边的摘录片段。
   */
  private generateSnippet(text: string, matchIndex: number): string {
    const maxBefore = 40;
    const maxAfter = 80;

    const start = Math.max(0, matchIndex - maxBefore);
    const end = Math.min(text.length, matchIndex + maxAfter);

    let snippet = text.slice(start, end).replace(/\s+/g, ' ');
    if (start > 0) {
      snippet = `...${snippet}`;
    }
    if (end < text.length) {
      snippet = `${snippet}...`;
    }
    return snippet;
  }

  /**
   * 读取或增量重建单个会话文件的元数据。
   */
  private resolveMetadata(file: string): SessionMetadata | undefined {
    const sidecarFile = this.sidecarPath(file);
    try {
      if (fs.existsSync(sidecarFile)) {
        const meta = JSON.parse(fs.readFileSync(sidecarFile, 'utf8')) as SessionMetadata;
        const stat = fs.statSync(file);
        if (
          (meta.schemaVersion === 1 || meta.schemaVersion === 2) &&
          meta.size === stat.size &&
          meta.mtimeMs === stat.mtimeMs &&
          meta.conversationId
        ) {
          return meta;
        }
      }
    } catch {
      /* sidecar 损坏时自动回落正文重建 */
    }

    // 从正文流式构建 metadata
    try {
      const iterator = readJsonlLines(file);
      const first = iterator.next();
      if (first.done || !first.value.text.trim()) {
        iterator.return?.(undefined as any);
        return undefined;
      }

      const headerRecord = JSON.parse(first.value.text) as SessionRecord;
      if (headerRecord.type !== 'header') {
        iterator.return?.(undefined as any);
        return undefined;
      }

      const header = headerRecord.payload as unknown as SessionHeader;
      const stat = fs.statSync(file);

      let messageCount = 0;
      let lastActivityAt = headerRecord.timestamp;
      let title = '新会话';
      let activeBranchId = MAIN_BRANCH_ID;
      let archived = false;
      let lastRecordId = headerRecord.recordId;

      for (const line of iterator) {
        if (!line.text.trim()) continue;
        try {
          const rec = JSON.parse(line.text) as SessionRecord;
          lastRecordId = rec.recordId;
          if (rec.type === 'message') {
            messageCount++;
            lastActivityAt = rec.timestamp;
            if (title === '新会话' && rec.payload.role === 'user') {
              const content = rec.payload.content as ContentBlock[];
              if (Array.isArray(content)) {
                const txt = content
                  .filter((b) => b.type === 'text')
                  .map((b) => b.text)
                  .join(' ')
                  .trim();
                if (txt) title = txt.slice(0, 80);
              }
            }
          } else if (rec.type === 'title') {
            title = String(rec.payload.title);
          } else if (rec.type === 'archive_state') {
            archived = Boolean(rec.payload.archived);
          } else if (rec.type === 'branch_selected') {
            activeBranchId = String(rec.payload.branchId);
          }
        } catch {
          // 忽略残片
        }
      }

      const metadata: SessionMetadata = {
        schemaVersion: 2,
        sessionSchemaVersion: headerRecord.schemaVersion,
        conversationId: header.conversationId,
        fileName: path.basename(file),
        projectRoot: header.projectRoot,
        createdAt: header.createdAt ?? headerRecord.timestamp,
        lastActivityAt,
        messageCount,
        title,
        activeBranchId,
        archived,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        revision: lastRecordId,
        logRevision: lastRecordId,
      };

      // 增量回写 sidecar 缓存
      try {
        fs.writeFileSync(sidecarFile, JSON.stringify(metadata), 'utf8');
      } catch {
        /* 缓存写入失败不阻断 */
      }

      return metadata;
    } catch {
      return undefined;
    }
  }

  private sidecarPath(file: string): string {
    const id = path.basename(file, '.jsonl').split('_').at(-1)!;
    return path.join(path.dirname(file), `${id}.meta.json`);
  }

  private report(message: string): void {
    try {
      this.diagnostic?.(message);
    } catch {
      /* 诊断不改变语义 */
    }
  }
}
