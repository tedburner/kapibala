import { agentsCommand } from './agents.js';
import { archiveCommand } from './archive.js';
import { branchCommand } from './branch.js';
import type { CommandDefinition } from './catalog.js';
import { COMMAND_CATALOG } from './catalog.js';
import { compactCommand, contextCommand } from './context.js';
import { CommandDispatcher, type CommandHandler } from './dispatcher.js';
import { forkCommand } from './fork.js';
import { helpCommand } from './help.js';
import { historyCommand, newCommand, renameCommand, resumeCommand } from './history.js';
import { instructionsCommand } from './instructions.js';
import { logsCommand } from './logs.js';
import { mcpCommand } from './mcp.js';
import { modeCommand } from './mode.js';
import { modelCommand } from './model.js';
import { pluginsCommand } from './plugins.js';
import { promptCommand, promptsCommand } from './prompts.js';
import { settingsCommand } from './settings.js';
import { skillCommand, skillsCommand } from './skills.js';
import { statusCommand } from './status.js';

/**
 * 按 COMMAND_CATALOG 装配默认斜杠命令分发器：CLI REPL 与桌面会话命令面共用同一装配源。
 *
 * 保证与边界：
 * - 命令处理器全部无状态、经 dispatch 时传入的 CommandContext 取得会话与能力；
 *   本装配不绑定任何具体会话、输入协调器或终端资源；
 * - `/exit` 是宿主语义（退出当前交互循环），桌面侧由适配器把 onExit 映射为空操作，
 *   因此此处按同一静态处理器注册；
 * - 调用方不得再向返回的 dispatcher 注册同名命令（重复注册会抛错）。
 */
export function createDefaultCommandDispatcher(): CommandDispatcher {
  const dispatcher = new CommandDispatcher();
  const handlers: Record<string, CommandHandler> = {
    new: newCommand,
    resume: resumeCommand,
    history: historyCommand,
    rename: renameCommand,
    context: contextCommand,
    compact: compactCommand,
    model: modelCommand,
    settings: settingsCommand,
    permissions: modeCommand,
    status: statusCommand,
    logs: logsCommand,
    instructions: instructionsCommand,
    skills: skillsCommand,
    skill: skillCommand,
    plugins: pluginsCommand,
    mcp: mcpCommand,
    prompts: promptsCommand,
    prompt: promptCommand,
    help: helpCommand,
    branch: branchCommand,
    fork: forkCommand,
    archive: archiveCommand,
    agents: agentsCommand,
    exit: async (_args, context) => {
      await context.onExit();
    },
  };
  for (const definition of COMMAND_CATALOG)
    dispatcher.registerDefinition(definition, handlers[definition.name]);
  return dispatcher;
}

/** 命令目录只读视图；宿主据此做补全与交互分级判断，不得直接改动定义。 */
export function defaultCommandDefinitions(): readonly CommandDefinition[] {
  return COMMAND_CATALOG;
}
