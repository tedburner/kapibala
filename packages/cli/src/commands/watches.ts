/**
 * @fileoverview 会话级监视命令（`/watches`，v0.1.4 设计 008 §8）。
 *
 * 约束、边界与为什么：
 * 1. 术语固定为「监视 / 监视中 / 已触发 / 已超时 / 已取消 / 已失联」，
 *    不得与 `Schedule` 的「定时任务」或「后台任务」混用。
 * 2. 只读列表不触碰会话存储（服务内存即当前事实）；`cancel` 属于变更操作，
 *    由命令目录的 `mutates` 门禁保证会话忙碌时不会插入。
 * 3. 当前宿主没有布置触发源时明确说明原因，绝不返回空列表冒充「没有任何监视」。
 */

import type { WatchView } from '@kiturone/kapibala-host/internal';
import { resolveCommandOutput } from '../command-output.js';
import { getActiveWatchService } from '../watch-context.js';
import type { CommandHandler } from './dispatcher.js';

/** 状态词与设计 008 §8 完全一致；顺序即列表排序优先级。 */
const STATE_LABELS: Record<WatchView['state'], string> = {
  armed: '监视中',
  fired: '已触发',
  timeout: '已超时',
  cancelled: '已取消',
  orphaned: '已失联',
};

// WatchKind 已收窄为 'file_change' | 'port_ready'；process_exit 触发源摘除后不再出现在标签表。
const KIND_LABELS: Record<WatchView['kind'], string> = {
  file_change: '文件变化',
  port_ready: '端口就绪',
};

/** 剩余时间只用于「监视中」；终态没有倒计时语义。 */
function remaining(item: WatchView, now: number): string {
  if (item.state !== 'armed') return '';
  const ms = Math.max(0, item.deadlineAt - now);
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  return minutes > 0 ? ` 剩 ${minutes}m${seconds}s` : ` 剩 ${seconds}s`;
}

/**
 * `/watches`：列出当前会话的全部监视。
 * `/watches cancel <watchId>`：取消一条仍在监视中的条目。
 */
export const watchesCommand: CommandHandler = async (args, ctx) => {
  const output = resolveCommandOutput(ctx);
  const service = getActiveWatchService();
  if (!service) {
    output.log('当前宿主没有布置监视触发源（委派会话或单次问答不支持监视）。');
    return;
  }

  if (args.length === 0) {
    const items = service.list();
    if (items.length === 0) {
      output.log('当前会话没有登记任何监视。');
      return;
    }
    const now = Date.now();
    output.log(`会话监视列表（共 ${items.length} 个）:`);
    for (const item of items) {
      const state = STATE_LABELS[item.state];
      const detail = item.detail ? ` — ${item.detail}` : '';
      output.log(
        `• [${item.watchId}] ${KIND_LABELS[item.kind]} ${item.target} · ${state}${remaining(item, now)}${detail}`,
      );
    }
    return;
  }

  if (args[0] === 'cancel') {
    const watchId = args[1]?.trim();
    if (!watchId) {
      output.log('用法: /watches cancel <watchId>');
      return;
    }
    try {
      await service.cancel(watchId);
      output.log(`已取消监视: ${watchId}`);
    } catch (error) {
      output.error(`取消失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
    return;
  }

  output.log('用法: /watches [cancel <watchId>]');
};
