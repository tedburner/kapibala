/**
 * @fileoverview CLI 宿主侧的「当前会话监视服务」持有者。
 *
 * 为什么需要这一层：
 * - `WatchService` 必须在构造时拿到「自动续跑」回调，而该回调只有在 REPL 装配完成后
 *   （`runTask` 可用）才存在，因此服务与续跑钩子分两步注入；
 * - `/watches` 命令只拿得到 `CommandContext`，拿不到会话内部服务，故由宿主持有并在
 *   会话切换时替换；替换时旧服务立即释放定时器，绝不留下无人认领的轮询。
 */

import type { WatchService } from '@kiturone/kapibala-host/internal';

let activeService: WatchService | undefined;
let resumeHook: ((input: string, signal: AbortSignal) => Promise<void>) | undefined;

/**
 * 替换当前活动会话的监视服务。
 *
 * 旧服务在此处 `dispose()`：它属于上一个会话，继续轮询只会在错误的历史上追加通知。
 */
export function setActiveWatchService(service: WatchService | undefined): void {
  if (activeService && activeService !== service) activeService.dispose();
  activeService = service;
}

/** 当前会话的监视服务；未装配（如委派会话、单次问答）时返回 undefined。 */
export function getActiveWatchService(): WatchService | undefined {
  return activeService;
}

/** 注入自动续跑实现；由 REPL 在 `runTask` 就绪后调用，保证复用同一渲染与取消语义。 */
export function setWatchResumeHook(
  hook: ((input: string, signal: AbortSignal) => Promise<void>) | undefined,
): void {
  resumeHook = hook;
}

/** 监视服务内部调用；钩子缺席时明确失败，让服务保留待投递队列而不是假装续跑成功。 */
export async function runWatchResume(input: string, signal: AbortSignal): Promise<void> {
  if (!resumeHook) throw new Error('WATCH_RESUME_UNAVAILABLE');
  await resumeHook(input, signal);
}
