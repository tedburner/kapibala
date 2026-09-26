import type { SessionMode } from '@kiturone/kapibala';
import type { CommandHandler } from './dispatcher.js';

const MODES: Record<string, SessionMode> = {
  approval: 'Approval',
  plan: 'Plan',
  auto: 'Auto',
  'full-access': 'FullAccess',
};

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
