import type { SessionMode } from '@kiturone/kapibala';
import type { CommandHandler } from './dispatcher.js';

const MODES: Record<string, SessionMode> = {
  approval: 'Approval',
  plan: 'Plan',
  auto: 'Auto',
  'full-access': 'FullAccess',
};

/**
 * 查看或切换权限模式。FullAccess 属高危：必须在交互终端显式确认后才切换，
 * 未提供 confirm 回调（非交互宿主）时直接拒绝，不静默放行。
 */
export const modeCommand: CommandHandler = async (args, ctx) => {
  const requested = args[0]?.toLowerCase();
  if (!requested) {
    console.log(`当前权限模式: ${ctx.session.getMode()}`);
    console.log('可选: approval | plan | auto | full-access');
    return;
  }
  const mode = MODES[requested];
  if (!mode) throw new Error(`未知权限模式: ${requested}`);
  if (mode === 'FullAccess') {
    if (!ctx.confirm) throw new Error('FullAccess 需要交互终端显式确认');
    const confirmed =
      (await ctx.confirm?.('FullAccess 将默认批准已注册且已声明能力的工具调用。')) ?? false;
    if (!confirmed) {
      console.log('已取消切换 FullAccess。');
      return;
    }
  }
  ctx.session.switchMode(mode);
  console.log(`当前权限模式: ${mode}`);
};
