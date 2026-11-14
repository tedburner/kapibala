import { createDefaultCommandDispatcher, defaultCommandDefinitions } from './assemble.js';
import { COMMAND_CATALOG, type CommandDefinition, parsePromptInvocation } from './catalog.js';
import { type CommandContext, CommandDispatcher, type CommandHandler } from './dispatcher.js';

/**
 * 斜杠命令系统门面：CLI 应用层与桌面会话命令面共用的单一装配源。
 *
 * 保证与边界：
 * - 本入口只暴露无状态的分发器与目录；CommandContext 由宿主（CLI REPL / 桌面适配器）
 *   自行构造，命令处理器经上下文回调取得会话与交互能力；
 * - 交互分级元数据（interactionLevel）是宿主解锁命令的唯一依据，桌面首版只解锁
 *   'none' 级命令；需要交互的命令在桌面侧会得到明确的不可用反馈而不是静默失败；
 * - 桌面消费经 `@kiturone/kapibala-cli/commands` 子路径；发布包内联构建，npm 消费者
 *   不感知工作区私有依赖。
 */
export {
  CommandDispatcher,
  COMMAND_CATALOG,
  parsePromptInvocation,
  createDefaultCommandDispatcher,
  defaultCommandDefinitions,
};
export type { CommandContext, CommandDefinition, CommandHandler };
export type { CommandOutput, CommandOutputStream } from '../command-output.js';
export type { SelectConfig, SelectOption } from '../ui/select.js';
