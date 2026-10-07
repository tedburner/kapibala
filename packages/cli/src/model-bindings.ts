import {
  type AgentSession,
  AnthropicProvider,
  ModelError,
  type ModelProfile,
  type ModelProvider,
  type ModelRole,
  OpenAICompatibleProvider,
  OpenAIResponsesProvider,
  type PrimaryModelRole,
  assembleCanonicalToolResults,
} from '@kiturone/kapibala';
import {
  type UserSettings,
  credentialGroup,
  detectProviderFamily,
  resolveApiKeyDetailed,
  resolveBaseURL,
} from './settings.js';

/** 主任务角色全集（含 default）；--role 与 /model route 只接受这里的取值。 */
export const PRIMARY_MODEL_ROLES = ['default', 'planning', 'execution', 'fast'] as const;
/** 可在 modelRouting 中显式绑定 Profile 的角色（含 summary）；主任务角色未绑定时运行在 default 之上。 */
export const ROUTABLE_MODEL_ROLES = ['planning', 'execution', 'fast', 'summary'] as const;

/** 校验 CLI 主任务角色；summary 只服务摘要，不能作为 --role 或 route 主任务。 */
export function parsePrimaryModelRole(value: unknown): PrimaryModelRole {
  if (value === undefined) return 'default';
  if (typeof value === 'string' && PRIMARY_MODEL_ROLES.includes(value as PrimaryModelRole))
    return value as PrimaryModelRole;
  throw new Error('Invalid model role; use default, planning, execution or fast');
}

/** 一份就绪的角色绑定：端点一致的 Profile 快照与按其协议构造的 Provider 成对出现。 */
export interface CliModelBinding {
  profile: ModelProfile;
  provider: ModelProvider;
}

/**
 * 按 Profile 显式协议创建原子绑定，不根据名称猜协议，不发送分类或探测请求。
 * @param profile 用户或目录 Profile；环境端点覆盖同步进入返回 Profile。
 * @param settings 用于同厂商密钥解析的有效设置。
 * @param options 未使用的 default 或明确配置的 summary 可保留缺密钥占位；真正使用时失败。
 * @returns 实际端点一致的 Profile 与 Provider；选中角色缺密钥或未知协议在请求前失败。
 */
export function createModelBinding(
  profile: ModelProfile,
  settings: Pick<UserSettings, 'profiles'>,
  options: { allowMissingCredentials?: boolean; baseURLOverride?: string } = {},
): CliModelBinding {
  const resolved = resolveApiKeyDetailed(profile, settings);
  const actual = {
    ...profile,
    baseURL: (options.baseURLOverride ?? resolveBaseURL(profile)).replace(/\/+$/, ''),
  };
  if (!resolved) {
    if (!options.allowMissingCredentials)
      throw new Error(`模型 '${profile.id}' 没有可用密钥，请配置该厂商密钥。`);
    return {
      profile: actual,
      provider: {
        name: actual.provider,
        credentialsReady: false,
        binding: {
          protocol: actual.provider,
          baseURL: actual.baseURL,
          modelName: actual.modelName,
          workspaceId: actual.anthropicWorkspaceId,
        },
        create() {
          return {
            [Symbol.asyncIterator]() {
              return {
                async next(): Promise<never> {
                  throw new ModelError('模型绑定没有可用密钥，请配置厂商密钥后重试。', {
                    code: 'MODEL_CREDENTIALS_MISSING',
                    stage: 'request',
                    retryable: false,
                  });
                },
              };
            },
          };
        },
        assembleToolResults: assembleCanonicalToolResults,
      },
    };
  }
  const common = { baseURL: actual.baseURL, apiKey: resolved.key, modelName: actual.modelName };
  let provider: ModelProvider;
  switch (actual.provider) {
    case 'anthropic':
      provider = new AnthropicProvider({ ...common, workspaceId: actual.anthropicWorkspaceId });
      break;
    case 'openai-responses':
      provider = new OpenAIResponsesProvider({
        ...common,
        supportsThinking: actual.supportsThinking,
      });
      break;
    case 'openai-compatible':
      provider = new OpenAICompatibleProvider({
        ...common,
        supportsThinking: actual.supportsThinking,
        replayReasoningContent: detectProviderFamily(profile) === 'deepseek',
        chatCapabilities: actual.chatCapabilities,
      });
      break;
    default:
      throw new Error(`模型 '${profile.id}' 的 provider 协议不受支持。`);
  }
  return { profile: actual, provider };
}

/** CLI 进程内模型宿主；跨历史会话保留选择，新进程默认 default，角色不改变权限。 */
export class CliModelBindings {
  private readonly bindings = new Map<ModelRole, CliModelBinding>();
  private readonly unavailable = new Map<ModelRole, string>();
  selectedRole: PrimaryModelRole = 'default';

  /** 装载已配置路由；未配摘要回退 default，已配摘要缺密钥保留目标在调用时失败，坏绑定降级不阻断启动。 */
  constructor(
    private readonly settings: UserSettings,
    defaultProfile: ModelProfile,
    private readonly diagnostic: (message: string) => void = () => {},
    allowMissingDefaultCredentials = false,
    private readonly roleOverrides: Partial<Record<ModelRole, Partial<ModelProfile>>> = {},
  ) {
    this.bindings.set(
      'default',
      createModelBinding({ ...defaultProfile, ...roleOverrides.default }, settings, {
        allowMissingCredentials: allowMissingDefaultCredentials,
        baseURLOverride: roleOverrides.default?.baseURL,
      }),
    );
    for (const role of ROUTABLE_MODEL_ROLES) {
      const id = settings.modelRouting?.[role];
      if (!id) continue;
      try {
        const profile = { ...this.findProfile(id), ...roleOverrides[role] };
        const binding = createModelBinding(profile, settings, {
          baseURLOverride: roleOverrides[role]?.baseURL,
          allowMissingCredentials: role === 'summary',
        });
        this.bindings.set(role, binding);
        if (binding.provider.credentialsReady === false)
          this.diagnostic('summary 路由没有可用密钥，摘要调用前将明确失败。');
      } catch (error) {
        // summary 指向失效 Profile/非法协议时与其它角色一致降级，运行时回退 default，不阻断 CLI 启动。
        const message = `${role} 路由不可用：${error instanceof Error ? error.message : '配置无效'}`;
        this.unavailable.set(role, message);
        this.diagnostic(message);
      }
    }
  }

  get defaultBinding(): CliModelBinding {
    return this.bindings.get('default')!;
  }

  /** 为新建或恢复的 Session 应用有效绑定及本进程明确选择，不从历史恢复角色。 */
  attach(session: AgentSession, role: PrimaryModelRole = this.selectedRole): void {
    for (const [role, binding] of this.bindings)
      if (role !== 'default') session.switchModel(binding.profile, role, binding.provider);
    this.selectRole(session, role);
  }

  /** 严格选择已绑定角色；失败保持有效角色，未配或缺密钥不回退 default。 */
  selectRole(session: AgentSession, role: PrimaryModelRole): void {
    if (!this.bindings.has(role))
      throw new Error(
        this.unavailable.get(role) ?? `角色 ${role} 尚未配置，请使用 /model ${role} <id>。`,
      );
    session.selectModelRole(role);
    this.selectedRole = role;
  }

  /** 普通 /model 只更新本次默认绑定并选择 default，不修改下次启动模型。 */
  switchDefault(session: AgentSession, id: string): void {
    const binding = createModelBinding(this.findProfile(id), this.settings);
    session.switchModel(binding.profile, 'default', binding.provider);
    session.selectModelRole('default');
    this.bindings.set('default', binding);
    this.roleOverrides.default = undefined;
    this.selectedRole = 'default';
  }

  /** 在配置持久化成功后更新角色绑定，保持当前角色选择。 */
  bindRole(session: AgentSession, role: Exclude<ModelRole, 'default'>, id: string): void {
    const binding = createModelBinding(this.findProfile(id), this.settings);
    session.switchModel(binding.profile, role, binding.provider);
    this.bindings.set(role, binding);
    this.roleOverrides[role] = undefined;
    this.unavailable.delete(role);
  }

  /** 密钥写入成功后重建全部同组有效角色，保留临时端点和当前选择，不只刷新 default。 */
  refreshCredentials(session: AgentSession, profileId: string): void {
    const group = credentialGroup(this.findProfile(profileId));
    const refreshed = new Map<ModelRole, CliModelBinding>();
    for (const [role, binding] of this.bindings) {
      const source = this.findProfile(binding.profile.id);
      if (credentialGroup(source) !== group) continue;
      if (this.roleOverrides[role])
        this.roleOverrides[role] = { ...this.roleOverrides[role], apiKey: undefined };
      refreshed.set(
        role,
        createModelBinding(
          { ...binding.profile, apiKey: resolveApiKeyDetailed(source, this.settings)?.key },
          this.settings,
          {
            baseURLOverride: binding.profile.baseURL,
          },
        ),
      );
    }
    for (const [role, binding] of refreshed) {
      session.switchModel(binding.profile, role, binding.provider);
      this.bindings.set(role, binding);
    }
    // 配置中已指定但之前缺密钥的角色也可能因同组新密钥变得可用。
    for (const role of ROUTABLE_MODEL_ROLES) {
      const id = this.settings.modelRouting?.[role];
      const source = this.settings.profiles.find((profile) => profile.id === id);
      if (id && source && !this.bindings.has(role) && credentialGroup(source) === group)
        this.bindRole(session, role, id);
    }
  }

  /** 按明确 ID 查找有效配置，不对拼写错误或失效引用提供其它模型。 */
  private findProfile(id: string): ModelProfile {
    const profile = this.settings.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new Error(`未找到模型 Profile '${id}'`);
    return profile;
  }
}
