import type { ToolDefinition } from '../../types/index.js';
import type { ShellScope } from '../security/permissions.js';
export type { ToolDefinition };

/** 执行能力的最小分类；权限规则、模式裁决与工具元数据声明共用这一词汇表。 */
export type Capability =
  | 'fs:read'
  | 'fs:write'
  | 'exec'
  | 'net:outbound'
  | 'env:read'
  | 'agent:spawn';

export interface ToolMetadata {
  /** 注册来源标记（如 'builtin'）；注册表据此执行冲突策略并支持按源注销。 */
  source?: string;
  /** 标记危险工具；未命中 allow 规则时，非 FullAccess 模式一律降级为 ask 而非按模式默认放行。 */
  dangerous?: boolean;
  /** 所需能力的声明；v0.0.1 不据此授权，v0.0.2 的执行前权限决策才会消费。 */
  permissions?: Capability[];
  /** 工具自身等待进程资源回收，执行器不可再使用通用 Promise.race 超时。 */
  managesTimeout?: boolean;
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

/** 工具契约；parameters 是 JSON Schema，模型只能看到经 toToolDefinition 投影后的三个字段。 */
export interface Tool<TInput = Record<string, unknown>, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>; // JSON Schema
  readonly metadata?: ToolMetadata;
  /** 声明本次输入的精确执行目标，供审批展示与执行前指纹复核；无固定执行目标的工具不实现。 */
  approvalScope?(input: TInput, rootDir: string): ShellScope;
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
