import type { CommandHandler } from './dispatcher.js';

export const helpCommand: CommandHandler = () => {
  console.log('\n\x1b[36m=== Kapibala (kpbl) 内置命令帮助 ===\x1b[0m');
  console.log('  \x1b[33m/model\x1b[0m                   查看当前模型及可用 profile 列表');
  console.log('  \x1b[33m/model <id>\x1b[0m              热切换当前使用的模型');
  console.log('  \x1b[33m/model key [id]\x1b[0m          更新当前或指定模型的 API Key');
  console.log('  \x1b[33m/model setup\x1b[0m             重新唤起交互式模型配置向导');
  console.log('  \x1b[33m/settings\x1b[0m                查看系统配置与场景路由');
  console.log('  \x1b[33m/settings default <id>\x1b[0m   将指定模型设为全局默认');
  console.log('  \x1b[33m/clear\x1b[0m                   清空当前对话历史上下文');
  console.log('  \x1b[33m/status\x1b[0m                  查看 Token 消耗统计与工具状态');
  console.log('  \x1b[33m/mode [mode]\x1b[0m             查看或切换 Approval/Plan/Auto/FullAccess');
  console.log('  \x1b[33m/logs [count]\x1b[0m            查看最近的结构化运行日志');
  console.log('  \x1b[33m/instructions\x1b[0m            查看本轮项目指令来源');
  console.log('  \x1b[33m/help\x1b[0m                    打印本命令帮助信息');
  console.log('  \x1b[33m/exit\x1b[0m 或 \x1b[33m/quit\x1b[0m           优雅退出当前终端');
  console.log(
    '                              \x1b[90m（直接输入 exit / quit 亦可，无需斜杠）\x1b[0m',
  );
  console.log('提示: 输入普通自然语言直接与 Agent 开始交互。\n');
};
