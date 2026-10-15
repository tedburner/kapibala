/**
 * @fileoverview MCP 工具到 Core Tool 契约适配器
 *
 * 约束与边界：
 * 1. 完整实现 Core Tool 契约（name, description, parameters, metadata）；
 * 2. 声明通用 Capability external:call（HTTP 再追加 net:outbound）；默认 dangerous: true 与 managesTimeout: true；
 * 3. 严格实现无副作用 validateInput：在审批与发送前利用 Standard Schema 预检参数快照，校验失败零审批零发送；
 * 4. executionIdentity 绑定 serverIdentity, connectionGeneration, catalogEpoch 与 toolDigest，防止同名工具逃逸；
 * 5. 底层出队前同步微任务复核：所有异步准备、审批与审计完成后，在实际调用 client.callTool() 的同一同步微任务中
 *    复核当前连接代次与 catalogEpoch，若期间发生断连或目录变更，严格零发送并直接报错拒绝，不转调同名新实例。
 */

import {
  type Capability,
  PreDispatchError,
  type Tool,
  type ToolContext,
  type ToolExecutionIdentity,
  type ToolExecutionResult,
  type ToolInputValidation,
} from '@kiturone/kapibala';
import { fromJsonSchema } from '@modelcontextprotocol/client';
import type { McpClientSession } from '../client.js';
import { convertMcpToolResponse } from '../results/converter.js';
import type { CandidateMcpTool } from './budget.js';

/**
 * MCP 工具适配器构建选项。
 */
export interface CreateMcpToolAdapterOptions {
  /** 候选工具元数据。 */
  candidate: CandidateMcpTool;
  /** 所属 MCP 客户端会话提供者（支持动态获取当前活跃会话）。 */
  getSession: () => McpClientSession | undefined;
  /** 绑定捕获时的连接代次。 */
  targetGeneration: number;
  /** 绑定捕获时的 Tools 目录纪元。 */
  targetCatalogEpoch: number;
  /** 是否需要 net:outbound 权限（如 HTTP 传输服务），默认 false。 */
  requireNetOutbound?: boolean;
  /** 请求级调用超时时间（毫秒），默认 60000ms。 */
  requestTimeoutMs?: number;
}

/**
 * 根据 CandidateMcpTool 构建合规的 Core Tool 实例。
 *
 * @param options - 适配器构建选项。
 * @returns 适配后的 Core Tool。
 */
export function createMcpToolAdapter(options: CreateMcpToolAdapterOptions): Tool {
  const {
    candidate,
    getSession,
    targetGeneration,
    targetCatalogEpoch,
    requireNetOutbound = false,
    requestTimeoutMs = 60000,
  } = options;

  const permissions: Capability[] = ['external:call'];
  if (requireNetOutbound) {
    permissions.push('net:outbound');
  }

  // 预编译参数校验器（利用 @modelcontextprotocol/client 的 fromJsonSchema）
  let standardValidator: any = null;
  try {
    standardValidator = fromJsonSchema(candidate.inputSchema as any);
  } catch {
    /* 容忍无法编译 Schema，退化为运行时校验 */
  }

  const tool: Tool = {
    name: candidate.normalizedName,
    description: candidate.description,
    parameters: candidate.inputSchema,
    metadata: {
      source: `mcp:${candidate.serverName}`,
      dangerous: true,
      managesTimeout: true,
      permissions,
      readOnlyHint: Boolean((candidate as any).readOnlyHint),
    },

    /**
     * 无副作用最终参数预检校验。
     *
     * 校验、权限审批与发送共享同一最终参数快照；校验失败直接拒绝，零审批零发送。
     */
    validateInput(input: Record<string, unknown>): ToolInputValidation {
      if (!standardValidator || !standardValidator['~standard']) {
        return { valid: true };
      }

      try {
        const result = standardValidator['~standard'].validate(input);
        if (result && !result.issues && !result.issues?.length) {
          return { valid: true };
        }

        const issues = result.issues ?? [];
        const message = issues.map((i: any) => i.message || 'Validation failed').join('; ');
        return {
          valid: false,
          message: `MCP parameter validation rejected: ${message}`,
        };
      } catch (err: unknown) {
        return {
          valid: false,
          message: `MCP parameter validation exception: ${(err as Error).message}`,
        };
      }
    },

    /**
     * 绑定精确执行身份供审批缓存与发送前复核。
     */
    executionIdentity(): ToolExecutionIdentity {
      return {
        serverIdentity: candidate.serverName,
        connectionGeneration: targetGeneration,
        catalogEpoch: targetCatalogEpoch,
        toolDigest: candidate.toolDigest,
      };
    },

    /**
     * 执行 MCP 工具调用。
     *
     * 在底层出队前同一同步微任务中完成同步资格复核，复核至底层 transport 发送之间绝无 await 让步。
     */
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
      const session = getSession();

      // =====================================================================
      // 【关键安全保证】：发送前同一同步微任务复核（无 await 让步）
      // =====================================================================
      if (!session || session.connectionState !== 'ready') {
        throw new PreDispatchError(
          `MCP_SERVER_UNAVAILABLE: Server '${candidate.serverName}' is not in ready state (state=${session?.connectionState ?? 'missing'})`,
          {
            code: 'MCP_SERVER_UNAVAILABLE',
            retryPolicy: 'after_user_action',
            safeMessage: `MCP server '${candidate.serverName}' is unavailable`,
          },
        );
      }

      if (session.generation !== targetGeneration) {
        throw new PreDispatchError(
          `MCP_TOOL_CHANGED: Server '${candidate.serverName}' reconnected (generation changed from ${targetGeneration} to ${session.generation})`,
          {
            code: 'MCP_TOOL_CHANGED',
            retryPolicy: 'after_user_action',
            safeMessage: `MCP server '${candidate.serverName}' reconnected`,
          },
        );
      }

      if (session.toolsCatalogEpoch !== targetCatalogEpoch) {
        throw new PreDispatchError(
          `MCP_TOOL_CHANGED: Server '${candidate.serverName}' tools catalog changed (epoch changed from ${targetCatalogEpoch} to ${session.toolsCatalogEpoch})`,
          {
            code: 'MCP_TOOL_CHANGED',
            retryPolicy: 'after_user_action',
            safeMessage: `MCP server '${candidate.serverName}' catalog changed`,
          },
        );
      }

      // 执行底层发送，带受控 requestTimeoutMs 限制
      const timeoutMs = requestTimeoutMs ?? 60000;
      const callAbortController = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        callAbortController.abort();
      }, timeoutMs);

      const abortFromCtx = () => callAbortController.abort();
      if (ctx.signal) {
        if (ctx.signal.aborted) callAbortController.abort();
        else ctx.signal.addEventListener('abort', abortFromCtx, { once: true });
      }

      try {
        return await session.client.callTool(
          {
            name: candidate.rawName,
            arguments: input,
          },
          {
            signal: callAbortController.signal,
          },
        );
      } catch (err: unknown) {
        return {
          __isMcpDispatchedError: true,
          error: timedOut
            ? `MCP tool call timed out after ${timeoutMs}ms`
            : err instanceof Error
              ? err.message
              : String(err),
        };
      } finally {
        clearTimeout(timer);
        if (ctx.signal) {
          ctx.signal.removeEventListener('abort', abortFromCtx);
        }
      }
    },

    /**
     * 规范化转换为 Core ToolExecutionResult（opt-in execution v1 元数据）。
     */
    toExecutionResult(raw: unknown): ToolExecutionResult {
      if (
        raw instanceof PreDispatchError ||
        (raw && typeof raw === 'object' && (raw as Record<string, unknown>).__isMcpPreDispatchError)
      ) {
        const obj = raw as any;
        return {
          content:
            obj.safeMessage ??
            String(obj.error ?? obj.message ?? 'MCP tool pre-dispatch check failed'),
          isError: true,
          errorCode: String(obj.code ?? 'MCP_SERVER_UNAVAILABLE'),
          retryPolicy: obj.retryPolicy ?? 'after_user_action',
          execution: {
            version: 1,
            dispatchOutcome: 'not_sent',
          },
        };
      }
      if (
        raw &&
        typeof raw === 'object' &&
        (raw as Record<string, unknown>).__isMcpDispatchedError
      ) {
        const obj = raw as Record<string, unknown>;
        return {
          content: `MCP tool execution interrupted after dispatch: ${String(obj.error ?? 'unknown error')}`,
          isError: true,
          errorCode: 'OUTCOME_UNKNOWN',
          retryPolicy: 'after_user_action',
          execution: {
            version: 1,
            dispatchOutcome: 'unknown',
          },
        };
      }
      return convertMcpToolResponse(raw);
    },
  };

  return tool;
}
