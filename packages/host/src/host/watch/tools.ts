/**
 * @fileoverview 会话级监视的模型工具（`watch_start` / `watch_cancel`，设计 008 §8）。
 *
 * 约束、边界与为什么：
 * 1. 工具只做「登记 / 取消」：轮询、端口探测与投递全部由宿主 `WatchService` 承担，
 *    工具内绝不阻塞等待条件命中，否则会占住整轮运行并让取消语义失真。
 * 2. 不声明能力位：监视本身不读写工作区文件、不执行命令，`permissions` 保持为空，
 *    从而在 Approval/Auto 下按模式默认询问、在 Plan 下由既有策略直接拒绝。
 * 3. 失败信息使用稳定错误码与中文 safeMessage，模型可见正文不包含本机路径以外的私有状态。
 */

import { type Tool, type WatchKind, defineTool } from '@kiturone/kapibala';
import type { WatchService } from './service.js';

/** `watch_start` 的输入；与 `WatchSpec` 同形，`deadlineAt` 必填以杜绝无限期监视。 */
export interface WatchStartInput {
  [key: string]: unknown;
  kind: WatchKind;
  target: string;
  intervalMs?: number;
  deadlineAt: number;
}

/** `watch_cancel` 的输入。 */
export interface WatchCancelInput {
  [key: string]: unknown;
  watchId: string;
}

/**
 * 创建监视工具集。
 *
 * @param service 当前会话持有的监视服务；缺省时调用方不应注册这些工具，
 *                否则模型会登记一个无人轮询的「假监视」。
 */
export function createWatchTools(service: WatchService): Tool[] {
  const start = defineTool<WatchStartInput, unknown>({
    name: 'watch_start',
    description:
      'Register a session-level watch that wakes this conversation when an external condition is met (file change, owned process exit, or localhost port ready). The current turn ends normally; the host delivers a background notification and resumes one turn when the condition fires or the deadline is reached.',
    metadata: { source: 'builtin', readOnlyHint: false },
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['file_change', 'process_exit', 'port_ready'],
          description:
            'Trigger source. file_change watches a workspace-relative file; process_exit watches a child process started by this session; port_ready watches a localhost TCP port.',
        },
        target: {
          type: 'string',
          description:
            'Watch target: workspace-relative path for file_change, child process id for process_exit, port number for port_ready.',
        },
        intervalMs: {
          type: 'integer',
          minimum: 2000,
          description: 'Polling interval in milliseconds (minimum 2000, default 5000).',
        },
        deadlineAt: {
          type: 'integer',
          description: 'Epoch milliseconds after which the watch is reported as timed out.',
        },
      },
      required: ['kind', 'target', 'deadlineAt'],
    },
    async execute(input) {
      const view = await service.register({
        kind: input.kind,
        target: input.target,
        deadlineAt: input.deadlineAt,
        ...(input.intervalMs !== undefined ? { intervalMs: input.intervalMs } : {}),
      });
      return {
        watchId: view.watchId,
        kind: view.kind,
        target: view.target,
        state: view.state,
        deadlineAt: view.deadlineAt,
      };
    },
  });

  const cancel = defineTool<WatchCancelInput, unknown>({
    name: 'watch_cancel',
    description:
      'Cancel an armed session-level watch. Already fired, timed out, cancelled or orphaned watches cannot be cancelled again.',
    metadata: { source: 'builtin', readOnlyHint: false },
    parameters: {
      type: 'object',
      properties: {
        watchId: { type: 'string', description: 'Identifier returned by watch_start.' },
      },
      required: ['watchId'],
    },
    async execute(input) {
      await service.cancel(input.watchId);
      return { watchId: input.watchId, cancelled: true };
    },
  });

  return [start, cancel];
}
