/**
 * @fileoverview MCP Server 启动授权管理、会话缓存、审计与防漂移复核
 *
 * 约束、边界与为什么：
 * 1. 启动授权与工具调用授权独立：
 *    启动授权（Server 启动进程/连接建立）与工具调用授权（执行某个具体的 tool）是两个分离的独立决策；
 *    启动允许绝不自动放行未授权的高危工具调用。
 * 2. 项目路径信任不等于允许启动：
 *    项目受信任仅代表其 `.kapibala/mcp.json` 的声明可以被读取采用，绝不自动放行启动外部进程或网络连接。
 * 3. 非交互环境零静默放行：
 *    无审批通道或非交互 TTY 环境下，若无显式预授权或已存会话缓存，必须直接拒绝启动并报告 MCP_STARTUP_UNAUTHORIZED。
 * 4. 审批串行化（Sequential Approval）：
 *    多个 Server 并发就绪时，向宿主/用户的启动审批请求必须串行化排队处理，防止终端或界面出现多弹窗竞态。
 * 5. 批准后计时保证：
 *    连接与启动的技术超时计时器（startupTimeoutMs）必须在用户确认批准返回后才开始计时，
 *    用户思考或审阅审批描述符的时间绝不扣除技术连接超时。
 */

import { createHash } from 'node:crypto';
import type { CredentialAlertResult } from './env.js';
import type { CommandTargetInfo } from './path.js';
import { verifyCommandTarget } from './path.js';

/**
 * Server 启动描述符，用于向用户全面展示即将启动的外部服务的物理身份、参数与潜在安全风险。
 */
export interface ServerStartupDescriptor {
  /** 服务唯一名称。 */
  serverName: string;
  /** 配置来源（'global' | 'project'）。 */
  source: 'global' | 'project';
  /** 传输类型（'stdio' | 'http'）。 */
  type: 'stdio' | 'http';
  /** 目标物理可执行文件路径或网络端点 URL。 */
  target: string;
  /** 命令行参数列表（仅 stdio）。 */
  args?: string[];
  /** 规范化工作目录。 */
  cwd?: string;
  /** 注入或使用的环境变量键名列表（仅名称，严禁包含真实凭据值）。 */
  envVarNames?: string[];
  /** 触发 Credential Alert 预警的敏感变量名列表。 */
  credentialAlertVars?: string[];
  /** 本地脚本内容摘要（若绑定了本地脚本）。 */
  scriptDigest?: string;
  /** 是否为必需服务。 */
  required?: boolean;
}

/**
 * 启动授权最终决策结果。
 */
export interface ServerStartAuthorizationResult {
  /** 是否批准启动。 */
  permitted: boolean;
  /** 拒绝或失败原因说明。 */
  reason?: string;
}

/**
 * 启动授权决策选项。
 */
export type ServerStartApprovalDecision =
  | 'allow_once'
  | 'allow_session'
  | 'deny_once'
  | 'deny_session';

/**
 * 宿主启动授权处理回调接口。
 */
export type ServerStartAuthorizer = (
  descriptor: ServerStartupDescriptor,
  signal?: AbortSignal,
) => Promise<ServerStartApprovalDecision>;

/**
 * 启动审计事件回调接口。
 */
export type ServerStartAuditor = (
  event: 'server.requested' | 'server.decided' | 'server.started' | 'server.denied',
  fields: Record<string, unknown>,
) => Promise<void>;

/**
 * Server 启动会话级批准缓存。
 * 深度哈希描述符的关键不可变标识，目标或脚本摘要漂移后旧 allow_session 自动失效。
 */
export class ServerStartupApprovalCache {
  private readonly cache = new Map<string, 'allow' | 'deny'>();

  /**
   * 计算描述符的唯一哈希键。
   */
  computeKey(descriptor: ServerStartupDescriptor): string {
    const payload = [
      descriptor.serverName,
      descriptor.source,
      descriptor.type,
      descriptor.target,
      descriptor.cwd ?? '',
      descriptor.args ?? [],
      descriptor.scriptDigest ?? '',
      descriptor.envVarNames?.slice().sort() ?? [],
    ];
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  get(descriptor: ServerStartupDescriptor): 'allow' | 'deny' | undefined {
    return this.cache.get(this.computeKey(descriptor));
  }

  set(descriptor: ServerStartupDescriptor, decision: 'allow' | 'deny'): void {
    this.cache.set(this.computeKey(descriptor), decision);
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * 协调器配置选项。
 */
export interface ServerStartupCoordinatorOptions {
  /** 宿主授权回调；缺省时在无缓存情况下判定为未授权拒绝。 */
  authorizer?: ServerStartAuthorizer;
  /** 启动授权会话缓存；缺省使用新建实例。 */
  cache?: ServerStartupApprovalCache;
  /** 审计回调。 */
  audit?: ServerStartAuditor;
  /** 是否处于非交互环境（如 CI 或管道）。 */
  isNonInteractive?: boolean;
  /** 宿主硬拒绝名单或条件函数。 */
  hardDenial?: (
    descriptor: ServerStartupDescriptor,
  ) => { denied: boolean; reason?: string } | undefined;
}

/**
 * Server 启动授权协调器：处理审批串行化、缓存命中、漂移检测与审计记录。
 */
export class ServerStartupCoordinator {
  private readonly authorizer?: ServerStartAuthorizer;
  private readonly cache: ServerStartupApprovalCache;
  private readonly audit?: ServerStartAuditor;
  private readonly isNonInteractive: boolean;
  private readonly hardDenial?: (
    descriptor: ServerStartupDescriptor,
  ) => { denied: boolean; reason?: string } | undefined;
  private approvalQueue = Promise.resolve();

  constructor(options: ServerStartupCoordinatorOptions = {}) {
    this.authorizer = options.authorizer;
    this.cache = options.cache ?? new ServerStartupApprovalCache();
    this.audit = options.audit;
    this.isNonInteractive = options.isNonInteractive ?? false;
    this.hardDenial = options.hardDenial;
  }

  /**
   * 请求对给定 Server 启动进行授权。
   *
   * 保证：
   * 1. 串行化进入审批队列，防止并发启动打架；
   * 2. 检查宿主硬拒绝（Hard Denial 优先于任何会话缓存与交互）；
   * 3. 检查缓存命中（allow_session / deny_session）；
   * 4. 非交互环境下无缓存直接拒绝；
   * 5. 若有绑定的可执行目标快照，授权后启动前再次复核防漂移。
   */
  async authorize(
    descriptor: ServerStartupDescriptor,
    options: {
      signal?: AbortSignal;
      commandTarget?: CommandTargetInfo;
    } = {},
  ): Promise<{ permitted: boolean; reason?: string }> {
    // 串行化排队
    return new Promise<{ permitted: boolean; reason?: string }>((resolve, reject) => {
      this.approvalQueue = this.approvalQueue
        .then(async () => {
          try {
            const res = await this.executeAuthorize(descriptor, options);
            resolve(res);
          } catch (err) {
            reject(err);
          }
        })
        .catch(() => {
          /* 保证前一个请求失败不阻断队列后续执行 */
        });
    });
  }

  private async executeAuthorize(
    descriptor: ServerStartupDescriptor,
    options: {
      signal?: AbortSignal;
      commandTarget?: CommandTargetInfo;
    },
  ): Promise<{ permitted: boolean; reason?: string }> {
    const { signal, commandTarget } = options;
    if (signal?.aborted) {
      return { permitted: false, reason: 'Startup authorization cancelled' };
    }

    await this.audit?.('server.requested', {
      serverName: descriptor.serverName,
      type: descriptor.type,
      target: descriptor.target,
      source: descriptor.source,
      hasCredentialAlert: Boolean(
        descriptor.credentialAlertVars && descriptor.credentialAlertVars.length > 0,
      ),
    });

    // 1. 检查宿主硬拒绝
    const hardCheck = this.hardDenial?.(descriptor);
    if (hardCheck?.denied) {
      await this.audit?.('server.denied', {
        serverName: descriptor.serverName,
        reason: hardCheck.reason || 'Denied by host hard rule',
        source: 'hard_rule',
      });
      return {
        permitted: false,
        reason: hardCheck.reason || 'Server startup blocked by host security policy',
      };
    }

    // 2. 检查会话缓存
    const cached = this.cache.get(descriptor);
    if (cached === 'deny') {
      await this.audit?.('server.denied', {
        serverName: descriptor.serverName,
        source: 'session_cache',
      });
      return { permitted: false, reason: 'Server startup denied by session cache' };
    }
    if (cached === 'allow') {
      // 命中允许缓存：若存在可执行目标，依然必须通过防漂移复核！
      if (commandTarget) {
        const driftCheck = verifyCommandTarget(commandTarget);
        if (!driftCheck.valid) {
          await this.audit?.('server.denied', {
            serverName: descriptor.serverName,
            source: 'target_drift',
            reason: driftCheck.reason,
          });
          return { permitted: false, reason: driftCheck.reason };
        }
      }
      await this.audit?.('server.decided', {
        serverName: descriptor.serverName,
        decision: 'allow',
        source: 'session_cache',
      });
      return { permitted: true };
    }

    // 3. 非交互环境防御：无审批通道或非 TTY 严禁默认放行
    if (this.isNonInteractive || !this.authorizer) {
      const reason =
        'Non-interactive environment: server startup requires explicit approval channel';
      await this.audit?.('server.denied', {
        serverName: descriptor.serverName,
        source: 'non_interactive',
        reason,
      });
      return { permitted: false, reason };
    }

    // 4. 调用宿主授权回调进行交互批准
    let decision: ServerStartApprovalDecision;
    try {
      decision = await this.authorizer(descriptor, signal);
    } catch (err: unknown) {
      decision = 'deny_once';
    }

    if (decision === 'allow_session') {
      this.cache.set(descriptor, 'allow');
    } else if (decision === 'deny_session') {
      this.cache.set(descriptor, 'deny');
    }

    const permitted = decision === 'allow_once' || decision === 'allow_session';
    await this.audit?.('server.decided', {
      serverName: descriptor.serverName,
      decision,
      source: 'authorizer',
    });

    if (!permitted) {
      await this.audit?.('server.denied', {
        serverName: descriptor.serverName,
        source: 'authorizer',
        reason: 'User denied startup approval',
      });
      return { permitted: false, reason: 'Server startup was denied by user' };
    }

    // 5. 批准后、执行前再次复核防漂移
    if (commandTarget) {
      const driftCheck = verifyCommandTarget(commandTarget);
      if (!driftCheck.valid) {
        await this.audit?.('server.denied', {
          serverName: descriptor.serverName,
          source: 'target_drift',
          reason: driftCheck.reason,
        });
        return { permitted: false, reason: driftCheck.reason };
      }
    }

    return { permitted: true };
  }
}
