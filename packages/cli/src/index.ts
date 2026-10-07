import path from 'node:path';
import { AgentSession, SessionManager, type SessionMode, ToolRegistry } from '@kiturone/kapibala';
import minimist from 'minimist';
import { ActiveSessionController } from './active-session.js';
import { COMMAND_CATALOG } from './commands/catalog.js';
import { clearCommand } from './commands/clear.js';
import { compactCommand, contextCommand } from './commands/context.js';
import { type CommandContext, CommandDispatcher } from './commands/dispatcher.js';
import { helpCommand } from './commands/help.js';
import { historyCommand, newCommand, renameCommand, resumeCommand } from './commands/history.js';
import { instructionsCommand } from './commands/instructions.js';
import { logsCommand } from './commands/logs.js';
import { modeCommand } from './commands/mode.js';
import { modelCommand } from './commands/model.js';
import { settingsCommand } from './commands/settings.js';
import { statusCommand } from './commands/status.js';
import { CliInputCoordinator } from './input-coordinator.js';
import { CliModelBindings, parsePrimaryModelRole } from './model-bindings.js';
import { runOneShot } from './oneshot.js';
import { detectProjectRoot } from './project-root.js';
import { resolveProjectTrust } from './project-trust.js';
import { startREPL } from './repl.js';
import { openStartupSession, validateSessionStartup } from './session-startup.js';
import {
  API_KEY_ENV_NONE,
  BUILTIN_PROFILES,
  loadSettings,
  migrateGlobalSettingsCatalog,
  resolveApiKey,
} from './settings.js';
import { registerBuiltinTools } from './tool-registration.js';
import { CliApprovalChannel } from './ui/approval.js';
import { CLI_VERSION } from './version.js';
import { runSetupWizard } from './wizard.js';

/** 具名解释器或用户显式提供的解释器可执行文件全路径。 */
function isValidShellPreference(value: string): boolean {
  return (
    ['auto', 'bash', 'wsl', 'pwsh', 'powershell'].includes(value) ||
    /[\\/]/.test(value) ||
    value.toLowerCase().endsWith('.exe')
  );
}

/** 解析启动参数并管理独立会话、共享输入和退出清理；显式恢复失败不回退新建。 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = minimist(argv, {
    string: ['model', 'role', 'base-url', 'api-key', 'prompt', 'permission', 'shell', 'resume'],
    boolean: ['help', 'version', 'debug', 'disable-shell', 'continue'],
    alias: { m: 'model', h: 'help', v: 'version', p: 'prompt' },
  });

  if (args.help) {
    console.log(`
🐾 Kapibala (kpbl) v${CLI_VERSION} - Production-grade TypeScript AI Agent Harness

使用方式:
  kpbl [选项] [问题/指令]

示例:
  kpbl                             # 启动交互式会话终端 (REPL)
  kpbl "请帮我查看当前目录结构"    # 免交互单次会话模式 (直接问答)
  kpbl -m deepseek-v4-pro          # 指定 DeepSeek V4 Pro 启动终端

选项:
  -m, --model <id>       指定要使用的模型 profile id (如 deepseek-flash, claude-opus-5)
  --role <role>          主任务角色: default|planning|execution|fast；必须已有可用绑定
  -p, --prompt <text>    直接执行问答并输出结果 (单次模式)
  --base-url <url>       临时覆盖当前角色 API 端点
  --api-key <key>        临时指定当前角色 API 密钥
  --debug                输出调试日志与事件追踪
  --permission <mode>    本次会话权限: approval|plan|auto|full-access
  --shell <kind>         解释器: auto|bash|wsl|pwsh|powershell 或解释器全路径
  --disable-shell        关闭默认命令工具
  --continue             续答当前项目最近有内容的会话
  --resume <id>          按完整 ID 或唯一前缀恢复会话
  -v, --version          查看当前版本
  -h, --help             查看帮助信息

提示:
  输入 /model 可浏览全部内置模型（DeepSeek / OpenAI / Claude / Gemini / Qwen / Kimi / GLM / Ollama）。
`);
    process.exit(0);
  }

  if (args.version) {
    console.log(`kpbl v${CLI_VERSION}`);
    process.exit(0);
  }
  const requestedRole = parsePrimaryModelRole(args.role);

  // 0. 内置模型清单升级
  validateSessionStartup({ continue: args.continue, resume: args.resume });
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
    // 显式指定的模型不静默替换：与 --permission 非法时直接失败保持一致，
    // 避免用户在错误的模型上产生真实 API 费用与行为偏差。
    if (args.model) throw new Error(`Unknown model id: ${args.model}`);
    if (settings.defaultModel) {
      const fallbackId = settings.profiles[0]?.id ?? BUILTIN_PROFILES[0]!.id;
      console.error(
        `\x1b[33m[kapibala] 配置的默认模型 ${settings.defaultModel} 不存在，已回退到 ${fallbackId}。\x1b[0m`,
      );
    }
    activeProfile = settings.profiles[0] ?? BUILTIN_PROFILES[0]!;
  }

  const temporaryOverrides = {
    ...(args['base-url'] ? { baseURL: args['base-url'] as string } : {}),
    ...(args['api-key'] ? { apiKey: args['api-key'] as string } : {}),
  };
  if (requestedRole === 'default') activeProfile = { ...activeProfile, ...temporaryOverrides };

  // 2. 检测可用性，若完全无配置则唤起初次向导
  // 传入 settings 才能复用同厂商族已配置的密钥，避免同厂换个模型就要求重新输入。
  let activeApiKey = resolveApiKey(activeProfile, settings);
  if (requestedRole !== 'default') {
    const id = settings.modelRouting?.[requestedRole];
    const configured = settings.profiles.find((profile) => profile.id === id);
    if (!configured)
      throw new Error(
        `角色 ${requestedRole} 尚未配置可用模型，请使用 /model ${requestedRole} <id>。`,
      );
    const roleProfile = { ...configured, ...temporaryOverrides };
    if (!resolveApiKey(roleProfile, settings))
      throw new Error(
        `角色 ${requestedRole} 的模型 '${roleProfile.id}' 没有可用密钥，请先配置厂商密钥。`,
      );
  }
  const manager = new SessionManager({
    cwd: process.cwd(),
    onDiagnostic: (message) => console.error(`[kapibala] ${message}`),
  });
  let controller: ActiveSessionController | undefined;
  const inputCoordinator = new CliInputCoordinator();
  try {
    // 显式目标先验证和锁定；错误 ID 不启动密钥向导或创建替代会话。
    const restoredHandle = args.resume === undefined ? undefined : await manager.open(args.resume);
    if (
      requestedRole === 'default' &&
      !activeApiKey &&
      activeProfile.apiKeyEnv !== API_KEY_ENV_NONE
    ) {
      if (!inputCoordinator.interactive)
        throw new Error('尚未配置模型密钥；非交互环境请通过厂商环境变量或全局设置配置。');
      const { profile, apiKey } = await runSetupWizard({
        question: (prompt) => inputCoordinator.question(prompt),
        secretReader: (prompt) => inputCoordinator.readSecret(prompt),
      });
      activeProfile = profile;
      activeApiKey = apiKey;
      Object.assign(settings, loadSettings().settings);
    }

    // 3. 构建当前宿主配置；每次切换重新创建 Session，不继承旧授权缓存。
    const models = new CliModelBindings(
      settings,
      { ...activeProfile, ...(activeApiKey ? { apiKey: activeApiKey } : {}) },
      (message) => console.error(`[kapibala] ${message}`),
      requestedRole !== 'default',
      { [requestedRole]: temporaryOverrides },
    );
    const approvalChannel = new CliApprovalChannel();
    const builtinTools = new ToolRegistry();
    const preference = args.shell ?? settings.shell?.preference ?? 'auto';
    if (!isValidShellPreference(preference)) throw new Error(`Unknown shell: ${preference}`);
    try {
      registerBuiltinTools(builtinTools, {
        cwd: process.cwd(),
        shell: preference,
        disableShell: args['disable-shell'] || settings.shell?.enabled === false,
      });
    } catch (error: unknown) {
      if (preference !== 'auto') throw error;
      console.error(
        `[kapibala] 命令解释器不可用，本次禁用 run_command: ${(error as Error).message}`,
      );
    }
    try {
      await manager.importLegacy();
      const initialHandle =
        restoredHandle ??
        (await openStartupSession(manager, {
          continue: args.continue,
          resume: args.resume,
        }));
      const factory = async (handle: import('@kiturone/kapibala').ManagedSession) => {
        const created = new AgentSession({
          defaultProfile: models.defaultBinding.profile,
          defaultProvider: models.defaultBinding.provider,
          store: handle.store,
          conversationId: handle.conversationId,
          rootDir: process.cwd(),
          projectRoot: manager.project.projectRoot,
          cwd: process.cwd(),
          gitBranch: manager.project.gitBranch,
          logger: args.debug ? (message) => console.error(`[DEBUG] ${message}`) : undefined,
          onDiagnostic: (message) => console.error(`[kapibala] ${message}`),
          mode: controller?.session.getMode() ?? mode,
          permissionRules: settings.permissionRules,
          approvalChannel,
        });
        for (const tool of builtinTools.list()) created.tools.register(tool);
        models.attach(created, controller ? models.selectedRole : requestedRole);
        return created;
      };
      const initial = await factory(initialHandle);
      await initial.init();
      controller = new ActiveSessionController({
        manager,
        factory,
        current: { session: initial, handle: initialHandle },
        onDiagnostic: (message) => console.error(`[kapibala] ${message}`),
        onSwitched: (event) => console.log(`活动会话: ${event.conversationId}`),
      });
      const active = controller;
      if (args.resume || args.continue) {
        console.log(
          `已加载会话 ${active.session.conversationId}（${active.session.getHistory().length} 条消息）`,
        );
        if (active.handle.branchDrift)
          console.log(
            `分支环境已变化: ${active.handle.branchDrift.createdBranch ?? '无'} → ${active.handle.branchDrift.currentBranch ?? '无'}；保持本次工作目录。`,
          );
      }
      const dispatcher = new CommandDispatcher();
      const handlers: Record<string, import('./commands/dispatcher.js').CommandHandler> = {
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
        help: helpCommand,
        exit: async (_args, context) => {
          await context.onExit();
        },
      };
      for (const definition of COMMAND_CATALOG)
        dispatcher.registerDefinition(definition, handlers[definition.name]);
      const commandContext: CommandContext = {
        get session() {
          return active.session;
        },
        controller: active,
        dispatcher,
        settings,
        settingsPath: sourcePath,
        onModelSwitched: (newProfileId) => {
          const { settings: fresh, sourcePath: freshPath } = loadSettings();
          Object.assign(settings, fresh);
          commandContext.settingsPath = freshPath;
          const profile =
            settings.profiles.find((candidate) => candidate.id === newProfileId) ??
            BUILTIN_PROFILES.find((candidate) => candidate.id === newProfileId);
          if (!profile) throw new Error(`未找到模型 Profile '${newProfileId}'`);
          models.switchDefault(active.session, profile.id);
        },
        onRoleBound: (role, id) => models.bindRole(active.session, role, id),
        onRoleSelected: (role) => models.selectRole(active.session, role),
        onCredentialsUpdated: (id) => models.refreshCredentials(active.session, id),
        onExit: () => {
          inputCoordinator.close();
        },
      };
      const oneShotPrompt = args.prompt || (args._.length > 0 ? args._.join(' ') : null);
      if (oneShotPrompt && typeof oneShotPrompt === 'string' && oneShotPrompt.trim()) {
        const exitCode = await runOneShot({
          session: active.session,
          controller: active,
          inputCoordinator,
          prompt: oneShotPrompt.trim(),
          debug: Boolean(args.debug),
          approvalChannel,
        });
        if (exitCode) process.exitCode = exitCode;
        return;
      }
      await startREPL({
        session: active.session,
        controller: active,
        inputCoordinator,
        dispatcher,
        context: commandContext,
        debug: Boolean(args.debug),
        approvalChannel,
      });
    } finally {
      if (controller) await controller.close();
      else await manager.close();
    }
  } finally {
    inputCoordinator.close();
    if (!controller) await manager.close();
  }
}
