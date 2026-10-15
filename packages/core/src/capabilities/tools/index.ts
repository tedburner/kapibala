import type { ToolDefinition, ToolResultExecution } from '../../types/index.js';
import type { ShellScope } from '../security/permissions.js';
export type { ToolDefinition, ToolResultExecution };

/** 执行能力的最小分类；权限规则、模式裁决与工具元数据声明共用这一词汇表。 */
export type Capability =
  | 'fs:read'
  | 'fs:write'
  | 'exec'
  | 'net:outbound'
  | 'env:read'
  | 'agent:spawn'
  | 'external:call';

/**
 * 外部调用的精确执行身份；供审批缓存、发送前复核与审计消费。
 * 包含服务端物理身份、连接代次、目录 epoch 与定义摘要等不可伪造字段。
 */
export interface ToolExecutionIdentity {
  serverIdentity?: string;
  connectionGeneration?: number;
  catalogEpoch?: number;
  toolDigest?: string;
  [key: string]: unknown;
}

/**
 * 显式 opt-in 规范化执行结果；普通对象返回值保持兼容不强制包装。
 */
export interface ToolExecutionResult {
  content: string;
  isError?: boolean;
  errorCode?: string;
  retryPolicy?: 'never' | 'after_user_action';
  execution?: ToolResultExecution;
}

export interface ToolMetadata {
  /** 注册来源标记（如 'builtin'）；注册表据此执行冲突策略并支持按源注销。 */
  source?: string;
  /** 标记危险工具；未命中 allow 规则时，非 FullAccess 模式一律降级为 ask 而非按模式默认放行。 */
  dangerous?: boolean;
  /** 所需能力的声明；v0.0.1 不据此授权，v0.0.2 的执行前权限决策才会消费。 */
  permissions?: Capability[];
  /** 工具自身等待进程资源回收，执行器不可再使用通用 Promise.race 超时。 */
  managesTimeout?: boolean;
  /** 只读提示；工具声明自身无副作用，供 UI 展示与只读过滤参考。 */
  readOnlyHint?: boolean;
}

/** 工具执行期由宿主注入的运行环境；信号取消后工具应尽快清理在途资源再返回。 */
export interface ToolContext {
  /** 本次执行的沙箱根目录；文件类工具以此为界解析相对路径并拒绝越界。 */
  rootDir: string;
  signal?: AbortSignal;
  logger?: (message: string) => void;
  /** 命令工具在真实进程创建后调用；审计失败时须先回收进程再报告结果未知。 */
  onProcessSpawned?: () => Promise<void>;
  onProgress?: (progress: { elapsedMs: number; outputBytes: number }) => void;
}

/**
 * 工具输入参数校验结果；valid 为 false 或抛出异常均阻止审批和发送。
 */
export interface ToolInputValidation {
  valid: boolean;
  message?: string;
}

/** 工具契约；parameters 是 JSON Schema，模型只能看到经 toToolDefinition 投影后的三个字段。 */
export interface Tool<TInput = Record<string, unknown>, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>; // JSON Schema
  readonly metadata?: ToolMetadata;
  /** 声明本次输入的精确执行目标，供审批展示与执行前指纹复核；无固定执行目标的工具不实现。 */
  approvalScope?(input: TInput, rootDir: string): ShellScope;
  /** 本次执行身份；审批缓存与执行前复核消费，缺省保持旧工具规则。 */
  executionIdentity?(input: TInput, rootDir: string): ToolExecutionIdentity;
  /** 无副作用地校验最终参数，不修改参数、不访问远端；异常与拒绝均阻止审批和发送。 */
  validateInput?(input: TInput): ToolInputValidation | undefined;
  /** 显式 opt-in 转换为标准执行结果；未提供时普通返回值继续作为常规输出。 */
  toExecutionResult?(raw: TOutput): ToolExecutionResult;
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
}

/** 恒等构造器：只为工具实现提供类型推断与统一书写形式，不产生任何运行时包装。 */
export function defineTool<TInput = Record<string, unknown>, TOutput = unknown>(
  tool: Tool<TInput, TOutput>,
): Tool<TInput, TOutput> {
  return tool;
}

/** 投影为模型可见的工具描述；刻意丢弃 metadata 与 approvalScope，执行侧信息不进入协议。 */
export function toToolDefinition(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}
