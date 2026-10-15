/**
 * @fileoverview MCP 传输、能力状态机与生命周期类型定义
 *
 * 约束与边界：
 * 1. 明确分离底层连接状态（ServerConnectionState）与高层目录能力状态（CapabilityCatalogState）；
 * 2. 状态机禁止混合 Server 连接就绪与特定能力就绪（如连接 ready 不等于 tools ready）；
 * 3. 严格定义 generation/epoch/refreshToken 契约，防止过期异步回调与重连竞态污染。
 */

import type { ServerConfig } from './config.js';

/**
 * MCP Server 底层连接状态。
 *
 * 状态机跃迁契约：
 * - `disabled`: 配置显式禁用（`enabled: false`），不尝试建立连接；
 * - `blocked`: 启动审批被拒绝或未受信任，连接被阻断；
 * - `connecting`: 正在拉起子进程或建立网络传输，并进行协议版本协商；
 * - `ready`: 传输建立完成且初始化握手（InitializeRequest）成功；
 * - `failed`: 启动超时、握手失败、鉴权失败或进程非预期退出；
 * - `disconnected`: 正常主动关闭或在未报错情况下连接断开；
 * - `closing`: 正在执行优雅关闭、取消在途请求与回收进程树。
 */
export type ServerConnectionState =
  | 'disabled'
  | 'blocked'
  | 'connecting'
  | 'ready'
  | 'failed'
  | 'disconnected'
  | 'closing';

/**
 * MCP Server 单项目录能力状态（Tools 或 Prompts 独立维护）。
 *
 * 状态机跃迁契约：
 * - `unsupported`: 服务端 capabilities 未声明该能力（例如 Prompt-only Server 无 tools 能力），此时严禁向其发送对应 list 请求；
 * - `pending`: 正在获取初始目录或分页加载中；
 * - `ready`: 目录已成功获取并发布；
 * - `stale`: 收到服务端变更通知但在刷新中，或刷新耗尽超时保持过时状态；
 * - `unavailable`: 目录获取失败、内容校验异常或服务端报告能力不可用。
 */
export type CapabilityCatalogState = 'unsupported' | 'pending' | 'ready' | 'stale' | 'unavailable';

/**
 * MCP 协议协商模式。
 *
 * - `legacy`: 强制使用 2024-11-05 协议握手；
 * - `modern`: 强制使用 2025-11-25 协议握手；
 * - `auto`: 自动协商，优先协商双方最高兼容版本。
 */
export type McpProtocolMode = 'legacy' | 'auto' | 'modern';

/**
 * MCP Server 运行时状态快照。
 */
export interface McpServerStatus {
  /** 服务端唯一标识名称。 */
  name: string;
  /** 传输连接状态。 */
  connectionState: ServerConnectionState;
  /** 工具能力目录状态。 */
  toolsState: CapabilityCatalogState;
  /** 提示词能力目录状态。 */
  promptsState: CapabilityCatalogState;
  /** 连接代次，每次重新建立连接时单调递增。 */
  generation: number;
  /** Tools 目录纪元，收到 tools 变更通知或重新加载时单调递增。 */
  toolsCatalogEpoch: number;
  /** Prompts 目录纪元，收到 prompts 变更通知或重新加载时单调递增。 */
  promptsCatalogEpoch: number;
  /** 协商成功的协议版本（如 '2024-11-05' 或 '2025-11-25'）。 */
  protocolVersion?: string;
  /** 服务端汇报的元数据信息（名称与版本）。 */
  serverInfo?: {
    name: string;
    version: string;
  };
  /** 发生失败时的诊断错误信息。 */
  errorMessage?: string;
  /** Stdio 进程的标准错误尾部脱敏诊断切片（最大 8 KiB）。 */
  stderrTail?: string;
  /** 关联的子进程 PID（仅 Stdio 传输有效）。 */
  pid?: number | null;
}

/**
 * MCP 单 Server 启动配置选项。
 */
export interface ServerStartupOptions {
  /** 启动超时时间（毫秒），默认 10000ms。 */
  startupTimeoutMs?: number;
  /** 目录发现超时时间（毫秒），默认 10000ms。 */
  catalogTimeoutMs?: number;
  /** 本地清理超时时间（毫秒），默认 5000ms。 */
  cleanupTimeoutMs?: number;
  /** 显式取消信号。 */
  signal?: AbortSignal;
}

/**
 * 整体 MCP 会话管理器启动选项。
 */
export interface McpManagerOptions {
  /** 最大并发启动服务数量，默认 4。 */
  maxConcurrentStartups?: number;
  /** 整体启动截止时间（毫秒），默认 15000ms。 */
  overallDeadlineMs?: number;
  /** 单服务启动超时时间（毫秒），默认 10000ms。 */
  startupTimeoutMs?: number;
  /** 单服务目录发现超时时间（毫秒），默认 10000ms。 */
  catalogTimeoutMs?: number;
  /** 单服务清理超时时间（毫秒），默认 5000ms。 */
  cleanupTimeoutMs?: number;
  /** 显式取消信号。 */
  signal?: AbortSignal;
  /** 启动授权处理回调。 */
  authorizer?: import('./auth.js').ServerStartAuthorizer;
  /** 会话级启动授权缓存。 */
  startupCache?: import('./auth.js').ServerStartupApprovalCache;
  /** 预配置的启动协调器。 */
  startupCoordinator?: import('./auth.js').ServerStartupCoordinator;
}

/**
 * MCP 启动结果概览。
 */
export interface McpStartupResult {
  /** 整体启动是否成功（所有 required 服务必须就绪，可选服务失败不阻断）。 */
  success: boolean;
  /** 成功连接并就绪的服务列表。 */
  readyServers: string[];
  /** 失败或被阻断的服务状态记录表。 */
  failedServers: Record<string, string>;
  /** 所有服务的运行状态快照。 */
  statuses: McpServerStatus[];
}
