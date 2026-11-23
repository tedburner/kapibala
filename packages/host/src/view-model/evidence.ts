/**
 * 会话看板（设计 010）的只读投影类型。
 *
 * 约束与边界：
 * - 全部字段来自 canonical 历史的聚合结果，不估算、不推测；历史缺失的调用以 `missing`
 *   显式表达，而不是补 0；
 * - 只承载展示所需的最小事实，不携带 Provider 私有载荷、原始文件内容或运行时句柄；
 * - 可空字段统一用 `null`（而不是 undefined），便于协议 JSON Schema 与桌面 strict schema
 *   使用同一套显式口径。
 */

/** 头部摘要行；数字全部为真实聚合结果，缺失事实单独计入 missing/truncated。 */
export interface ViewEvidenceSummary {
  readonly additions: number;
  readonly deletions: number;
  /** 行数超出预算、只知「有变更」但无精确数字的文件调用数。 */
  readonly truncatedFiles: number;
  /** 成功写入但历史里没有行数事实的调用数（旧记录）。 */
  readonly missingFiles: number;
  readonly references: number;
  readonly mcpCalls: number;
  readonly mcpFailures: number;
  /** 父会话仍在运行、且子任务处于活动态的委派数。 */
  readonly runningDelegations: number;
}

/** 单次文件写入的证据状态；`missing` 表示历史没有落盘事实，显示「未记录」。 */
export type ViewEvidenceChangeStatus = 'recorded' | 'truncated' | 'missing';

/** 一次成功写入调用的行数事实；同一文件多次编辑按调用逐条出现。 */
export interface ViewEvidenceChangeFile {
  readonly path: string;
  /** 对应工具调用 ID，用于跳转既有工具详情抽屉。 */
  readonly callId: string;
  readonly status: ViewEvidenceChangeStatus;
  /** 仅 status 为 recorded 时存在；truncated/missing 一律为 null。 */
  readonly additions: number | null;
  readonly deletions: number | null;
}

/** 一条跨会话引用；只保留溯源身份，不复制被引用正文。 */
export interface ViewEvidenceReference {
  readonly sessionId: string;
  readonly recordId: string;
  readonly role: 'user' | 'assistant' | 'branch_summary';
  readonly timestamp: number;
  readonly title: string | null;
}

/** 按 MCP 服务器聚合的调用计数；失败态只取工具结果的 isError 事实。 */
export interface ViewEvidenceMcpServer {
  readonly server: string;
  readonly calls: number;
  readonly failed: number;
}

/**
 * 委派分区状态：
 * - `running`：父会话仍在运行且子任务活动；
 * - `ended`：父会话已收尾但子任务仍未终结，明确标为已结束而不是假装完成；
 * - `finished`：子任务已到终态；
 * - `idle`：没有运行时任务（可能跨进程），可续聊；
 * - `archived`：会话已归档且没有运行时任务。
 */
export type ViewEvidenceDelegationState = 'running' | 'ended' | 'finished' | 'idle' | 'archived';

/** 父会话视角的一条委派会话；运行状态与 `/delegations` 同源。 */
export interface ViewEvidenceDelegation {
  readonly sessionId: string;
  readonly title: string;
  readonly taskName: string;
  readonly state: ViewEvidenceDelegationState;
  /** 终态摘要或错误；运行中与 idle 通常为 null。 */
  readonly summary: string | null;
  readonly lastActivityAt: number;
}

/** 会话看板完整只读投影；四个分区始终存在，空会话表现为空数组与零摘要。 */
export interface ViewEvidence {
  readonly summary: ViewEvidenceSummary;
  /** 数组保持可变类型：wire 结果 schema 的等价校验要求与 JSON 数组形状一致。 */
  readonly changes: ViewEvidenceChangeFile[];
  readonly references: ViewEvidenceReference[];
  readonly mcp: ViewEvidenceMcpServer[];
  readonly delegations: ViewEvidenceDelegation[];
}
