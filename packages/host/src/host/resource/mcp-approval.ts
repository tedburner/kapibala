import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ServerConfig,
  ServerStartApprovalDecision,
  ServerStartAuthorizer,
  ServerStartupDescriptor,
} from '@kiturone/kapibala-mcp';

/**
 * MCP 服务器逐项批准（per-server approval）持久化。
 *
 * 定位与边界：
 * - 项目信任解决的是「这个仓库的代码可以跑」，MCP server 是配置驱动的常驻进程，爆炸半径不同，
 *   因此不共用一把钥匙：每个 server 首次启动前必须由用户明确批准；
 * - 批准绑定当时的**完整配置摘要**（command / args / cwd / env 键值 / url / headers / 超时等全量），
 *   任一字段变化即视为新配置，旧批准自动失效并回到待批准；
 * - 记录只保存摘要与时间戳，绝不落任何环境变量值或请求头原文；
 * - 存储放在用户级 `~/.kapibala/mcp-approvals.json`（项目级 server 用项目根路径做键的一部分），
 *   不写进仓库，避免把「用户信任决定」当成仓库内容分发。
 */

/** 批准记录文件名；与 mcp.json 同在 `~/.kapibala` 下，但语义独立。 */
export const MCP_APPROVAL_FILE = 'mcp-approvals.json';

/** 批准记录中 server 的来源层级，与配置解析结果同口径。 */
export type McpApprovalSource = 'global' | 'project';

/** 单条批准记录；`digest` 是批准时的配置摘要，用于判定配置是否变化。 */
export interface McpApprovalRecord {
  serverName: string;
  source: McpApprovalSource;
  digest: string;
  /** ISO 时间戳；只用于展示「何时批准」，不参与有效性判定。 */
  approvedAt: string;
}

/** 批准状态快照；`digest` 为当前配置摘要，`approvedDigest` 仅为已批准时的记录摘要。 */
export interface McpApprovalStatus {
  approved: boolean;
  digest: string;
  approvedAt?: string;
}

/** 参与批准的配置条目；`config` 必须是解析后的 `ServerConfig`（含全部生效字段）。 */
export interface McpApprovalTarget {
  name: string;
  source: McpApprovalSource;
  config: ServerConfig;
}

/** 顶层键排序后的稳定 JSON，保证同一配置在不同字段顺序下摘要一致。 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 配置摘要：全字段参与的 sha256；任一字段变化（含一个环境变量）都会得到不同摘要。 */
export function digestServerConfig(config: ServerConfig): string {
  return `sha256:${createHash('sha256').update(stableJson(config)).digest('hex')}`;
}

/**
 * 逐服务器批准的持久化存储。
 *
 * 保证与边界：
 * - 读取时对每条记录做结构校验，损坏或旧格式记录按「未批准」处理，绝不猜测；
 * - 写入使用 tmp + rename 原子替换，模式 0600；并发写入以最后一次完整写入为准；
 * - 项目级 server 的键包含规范化后的项目根（Windows 下折叠大小写并用 native realpath），
 *   因此两个项目各自的同名 server 批准互不影响；
 * - 内存不缓存批准结果：每次查询都读取磁盘，配置文件在外部被改动后立即反映。
 */
export class McpServerApprovalStore {
  /** 批准记录文件绝对路径。 */
  readonly file: string;
  private readonly homeDir: string;
  private readonly projectRoot?: string;

  /**
   * @param options.homeDir 用户主目录（与 MCP 配置文件同源，便于隔离环境重定向）。
   * @param options.projectRoot 当前项目根；项目级 server 的批准键需要它。
   */
  constructor(options: { homeDir?: string; projectRoot?: string }) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.projectRoot = options.projectRoot;
    this.file = path.join(this.homeDir, '.kapibala', MCP_APPROVAL_FILE);
  }

  /** 计算目标当前配置摘要。 */
  digestOf(target: Pick<McpApprovalTarget, 'config'>): string {
    return digestServerConfig(target.config);
  }

  /** 查询批准状态；配置摘要不一致即视为待批准，但保留 `approvedAt` 供界面提示「配置已变化」。 */
  status(target: McpApprovalTarget): McpApprovalStatus {
    const digest = digestServerConfig(target.config);
    const record = this.read()[this.keyOf(target.name, target.source)];
    return {
      approved: record?.digest === digest,
      digest,
      ...(record ? { approvedAt: record.approvedAt } : {}),
    };
  }

  /** 写入批准：以当前配置摘要为准，覆盖同键旧记录。 */
  approve(target: McpApprovalTarget): McpApprovalRecord {
    const record: McpApprovalRecord = {
      serverName: target.name,
      source: target.source,
      digest: digestServerConfig(target.config),
      approvedAt: new Date().toISOString(),
    };
    const records = this.read();
    records[this.keyOf(target.name, target.source)] = record;
    this.write(records);
    return record;
  }

  /** 撤销批准；返回是否确有记录被移除。 */
  revoke(name: string, source: McpApprovalSource): boolean {
    const records = this.read();
    const key = this.keyOf(name, source);
    if (!records[key]) return false;
    delete records[key];
    this.write(records);
    return true;
  }

  /** 列出当前作用域可见的批准记录（项目级只列本项目的）。 */
  list(): McpApprovalRecord[] {
    const prefix = this.scopeKey('project');
    return Object.entries(this.read())
      .filter(([key]) => (prefix ? key.startsWith(prefix) : !key.startsWith('project:')))
      .map(([, record]) => record);
  }

  /** 当前作用域键前缀：`global:` 或 `project:<normalizedRoot>:`；无项目根时为 undefined。 */
  private scopeKey(source: McpApprovalSource): string | undefined {
    if (source === 'global') return 'global:';
    if (!this.projectRoot) return undefined;
    return `project:${normalizeProjectRoot(this.projectRoot)}:`;
  }

  private keyOf(name: string, source: McpApprovalSource): string {
    const prefix = this.scopeKey(source);
    if (!prefix) throw new Error('MCP_APPROVAL_PROJECT_ROOT_REQUIRED: 项目级批准缺少项目根');
    return `${prefix}${name}`;
  }

  /** 读取全部合法记录；文件缺失、损坏或结构非法时返回空表，绝不覆盖现场。 */
  private read(): Record<string, McpApprovalRecord> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const container = parsed as { version?: unknown; approvals?: unknown };
    if (container.version !== 1 || !container.approvals) return {};
    if (typeof container.approvals !== 'object' || Array.isArray(container.approvals)) return {};
    const result: Record<string, McpApprovalRecord> = {};
    for (const [key, value] of Object.entries(container.approvals as Record<string, unknown>)) {
      const record = value as Partial<McpApprovalRecord>;
      if (
        typeof record.serverName !== 'string' ||
        (record.source !== 'global' && record.source !== 'project') ||
        typeof record.digest !== 'string' ||
        typeof record.approvedAt !== 'string'
      )
        continue;
      result[key] = {
        serverName: record.serverName,
        source: record.source,
        digest: record.digest,
        approvedAt: record.approvedAt,
      };
    }
    return result;
  }

  /** 原子写入；临时文件与目标同目录，失败时保留原文件。 */
  private write(records: Record<string, McpApprovalRecord>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(
        temporary,
        `${JSON.stringify({ version: 1, approvals: records }, null, 2)}\n`,
        {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        },
      );
      fs.renameSync(temporary, this.file);
    } catch (error) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        /* 临时文件未建立或已被移除。 */
      }
      throw error;
    }
  }
}

/** 项目根归一：优先 native realpath（Windows 8.3 短名），并折叠分隔符与大小写。 */
function normalizeProjectRoot(root: string): string {
  let resolved = path.resolve(root);
  try {
    resolved = fs.realpathSync.native(root);
  } catch {
    /* 路径不存在时退回 resolve 结果。 */
  }
  const unified = resolved.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

/**
 * 在既有交互授权前加一层「已批准且摘要一致」的静默放行。
 *
 * 保证：
 * - 命中批准记录时不再弹窗（返回 `allow_once`），未命中一律交给宿主原授权回调；
 * - 用户批准（allow_once / allow_session）后立即持久化，绑定当前配置摘要；
 * - 拒绝不落盘；持久化失败不阻断本次启动（只是下次仍需批准）；
 * - 找不到配置条目（如运行期新增未登记的服务）时不静默放行，交给原回调并跳过持久化。
 */
export function createApprovedStartAuthorizer(options: {
  store: McpServerApprovalStore;
  entries: ReadonlyMap<string, { source: McpApprovalSource; config: ServerConfig }>;
  fallback: ServerStartAuthorizer;
}): ServerStartAuthorizer {
  return async (
    descriptor: ServerStartupDescriptor,
    signal?: AbortSignal,
  ): Promise<ServerStartApprovalDecision> => {
    if (signal?.aborted) return 'deny_once';
    const entry = options.entries.get(descriptor.serverName);
    const target: McpApprovalTarget | undefined = entry
      ? { name: descriptor.serverName, source: entry.source, config: entry.config }
      : undefined;
    if (target) {
      try {
        if (options.store.status(target).approved) return 'allow_once';
      } catch {
        /* 项目根缺失等异常不在这里阻断；交给原回调决定。 */
      }
    }
    const decision = await options.fallback(descriptor, signal);
    if (target && (decision === 'allow_once' || decision === 'allow_session')) {
      try {
        options.store.approve(target);
      } catch {
        /* 批准持久化失败不阻断本次启动。 */
      }
    }
    return decision;
  };
}
