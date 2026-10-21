import fs from 'node:fs';
import path from 'node:path';
import {
  AgentRuntime,
  AgentSession,
  type ApprovalChannel,
  type CanonicalMessage,
  type ManagedSession,
  SessionManager,
  WorkspaceLeaseCoordinator,
} from '@kiturone/kapibala';
import { createMcpPlugin } from '@kiturone/kapibala-mcp';
import { resolveCliMcpOptions } from '../mcp.js';
import { CliModelBindings } from '../model-bindings.js';
import { detectProjectRoot } from '../project-root.js';
import type { JsonValue } from '../protocol/index.js';
import {
  BUILTIN_PROFILES,
  type UserSettings,
  isProjectTrusted,
  loadSettings,
  resolveApiKeyDetailed,
} from '../settings.js';
import { getCliSkillOptions, hasProjectSkills } from '../skills.js';
import { createCliSubagentRunner } from '../subagent-runner.js';
import { registerBuiltinTools } from '../tool-registration.js';
import { formatToolDetail } from '../ui/tool-presentation.js';
import { StreamingRedactor, redactText } from './redaction.js';
import type { ResourceFactory } from './types.js';

/** 宿主只读装配选项；homeDir 用于隔离用户设置和会话桶，不改变进程 HOME/cwd。 */
export interface ResourceFactoryOptions {
  homeDir?: string;
}

/** 收集可解析的模型凭证；忽略无密钥占位与过短值，避免把常见词整体替换。 */
function credentialsFromSettings(settings: Pick<UserSettings, 'profiles'>): string[] {
  return settings.profiles.flatMap((profile) => {
    const resolved = resolveApiKeyDetailed(profile, settings);
    return resolved && resolved.source !== 'none' && resolved.key.length >= 4 ? [resolved.key] : [];
  });
}

/** 只读加载工作区生效的凭证供标题等非会话出口脱敏；配置不可读时退化为空集。 */
export function loadCredentialSecrets(workspaceRoot: string, homeDir?: string): string[] {
  try {
    return credentialsFromSettings(loadSettings({ cwd: workspaceRoot, homeDir }).settings);
  } catch {
    return [];
  }
}

function publicHistory(history: CanonicalMessage[], redact: (text: string) => string): JsonValue[] {
  return history.map((message, index) => ({
    id: message.id ?? `legacy:${index}`,
    role: message.role,
    state: message.state ?? 'completed',
    blocks: message.content.flatMap((block) => {
      if (block.type === 'text') return [{ kind: 'text', text: redact(block.text) }];
      if (block.type === 'thinking') return [{ kind: 'thinking', text: redact(block.thinking) }];
      if (block.type === 'tool_result')
        return [{ kind: 'tool_result', text: redact(formatToolDetail(block.content)) }];
      if (block.type === 'tool_use') return [{ kind: 'tool_use', text: block.name }];
      return [];
    }),
  }));
}

/**
 * 在资源创建边界把 Core 的会话身份/锁错误规范化为稳定业务码。
 * 只转换已知前缀，其它错误保持原样，避免把配置或 IO 故障误报为可重试的锁冲突。
 */
function normalizeSessionError(error: unknown): never {
  if (error instanceof Error) {
    if (error.message.startsWith('Session locked')) throw new Error('SESSION_BUSY');
    if (
      error.message === 'Session not found' ||
      error.message.startsWith('Session not found:') ||
      error.message.startsWith('Ambiguous session prefix:')
    )
      throw new Error('SESSION_NOT_FOUND');
  }
  throw error;
}

/**
 * 显式工作区的无终端装配；每会话独立模型/技能/MCP，只有写租约在本宿主共享。
 * 未受信任项目、配置或密钥错误在创建存储句柄前失败，不进入向导，不授予新信任。
 */
export function createResourceFactory(options: ResourceFactoryOptions = {}): ResourceFactory {
  const leases = new WorkspaceLeaseCoordinator();
  return {
    async create(workspaceRoot, conversationId, approval) {
      const root = detectProjectRoot(fs.realpathSync.native(workspaceRoot));
      const loaded = loadSettings({ cwd: root, homeDir: options.homeDir });
      const { settings } = loaded;
      const trusted = isProjectTrusted(settings, root);
      if (
        loaded.pendingProject ||
        (!trusted &&
          (hasProjectSkills(root) || fs.existsSync(path.join(root, '.kapibala/mcp.json'))))
      )
        throw new Error('TRUST_REQUIRED');
      const profile =
        settings.profiles.find((item) => item.id === settings.defaultModel) ??
        BUILTIN_PROFILES.find((item) => item.id === settings.defaultModel);
      if (!profile) throw new Error('CONFIG_REQUIRED');
      let models: CliModelBindings;
      try {
        models = new CliModelBindings(settings, profile);
      } catch {
        throw new Error('CONFIG_REQUIRED');
      }
      const manager = new SessionManager({ workspaceRoot: root, homeDirectory: options.homeDir });
      let handle: ManagedSession | undefined;
      let session: AgentSession | undefined;
      let runtime: AgentRuntime | undefined;
      try {
        try {
          handle = conversationId
            ? await manager.open(conversationId, { autoUpgradeLegacy: true })
            : await manager.create();
        } catch (error) {
          normalizeSessionError(error);
        }
        const preference = settings.shell?.preference ?? 'auto';
        runtime = new AgentRuntime({
          runner: createCliSubagentRunner({
            manager,
            models,
            settings,
            preference,
            isTrusted: trusted,
            approvalChannel: approval,
            leaseCoordinator: leases,
          }),
          validateModelOverride: (id) => settings.profiles.some((item) => item.id === id),
          outboxPath: path.join(root, '.kapibala/outbox.jsonl'),
        });
        session = new AgentSession({
          workspaceRoot: root,
          executionCwd: root,
          projectRoot: root,
          store: handle.store,
          conversationId: handle.conversationId,
          defaultProfile: models.defaultBinding.profile,
          defaultProvider: models.defaultBinding.provider,
          approvalChannel: approval,
          leaseCoordinator: leases,
          permissionRules: settings.permissionRules,
          mode:
            settings.permissionMode === 'FullAccess'
              ? 'Approval'
              : (settings.permissionMode ?? 'Approval'),
          skills: getCliSkillOptions(settings, {
            cwd: root,
            projectRoot: root,
            homeDir: options.homeDir,
          }),
        });
        registerBuiltinTools(session.tools, {
          cwd: root,
          shell: preference,
          disableShell: settings.shell?.enabled === false,
          runtime,
        });
        models.attach(session);
        const mcp = resolveCliMcpOptions({
          projectRoot: root,
          homeDir: options.homeDir,
          isProjectTrusted: trusted,
        });
        if (mcp.diagnostics.some((item) => item.severity === 'error'))
          throw new Error('MCP_CONFIG_INVALID');
        let mountMcp: ((signal: AbortSignal) => Promise<void>) | undefined;
        if (mcp.enabled && mcp.servers.size) {
          const servers = Object.fromEntries(
            [...mcp.servers].map(([name, entry]) => [name, entry.config]),
          );
          const mcpSession = session;
          mountMcp = async (runSignal) => {
            await mcpSession.use(
              createMcpPlugin(servers, {
                authorizer: async (descriptor, signal) => {
                  const choice = await approval.requestApproval(
                    {
                      toolName: 'mcp_start',
                      rootDir: root,
                      capabilities: descriptor.type === 'stdio' ? ['exec'] : ['net:outbound'],
                      input: { ...descriptor },
                      sessionAllowed: true,
                    },
                    signal ? AbortSignal.any([signal, runSignal]) : runSignal,
                  );
                  return choice === 'cancel' ? 'deny_once' : choice;
                },
              }),
            );
          };
        }
        await session.init();
        const current = session;
        const ownedHandle = handle;
        const ownedRuntime = runtime;
        const credentials = credentialsFromSettings(settings);
        const redact = (text: string) => redactText(text, credentials);
        // 独立记录运行时与会话的清理状态；全部成功后才释放存储锁，失败重试补做未完成步骤。
        let runtimeClosed = false;
        let sessionDestroyed = false;
        let handleReleased = false;
        let disposal: Promise<void> | undefined;
        const dispose = (): Promise<void> => {
          if (disposal) return disposal;
          disposal = (async () => {
            const failures: unknown[] = [];
            if (!runtimeClosed) {
              try {
                await ownedRuntime.close();
                runtimeClosed = true;
              } catch (error) {
                failures.push(error);
              }
            }
            if (!sessionDestroyed) {
              try {
                await current.destroy();
                sessionDestroyed = true;
              } catch (error) {
                failures.push(error);
              }
            }
            if (runtimeClosed && sessionDestroyed && !handleReleased) {
              try {
                await ownedHandle.release();
                handleReleased = true;
              } catch (error) {
                failures.push(error);
              }
            }
            if (failures.length) throw failures[0];
          })().catch((error) => {
            disposal = undefined;
            throw error;
          });
          return disposal;
        };
        return {
          conversationId: handle.conversationId,
          history: () => publicHistory(current.getHistory(), redact),
          isBusy: () => current.isBusy(),
          redact,
          cancelChildren: async () => {
            await Promise.all(
              ownedRuntime
                .listTasks({ status: 'active' })
                .map((task) => ownedRuntime.cancelTask(task.agentId, 'Local controller cancelled')),
            );
          },
          async *run(input, signal) {
            if (mountMcp) {
              const mount = mountMcp;
              await mount(signal);
              mountMcp = undefined;
            }
            const textRedactor = new StreamingRedactor(credentials);
            const thinkingRedactor = new StreamingRedactor(credentials);
            for await (const event of current.run(input, { signal })) {
              if (event.type === 'text_delta')
                yield { ...event, text: textRedactor.push(event.text) };
              else if (event.type === 'thinking_delta')
                yield { ...event, thinking: thinkingRedactor.push(event.thinking) };
              else {
                const text = textRedactor.flush();
                const thinking = thinkingRedactor.flush();
                if (text) yield { type: 'text_delta' as const, text };
                if (thinking) yield { type: 'thinking_delta' as const, thinking };
                yield event;
              }
            }
            const text = textRedactor.flush();
            const thinking = thinkingRedactor.flush();
            if (text) yield { type: 'text_delta' as const, text };
            if (thinking) yield { type: 'thinking_delta' as const, thinking };
          },
          dispose,
        };
      } catch (error) {
        // 创建失败时也按依赖顺序清理；上游未清理完不能释放存储锁，原始错误优先上报。
        try {
          await runtime?.close();
          await session?.destroy();
          await handle?.release();
        } catch {
          /* 保留未完成清理的句柄及单写者锁，不允许其它会话重叠写入。 */
        }
        throw error;
      }
    },
  };
}
