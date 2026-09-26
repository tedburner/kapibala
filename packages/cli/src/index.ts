import path from 'node:path';
import {
  AgentSession,
  JSONLMessageStore,
  type ModelProfile,
  OpenAICompatibleProvider,
  type SessionMode,
} from '@kiturone/kapibala';
import minimist from 'minimist';
import { clearCommand } from './commands/clear.js';
import { type CommandContext, CommandDispatcher } from './commands/dispatcher.js';
import { helpCommand } from './commands/help.js';
import { instructionsCommand } from './commands/instructions.js';
import { logsCommand } from './commands/logs.js';
import { modeCommand } from './commands/mode.js';
import { modelCommand } from './commands/model.js';
import { settingsCommand } from './commands/settings.js';
import { statusCommand } from './commands/status.js';
import { runOneShot } from './oneshot.js';
import { detectProjectRoot } from './project-root.js';
import { resolveProjectTrust } from './project-trust.js';
import { startREPL } from './repl.js';
import {
  API_KEY_ENV_NONE,
  BUILTIN_PROFILES,
  loadSettings,
  migrateGlobalSettingsCatalog,
  resolveApiKey,
  resolveBaseURL,
} from './settings.js';
import { registerBuiltinTools } from './tool-registration.js';
import { CliApprovalChannel } from './ui/approval.js';
import { runSetupWizard } from './wizard.js';

/** 具名解释器或用户显式提供的解释器可执行文件全路径。 */
function isValidShellPreference(value: string): boolean {
  return (
    ['auto', 'bash', 'wsl', 'pwsh', 'powershell'].includes(value) ||
    /[\\/]/.test(value) ||
    value.toLowerCase().endsWith('.exe')
  );
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = minimist(argv, {
    string: ['model', 'base-url', 'api-key', 'prompt', 'permission', 'shell'],
    boolean: ['help', 'version', 'debug', 'disable-shell'],
    alias: { m: 'model', h: 'help', v: 'version', p: 'prompt' },
  });

  if (args.help) {
    console.log(`
🐾 Kapibala (kpbl) v0.0.2 - Production-grade TypeScript AI Agent Harness

使用方式:
  kpbl [选项] [问题/指令]

示例:
  kpbl                             # 启动交互式会话终端 (REPL)
  kpbl "请帮我查看当前目录结构"    # 免交互单次会话模式 (直接问答)
  kpbl -m deepseek-v4-pro          # 指定深度推理模型启动终端

选项:
  -m, --model <id>       指定要使用的模型 profile id (如 deepseek-flash, claude-opus-5)
  -p, --prompt <text>    直接执行问答并输出结果 (单次模式)
  --base-url <url>       临时覆盖模型 API 端点
  --api-key <key>        临时指定 API 密钥
  --debug                输出调试日志与事件追踪
  --permission <mode>    本次会话权限: approval|plan|auto|full-access
  --shell <kind>         解释器: auto|bash|wsl|pwsh|powershell 或解释器全路径
  --disable-shell        关闭默认命令工具
  -v, --version          查看当前版本
  -h, --help             查看帮助信息

提示:
  输入 /model 可浏览全部内置模型（DeepSeek / OpenAI / Claude / Gemini / Qwen / Kimi / GLM / Ollama）。
`);
    process.exit(0);
  }

  if (args.version) {
    console.log('kpbl v0.0.2');
    process.exit(0);
  }

  // 0. 内置模型清单升级
  // 厂商换代后老配置里的 modelName 会指向已退役模型（如 deepseek-chat 已不可访问）。
  // 这里只动全局配置文件，且仅在版本落后时写回；失败不能挡住启动。
  try {
    const catalogChanges = migrateGlobalSettingsCatalog();
    if (catalogChanges.length > 0) {
      console.log(`\x1b[36m⬆ 内置模型清单已更新（${catalogChanges.length} 项）：\x1b[0m`);
      for (const change of catalogChanges) {
        console.log(`\x1b[90m  · ${change}\x1b[0m`);
      }
    }
  } catch (err: unknown) {
    console.error(`\x1b[33m[kapibala] 内置模型清单升级失败：${(err as Error).message}\x1b[0m`);
  }

  // 1. 加载 settings
  const trustResult = await resolveProjectTrust(loadSettings());
  if (trustResult.status === 'rejected') {
    console.error('\x1b[31m项目配置未获信任，Kapibala 已退出。\x1b[0m');
    process.exitCode = 2;
    return;
  }
  if (trustResult.status === 'non_interactive') {
    console.error(
      '\x1b[31m检测到未信任的项目配置；非交互环境无法确认信任，Kapibala 已退出。\x1b[0m',
    );
    process.exitCode = 2;
    return;
  }
  const { settings, sourcePath } = trustResult.loaded;
  const modeNames: Record<string, SessionMode> = {
    approval: 'Approval',
    plan: 'Plan',
    auto: 'Auto',
    'full-access': 'FullAccess',
  };
  const requestedMode =
    typeof args.permission === 'string' ? modeNames[args.permission.toLowerCase()] : undefined;
  if (args.permission && !requestedMode)
    throw new Error(`Unknown permission mode: ${args.permission}`);
  const defaultMode =
    settings.permissionMode === 'FullAccess' ? 'Approval' : (settings.permissionMode ?? 'Approval');
  if (settings.permissionMode === 'FullAccess')
    console.error('[kapibala] 用户配置不能默认启用 FullAccess，本次使用 Approval。');
  const mode = requestedMode ?? defaultMode;

  // 命令行参数覆盖
  const targetModelId = args.model || settings.defaultModel;
  let activeProfile =
    settings.profiles.find((p) => p.id === targetModelId) ||
    BUILTIN_PROFILES.find((p) => p.id === targetModelId);

  if (!activeProfile) {
    activeProfile = settings.profiles[0] ?? BUILTIN_PROFILES[0]!;
  }

  if (args['base-url']) {
    activeProfile = { ...activeProfile, baseURL: args['base-url'] };
  }
  if (args['api-key']) {
    activeProfile = { ...activeProfile, apiKey: args['api-key'] };
  }

  // 2. 检测可用性，若完全无配置则唤起初次向导
  // 传入 settings 才能复用同厂商族已配置的密钥，避免同厂换个模型就要求重新输入。
  let activeApiKey = resolveApiKey(activeProfile, settings);

  if (!activeApiKey && activeProfile.apiKeyEnv !== API_KEY_ENV_NONE) {
    const { profile, apiKey } = await runSetupWizard();
    activeProfile = profile;
    activeApiKey = apiKey;
  }

  // 3. 构建 Provider 与 Session
  const createProvider = (profile: ModelProfile, apiKey: string) => {
    return new OpenAICompatibleProvider({
      baseURL: resolveBaseURL(profile),
      apiKey,
      modelName: profile.modelName,
      supportsThinking: profile.supportsThinking,
    });
  };

  let currentProvider = createProvider(activeProfile, activeApiKey || 'none');

  // 会话历史记录持久化至工作区 .kapibala/history.jsonl
  const workspaceHistoryPath = path.join(process.cwd(), '.kapibala', 'history.jsonl');
  const store = new JSONLMessageStore(workspaceHistoryPath);
  const approvalChannel = new CliApprovalChannel();

  const session = new AgentSession({
    defaultProfile: activeProfile,
    defaultProvider: currentProvider,
    store,
    rootDir: process.cwd(),
    projectRoot: detectProjectRoot(process.cwd()),
    cwd: process.cwd(),
    logger: args.debug ? (msg) => console.error(`[DEBUG] ${msg}`) : undefined,
    onDiagnostic: (message) => console.error(`[kapibala] ${message}`),
    mode,
    permissionRules: settings.permissionRules,
    approvalChannel,
  });

  // 注册内置工具。显式指定的解释器（具名或全路径）不可用时启动失败；
  // auto 找不到可用解释器时仅禁用 run_command 并诊断，文件工具继续可用。
  const preference = args.shell ?? settings.shell?.preference ?? 'auto';
  if (!isValidShellPreference(preference)) throw new Error(`Unknown shell: ${preference}`);
  const autoDegrade = preference === 'auto';
  try {
    registerBuiltinTools(session.tools, {
      cwd: process.cwd(),
      shell: preference,
      disableShell: args['disable-shell'] || settings.shell?.enabled === false,
    });
  } catch (error: unknown) {
    if (!autoDegrade) {
      console.error(`[kapibala] 命令解释器不可用: ${(error as Error).message}`);
      process.exitCode = 2;
      return;
    }
    console.error(
      `[kapibala] 未找到可用的命令解释器，本次会话已禁用 run_command: ${(error as Error).message}`,
    );
  }

  // 优雅退出：必须先走 session.destroy()（插件 teardown + session:end 钩子）再退出进程，
  // 与 rl.close / oneshot finally 的资源回收语义保持一致。
  const gracefulExit = () => {
    console.log('\x1b[32m再见！🐾\x1b[0m');
    void session
      .destroy()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };

  // 4. 初始化 CommandDispatcher
  const dispatcher = new CommandDispatcher();
  dispatcher.register('model', modelCommand);
  dispatcher.register('settings', settingsCommand);
  dispatcher.register('clear', clearCommand);
  dispatcher.register('status', statusCommand);
  dispatcher.register('mode', modeCommand);
  dispatcher.register('logs', logsCommand);
  dispatcher.register('instructions', instructionsCommand);
  dispatcher.register('help', helpCommand);
  dispatcher.register('exit', () => gracefulExit());
  dispatcher.register('quit', () => gracefulExit());

  const commandContext: CommandContext = {
    session,
    settings,
    settingsPath: sourcePath,
    onModelSwitched: (newProfileId: string) => {
      // 向导或命令可能刚把新 profile 写进磁盘，这里必须重新加载而不是查启动时的快照：
      // 快照里没有新 profile 会导致"向导已打印已就绪、实际 provider 没换"，
      // 而且过期的 ctx.settings 会在后续 saveGlobalSettings 时把刚写入的配置覆盖回去。
      const { settings: fresh, sourcePath: freshPath } = loadSettings();
      Object.assign(settings, fresh);
      commandContext.settingsPath = freshPath;

      const profile =
        settings.profiles.find((x) => x.id === newProfileId) ??
        BUILTIN_PROFILES.find((x) => x.id === newProfileId);
      if (!profile) {
        console.log(`\x1b[31m未找到模型 Profile '${newProfileId}'，模型切换已跳过。\x1b[0m`);
        return;
      }

      const key = resolveApiKey(profile, settings) || 'none';
      currentProvider = createProvider(profile, key);
      session.switchModel(profile, 'default', currentProvider);
    },
    onExit: () => gracefulExit(),
  };

  // 5. 启动会话
  await session.init();

  // 检查是否传入了直接问答参数 (如: kpbl "请帮我分析项目" 或 kpbl -p "xxx")
  const oneShotPrompt = args.prompt || (args._.length > 0 ? args._.join(' ') : null);
  if (oneShotPrompt && typeof oneShotPrompt === 'string' && oneShotPrompt.trim().length > 0) {
    const exitCode = await runOneShot({
      session,
      prompt: oneShotPrompt.trim(),
      debug: Boolean(args.debug),
      approvalChannel,
    });
    if (exitCode !== 0) process.exitCode = exitCode;
    return;
  }

  // 启动交互式 REPL 会话终端
  await startREPL({
    session,
    dispatcher,
    context: commandContext,
    debug: Boolean(args.debug),
    approvalChannel,
  });
}
