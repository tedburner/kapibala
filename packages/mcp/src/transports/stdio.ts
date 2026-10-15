/**
 * @fileoverview MCP Stdio 客户端传输封装与生命周期管理
 *
 * 约束与边界：
 * 1. 启动命令优先基于已解析并复核的物理绝对路径，拒绝保留设备名与未受控路径；
 * 2. 严格使用最小化白名单环境与配置显式环境变量，禁止盲目透传整份 process.env；
 * 3. 实时捕获子进程 stderr 至有界 8 KiB 缓存，剥离 ANSI 码用于诊断，不污染 stdout JSON-RPC 协议通道；
 * 4. 退出清理必须彻底回收进程树（包含包装进程与后代孙子进程），并在有界超时内确认进程退出。
 */

import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { StdioServerConfig } from '../config.js';
import { buildStdioProcessEnv } from '../env.js';
import { resolveCommandTarget, resolveServerCwd } from '../path.js';
import { isProcessAlive, killProcessTree } from './process-tree.js';
import { BoundedStderrBuffer } from './stderr.js';

/**
 * 受管 Stdio 传输句柄接口。
 */
export interface ManagedStdioTransport {
  /** 官方 SDK 底层 StdioClientTransport 实例。 */
  readonly transport: StdioClientTransport;
  /** 绑定的有界 stderr 尾部诊断缓存。 */
  readonly stderrBuffer: BoundedStderrBuffer;
  /** 获取底层子进程 PID，未启动或已销毁返回 null。 */
  getPid(): number | null;
  /** 探测底层子进程当前是否依然存活。 */
  isAlive(): boolean;
  /**
   * 优雅关闭传输连接并彻底回收子进程树。
   *
   * 保证幂等执行，重复调用安全返回同一 Promise。
   *
   * @param cleanupTimeoutMs - 回收超时时间（毫秒），默认 5000ms。
   * @returns 进程树完全回收返回 true，超时仍有残留返回 false。
   */
  close(cleanupTimeoutMs?: number): Promise<boolean>;
  /** 传输是否已被显式关闭。 */
  readonly isClosed: boolean;
}

/**
 * Stdio 传输创建配置选项。
 */
export interface CreateStdioTransportOptions {
  /** 声明所属的物理配置根目录（用于 cwd 解析）。 */
  configDir?: string;
  /** 宿主项目物理根目录。 */
  projectRoot?: string;
  /** 配置来源，用于敏感凭据告警检测，默认 'global'。 */
  source?: 'global' | 'project';
  /** stderr 最大缓存字节数，默认 8192 (8 KiB)。 */
  maxStderrBytes?: number;
}

/**
 * 根据 StdioServerConfig 创建并初始化受管 Stdio 传输实例。
 *
 * @param config - 已校验的 Stdio 服务配置。
 * @param options - 传输构建选项。
 * @returns 受管 Stdio 传输句柄。
 */
export function createManagedStdioTransport(
  config: StdioServerConfig,
  options: CreateStdioTransportOptions = {},
): ManagedStdioTransport {
  const defaultProjectRoot = process.cwd();
  const projectRoot = options.projectRoot ?? defaultProjectRoot;
  const configDir = options.configDir ?? projectRoot;
  const source = options.source ?? 'global';

  // 1. 确定工作目录绝对物理路径
  const cwdResult = resolveServerCwd(config.cwd, source, projectRoot, configDir);
  if (cwdResult.error) {
    throw new Error(`Failed to resolve Stdio cwd: ${cwdResult.error}`);
  }
  const cwd = cwdResult.cwd;

  // 2. 准备受控最小化执行环境
  const envResult = buildStdioProcessEnv({
    configuredEnv: config.env,
    source,
  });
  if (envResult.error) {
    throw new Error(`Failed to resolve Stdio environment: ${envResult.error}`);
  }
  const env = envResult.env ?? {};

  // 3. 确定并复核目标命令物理路径
  const targetResult = resolveCommandTarget(config.command, cwd, config.args, env.PATH);
  if (targetResult.error || !targetResult.target) {
    throw new Error(`Failed to resolve Stdio command: ${targetResult.error ?? 'unknown error'}`);
  }
  const commandTarget = targetResult.target.executablePath;

  // 4. 构建有界 stderr 缓存
  const stderrBuffer = new BoundedStderrBuffer(options.maxStderrBytes);

  // 5. 实例化官方 StdioClientTransport，并显式指定 stderr: 'pipe'
  const transport = new StdioClientTransport({
    command: commandTarget,
    args: config.args,
    cwd,
    env,
    stderr: 'pipe',
  });

  // 6. 挂载 stderr 监听器捕获子进程错误输出
  const stderrStream = transport.stderr;
  let onDataHandler: ((chunk: Buffer | string) => void) | null = null;
  if (stderrStream && typeof (stderrStream as any).on === 'function') {
    onDataHandler = (chunk: Buffer | string) => {
      stderrBuffer.append(chunk);
    };
    (stderrStream as any).on('data', onDataHandler);
  }

  let closed = false;
  let closingPromise: Promise<boolean> | null = null;

  const managed: ManagedStdioTransport = {
    transport,
    stderrBuffer,
    getPid(): number | null {
      return transport.pid;
    },
    isAlive(): boolean {
      const pid = transport.pid;
      return pid !== null && isProcessAlive(pid);
    },
    get isClosed(): boolean {
      return closed;
    },
    async close(cleanupTimeoutMs = 5000): Promise<boolean> {
      if (closingPromise) return closingPromise;

      closingPromise = (async () => {
        closed = true;
        const pid = transport.pid;

        // 解除 stderr 监听句柄以防句柄泄漏
        if (
          stderrStream &&
          onDataHandler &&
          typeof (stderrStream as any).removeListener === 'function'
        ) {
          try {
            (stderrStream as any).removeListener('data', onDataHandler);
          } catch {
            /* 忽略监听移除异常 */
          }
          onDataHandler = null;
        }

        // 阶段 1：尝试通过 transport 正常关闭（关闭 stdin，发送 SIGTERM）
        try {
          await transport.close();
        } catch {
          /* 忽略关闭阶段普通网络/IO错误 */
        }

        // 阶段 2：核查 PID，若子进程或包装后代仍然存活，升级回收进程树
        if (pid !== null && isProcessAlive(pid)) {
          return killProcessTree(pid, { timeoutMs: cleanupTimeoutMs });
        }

        return true;
      })();

      return closingPromise;
    },
  };

  return managed;
}
