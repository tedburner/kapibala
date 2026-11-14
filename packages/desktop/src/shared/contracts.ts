import { z } from 'zod';
import { InspectionSchema, RuntimeSnapshotSchema } from './observations.js';

/** 桌面固定编码预算；不接受页面或环境变量扩大上限。 */
export const LIMITS = Object.freeze({
  frame: 1024 * 1024,
  snapshot: 8 * 1024 * 1024,
  chunk: 256 * 1024,
  dataWindow: 4 * 1024 * 1024,
  controlWindow: 64 * 1024,
  requests: 64,
  sessions: 8,
  runs: 4,
  approvals: 128,
  operations: 1024,
  history: 64 * 1024 * 1024,
  /** 单个代码/参数/结果文本的最大展示字符数（UTF-16 单元）；只约束渲染，不截断落盘数据。 */
  displayBudget: 64 * 1024,
  requestTimeout: 30_000,
  approvalTimeout: 120_000,
});
const id = z.string().min(1).max(256);
const text = z.string();
const empty = z.object({}).strict();
const session = z.object({ workspaceId: id, sessionId: id }).strict();
const theme = z.enum(['light', 'dark', 'system']);
const mode = z.enum(['Approval', 'Plan', 'Auto', 'FullAccess']);
const role = z.enum(['default', 'planning', 'execution', 'fast']);
const profile = z
  .object({
    id: id.regex(/^[a-zA-Z0-9._-]+$/),
    name: z.string().min(1).max(128),
    provider: z.enum(['openai-compatible', 'openai-responses', 'anthropic']),
    modelName: z.string().min(1).max(256),
    baseURL: z.url().refine((url) =>
      (() => {
        const parsed = new URL(url);
        return (
          ['http:', 'https:'].includes(parsed.protocol) &&
          !parsed.username &&
          !parsed.password &&
          !parsed.search &&
          !parsed.hash
        );
      })(),
    ),
    apiKeyEnv: z.string().max(128),
    contextWindow: z.number().int().positive().max(10_000_000).optional(),
    maxOutputTokens: z.number().int().positive().max(10_000_000).optional(),
    supportsThinking: z.boolean().optional(),
  })
  .strict();
/** 输入 Profile 不含已有密钥；凭证仅通过专用提交入口接收。 */
export const ProfileDraftSchema = profile;
/** 白名单 Profile 字段，不能以序列化原始设置代替公共目录。 */
export type ProfileDraft = z.infer<typeof profile>;
const credential = z
  .object({
    configured: z.boolean(),
    source: z.enum(['none', 'inline', 'shared', 'env', 'family-env']),
    group: text,
    env: text.optional(),
    fromProfileId: text.optional(),
  })
  .strict();
const publicProfile = profile.extend({
  effectiveBaseURL: z.string(),
  builtin: z.boolean(),
  /** 厂商分组键，与 providers[].key 同源（detectProviderFamily / 'custom'）；页面据此把模型归入左侧厂商列表。 */
  providerKey: z.string(),
  credential,
});
const settings = z
  .object({
    noAuthEnv: id,
    profiles: z.array(publicProfile),
    defaultModel: id,
    routing: z.record(z.string(), z.string()),
    providers: z.array(z.object({ key: text, name: text, description: text }).strict()),
    projectOverride: z.boolean(),
  })
  .strict();
/** 项目名称只作显示别名，不能包含控制字符，不参与目录、信任或历史桶身份。 */
export const ProjectNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) =>
    Array.from(value).every(
      (character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
    ),
  );
const workspace = z
  .object({
    id,
    kind: z.enum(['default', 'project']),
    name: text,
    root: text,
    trusted: z.boolean(),
    trustToken: id,
    recentId: id.optional(),
  })
  .strict();
const error = z.object({ code: z.string().max(100), message: z.string().max(2000) }).strict();
/** 错误只输出稳定业务码和安全说明，不携带 stack 或内部 cause。 */
export type DesktopError = z.infer<typeof error>;
const tool = z
  .object({
    callId: id,
    name: text,
    invocation: text,
    input: text,
    status: z.enum(['running', 'succeeded', 'failed', 'interrupted']),
    result: text.optional(),
    durationMs: z.number().optional(),
    resultMessageId: text.optional(),
    elapsedMs: z.number().optional(),
    outputBytes: z.number().optional(),
  })
  .strict();
const block = z
  .object({
    id: text,
    kind: z.enum(['text', 'thinking', 'tool']),
    text,
    state: z.enum(['streaming', 'completed', 'interrupted']),
    revision: z.number(),
    tool: tool.optional(),
  })
  .strict();
const message = z
  .object({
    id: text,
    role: z.enum(['user', 'assistant', 'system', 'tool']),
    state: z.enum(['streaming', 'completed', 'interrupted']),
    persisted: z.boolean(),
    blocks: z.array(block),
  })
  .strict();
const identity = z
  .object({ conversationId: id, branchId: id, viewEpoch: z.number().int().nonnegative() })
  .strict();
const result = z.enum(['completed', 'failed', 'aborted']);
const notice = z.object({ id: text, level: z.enum(['info', 'warning', 'error']), text }).strict();
/** 完整展示白名单校验，拒绝传入 Core 私有块与任意扩展字段。 */
export const PresentationStateSchema = z
  .object({
    identity,
    sequence: z.number().int().nonnegative(),
    messages: z.array(message),
    pendingMessages: z.array(message),
    order: z.array(text),
    operation: z
      .object({
        id,
        phase: z.enum(['idle', 'running', 'cancelling', 'settling']),
        result: result.optional(),
      })
      .strict()
      .optional(),
    expanded: z.record(text, z.boolean()),
    notices: z.array(notice),
  })
  .strict();
const change = z.discriminatedUnion('type', [
  z.object({ type: z.literal('operation_started') }).strict(),
  z.object({ type: z.literal('cancellation_requested') }).strict(),
  z.object({ type: z.literal('operation_result'), result }).strict(),
  z.object({ type: z.literal('operation_settled'), result: result.optional() }).strict(),
  z
    .object({
      type: z.literal('append'),
      messageId: text,
      blockId: text,
      kind: z.enum(['text', 'thinking']),
      text,
    })
    .strict(),
  z.object({ type: z.literal('block_stopped'), blockId: text }).strict(),
  z.object({ type: z.literal('tool_changed'), messageId: text, block }).strict(),
  z
    .object({
      type: z.literal('message_committed'),
      message,
      provisionalId: text.optional(),
      aliases: z.record(text, text).optional(),
    })
    .strict(),
  z.object({ type: z.literal('set_expanded'), blockId: text, expanded: z.boolean() }).strict(),
  notice.extend({ type: z.literal('diagnostic') }),
]);
/** 顺序增量只承载展示字段，序号不作为授权凭证。 */
export const PresentationEventSchema = identity.extend({
  sequence: z.number().int().positive(),
  operationId: id.optional(),
  change,
});
const runReceipt = z
  .object({
    workspaceId: id,
    sessionId: id,
    runId: id,
    operationId: id,
    phase: z.enum(['running', 'cancelling', 'settling', 'idle']),
    startedAt: z.number().optional(),
    settledAt: z.number().optional(),
    result: result.optional(),
    error: error.optional(),
  })
  .strict();
const approval = session.extend({
  workspaceName: text,
  workspaceRoot: text,
  conversationId: id,
  approvalId: id,
  runId: id,
  toolName: text,
  capabilities: z.array(text),
  description: text,
  sessionAllowed: z.boolean(),
  expiresAt: z.number(),
});
const opened = session.extend({
  conversationId: id,
  configuration: z.object({ profileId: id, role, mode }).strict(),
});
const history = z
  .object({
    conversationId: id,
    title: text,
    messageCount: z.number(),
    lastActivityAt: z.number(),
    /** 置顶只影响列表次序；Host 已按置顶优先排好，页面不再二次重排。 */
    pinned: z.boolean().optional(),
    unavailableReason: text.optional(),
  })
  .strict();
/** 活跃历史与归档历史共用同一页结构；归档页只换数据来源，不另立字段。 */
const historyList = z
  .object({
    items: z.array(history).max(100),
    page: z.number().int(),
    pages: z.number().int(),
    total: z.number().int(),
  })
  .strict();
/** 归档/删除只按会话身份定位，不接受页面自带的文件路径或桶键。 */
const conversation = z.object({ workspaceId: id, conversationId: id }).strict();

/** 每个业务入口独立校验；不能通过通用 channel 调用未登记方法。 */
export const PARAMS = {
  'app.getInfo': empty,
  'app.requestQuit': empty,
  'app.reconnect': empty,
  'app.reload': empty,
  'app.openExternal': z.object({ url: z.url().max(2048) }).strict(),
  'preferences.read': empty,
  'preferences.update': z.object({ theme }).strict(),
  'workspace.openDefault': empty,
  'workspace.pick': empty,
  'workspace.addProject': z
    .object({ workspaceId: id, name: ProjectNameSchema, trustToken: id, acceptTrust: z.boolean() })
    .strict(),
  'workspace.openRecent': z.object({ recentId: id }).strict(),
  'workspace.confirmTrust': z
    .object({ workspaceId: id, trustToken: id, accept: z.boolean() })
    .strict(),
  'settings.read': z.object({ workspaceId: id.optional() }).strict(),
  /** 一次落盘：配置与密钥一起写进本地 settings.json，不做预览令牌或二次提交。 */
  'settings.saveProfile': z
    .object({
      profile,
      /** 本次输入的新密钥；留空则沿用同组已存凭证，都不存在时由 host 拒绝保存。 */
      apiKey: z.string().min(1).max(32_768).optional(),
      editId: id.optional(),
    })
    .strict(),
  'settings.listModels': z
    .object({
      baseURL: z.url(),
      /** 本次输入的临时密钥，不落盘；留空时由 host 按 profileId 复用已存凭证。 */
      apiKey: z.string().min(1).max(32_768).optional(),
      profileId: id.optional(),
    })
    .strict(),
  'settings.setDefault': z.object({ profileId: id }).strict(),
  'settings.setRouting': z
    .object({
      role: z.enum(['planning', 'execution', 'fast', 'summary']),
      profileId: id.optional(),
    })
    .strict(),
  'session.list': z
    .object({
      workspaceId: id,
      page: z.number().int().positive().default(1),
      query: z.string().trim().max(128).optional(),
    })
    .strict(),
  /** 只返回已归档会话；列表页与过滤都在 Host 侧完成，页面不自行拼装分页。 */
  'session.archived': z
    .object({ workspaceId: id, page: z.number().int().positive().default(1) })
    .strict(),
  'session.runtimeSubscribe': z.object({ subscriptionId: z.uuid() }).strict(),
  'session.runtimeUnsubscribe': z.object({ subscriptionId: z.uuid() }).strict(),
  'session.inspect': session.extend({ subscriptionId: z.uuid() }),
  'session.create': z.object({ workspaceId: id, profileId: id.optional() }).strict(),
  'session.open': z.object({ workspaceId: id, conversationId: id }).strict(),
  'session.close': session,
  /** 只追加 archive_state 控制记录，历史正文保持不动，可 restore 还原。 */
  'session.archive': conversation,
  'session.restore': conversation,
  /** 物理删除正文与缓存，不可逆；Host 会先拒绝仍在运行的会话。 */
  'session.delete': conversation,
  'session.configure': session.extend({
    profileId: id.optional(),
    role: role.optional(),
    mode: mode.optional(),
    confirmFullAccess: z.boolean().optional(),
  }),
  /** 标题是独立耐久记录：先 trim 再落盘，运行中的会话也可改名，不打断任务。 */
  'session.rename': conversation.extend({ title: z.string().trim().min(1).max(200) }),
  /** 置顶只写控制记录并改变列表次序，不改活动时间，因此不需要停止在途任务。 */
  'session.pin': conversation.extend({ pinned: z.boolean() }),
  'run.start': session.extend({ operationId: z.uuid(), input: z.string().min(1).max(512_000) }),
  'run.cancel': session.extend({ runId: id }),
  'run.status': session,
  'approval.reply': session.extend({
    approvalId: id,
    runId: id,
    choice: z.enum(['allow_once', 'allow_session', 'deny_once', 'cancel']),
  }),
  'presentation.subscribe': session.extend({ subscriptionId: z.uuid() }),
  'presentation.unsubscribe': session.extend({ subscriptionId: z.uuid() }),
  'presentation.resync': session.extend({ subscriptionId: z.uuid() }),
  'presentation.installed': session.extend({
    subscriptionId: z.uuid(),
    snapshotId: id,
    sequence: z.number().int().nonnegative(),
  }),
} as const;
/** 公开业务方法全集，内部 Host 管理命令不在其中。 */
export type Method = keyof typeof PARAMS;
/** 调用参数从运行时契约推导，防止类型与校验维护两份。 */
export type Params<M extends Method> = z.infer<(typeof PARAMS)[M]>;
/** 每个回复同样校验白名单；不把原始历史或设置对象反传给页面。 */
export const RESULTS = {
  'app.getInfo': z
    .object({
      name: text,
      version: text,
      testBuild: z.boolean(),
      hostInstanceId: id,
      controlEpoch: z.number(),
      platform: text,
      runtimes: z.object({ electron: text, node: text, chrome: text }).strict(),
      notifications: z.boolean(),
      tray: z.boolean(),
    })
    .strict(),
  'app.requestQuit': empty,
  'app.reconnect': empty,
  'app.reload': empty,
  'app.openExternal': empty,
  'preferences.read': z
    .object({
      theme,
      mode: z.enum(['light', 'dark']),
      recent: z.array(z.object({ id, name: text, parent: text }).strict()).max(20),
    })
    .strict(),
  'preferences.update': empty,
  'workspace.openDefault': workspace,
  'workspace.pick': workspace.nullable(),
  'workspace.addProject': workspace,
  'workspace.openRecent': workspace,
  'workspace.confirmTrust': workspace,
  'settings.read': settings,
  /** 保存后回读的落盘结果，页面用它刷新选中项，不必再发一次 settings.read。 */
  'settings.saveProfile': z.object({ profile: publicProfile }).strict(),
  /** 端点返回的模型 id 清单；条目数与长度由 host 设上限，只用于页面选择，不落盘。 */
  'settings.listModels': z.object({ models: z.array(text).max(500) }).strict(),
  'settings.setDefault': empty,
  'settings.setRouting': empty,
  'session.list': historyList,
  'session.archived': historyList,
  'session.runtimeSubscribe': RuntimeSnapshotSchema,
  'session.runtimeUnsubscribe': empty,
  'session.inspect': InspectionSchema,
  'session.create': opened,
  'session.open': opened,
  'session.close': empty,
  'session.archive': empty,
  'session.restore': empty,
  'session.delete': empty,
  'session.configure': opened.shape.configuration,
  'session.rename': empty,
  'session.pin': empty,
  'run.start': runReceipt,
  'run.cancel': runReceipt,
  'run.status': runReceipt.nullable(),
  'approval.reply': empty,
  'presentation.subscribe': empty,
  'presentation.unsubscribe': empty,
  'presentation.resync': empty,
  'presentation.installed': empty,
} as const;
/** 公开回复类型，与具体方法的结果 schema 保持一致。 */
export type Output<M extends Method> = z.infer<(typeof RESULTS)[M]>;
/** 当前登记空间的公共身份；不得由页面自行构造或复用旧 Host 身份。 */
export type Workspace = z.infer<typeof workspace>;
/** 审批显示 DTO；原始受控调用身份仅由 Host 持有。 */
export type Approval = z.infer<typeof approval>;
/** 独立运行状态不携带正文，输出拥塞时仍可查询和停止。 */
export type RunReceipt = z.infer<typeof runReceipt>;
/** 页面通知在接收前校验；分块接收与完整安装是两种不同确认。 */
export const NOTIFICATION = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('session.runtimeChanged'),
      subscriptionId: id,
      snapshot: RuntimeSnapshotSchema,
    })
    .strict(),
  z.object({ type: z.literal('session.runtimeInvalidated'), subscriptionId: id }).strict(),
  session.extend({ type: z.literal('session.inspectionInvalidated'), subscriptionId: id }),
  session.extend({
    type: z.literal('session.inspectionChanged'),
    subscriptionId: id,
    snapshot: InspectionSchema,
  }),
  session.extend({
    subscriptionId: id,
    type: z.literal('presentation.chunk'),
    snapshotId: id,
    index: z.number().int().nonnegative(),
    count: z.number().int().positive().max(64),
    totalBytes: z.number().int().positive().max(LIMITS.snapshot),
    sequence: z.number().int().nonnegative(),
    data: text,
  }),
  session.extend({
    subscriptionId: id,
    type: z.literal('presentation.event'),
    event: PresentationEventSchema,
  }),
  session.extend({ subscriptionId: id, type: z.literal('presentation.invalidated'), reason: text }),
  approval.extend({ type: z.literal('approval.requested') }),
  // reason 说明审批为何关闭：超时/中止的自动拒绝与用户主动裁决要能区分，
  // 否则前端无法解释「从未见过审批入口却收到 PERMISSION_DENIED」的死锁现场。
  z
    .object({
      type: z.literal('approval.closed'),
      approvalId: id,
      reason: z.enum(['resolved', 'timeout', 'aborted']).optional(),
    })
    .strict(),
  z.object({ type: z.literal('run.changed'), receipt: runReceipt }).strict(),
  z.object({ type: z.literal('theme.changed'), mode: z.enum(['light', 'dark']) }).strict(),
  z.object({ type: z.literal('host.unavailable'), error }).strict(),
]);
/** 页面只能收到这些安全通知，不暴露 MessagePort 或原始 SessionEvent。 */
export type Notification = z.infer<typeof NOTIFICATION>;
/** 内部请求只允许登记业务入口；来源和资源归属由 Main/Host 继续校验。 */
export const RequestSchema = z
  .object({
    kind: z.literal('request'),
    requestId: z.uuid(),
    method: z.enum(Object.keys(PARAMS) as [Method, ...Method[]]),
    params: z.unknown(),
  })
  .strict();
/** 回复错误从业务错误 DTO 读取，成功载荷按对应方法二次验证。 */
export const ReplySchema = z.discriminatedUnion('ok', [
  z
    .object({ kind: z.literal('reply'), requestId: id, ok: z.literal(true), result: z.unknown() })
    .strict(),
  z.object({ kind: z.literal('reply'), requestId: id, ok: z.literal(false), error }).strict(),
]);
/** 页面注入的 API 由每个命名方法组成；底层请求、通道和端口不暴露。 */
export type DesktopAPI = {
  /** 首帧仅返回 Main 验证来源后的主题枚举，不访问文件或提供同步业务调用。 */
  initialTheme(): 'light' | 'dark';
  ready(): Promise<void>;
  app: {
    getInfo(): Promise<Output<'app.getInfo'>>;
    requestQuit(): Promise<void>;
    reconnect(): Promise<void>;
    reload(): Promise<void>;
    openExternal(url: string): Promise<void>;
  };
  preferences: {
    read(): Promise<Output<'preferences.read'>>;
    update(theme: 'light' | 'dark' | 'system'): Promise<void>;
  };
  workspace: {
    openDefault(): Promise<Workspace>;
    pick(): Promise<Workspace | null>;
    addProject(params: Params<'workspace.addProject'>): Promise<Workspace>;
    openRecent(recentId: string): Promise<Workspace>;
    confirmTrust(params: Params<'workspace.confirmTrust'>): Promise<Workspace>;
  };
  settings: {
    read(workspaceId?: string): Promise<Output<'settings.read'>>;
    /** 直接写入本地配置并回读结果；不经过预览令牌。 */
    saveProfile(params: Params<'settings.saveProfile'>): Promise<Output<'settings.saveProfile'>>;
    /** 只读探测：按 Base URL 拉取模型目录，供自定义端点直接选模型。 */
    listModels(params: Params<'settings.listModels'>): Promise<Output<'settings.listModels'>>;
    setDefault(profileId: string): Promise<void>;
    setRouting(params: Params<'settings.setRouting'>): Promise<void>;
  };
  session: {
    runtimeSubscribe(subscriptionId: string): Promise<Output<'session.runtimeSubscribe'>>;
    runtimeUnsubscribe(subscriptionId: string): Promise<void>;
    inspect(params: Params<'session.inspect'>): Promise<Output<'session.inspect'>>;
    list(workspaceId: string, page?: number, query?: string): Promise<Output<'session.list'>>;
    /** 已归档会话单独分页读取；不混进活跃列表，避免归档项挤占侧栏页码。 */
    archived(workspaceId: string, page?: number): Promise<Output<'session.archived'>>;
    create(workspaceId: string, profileId?: string): Promise<Output<'session.create'>>;
    open(params: Params<'session.open'>): Promise<Output<'session.open'>>;
    close(params: Params<'session.close'>): Promise<void>;
    archive(params: Params<'session.archive'>): Promise<void>;
    restore(params: Params<'session.restore'>): Promise<void>;
    /** 永久删除会话历史；运行中的会话由 Host 拒绝，页面必须先停止任务。 */
    delete(params: Params<'session.delete'>): Promise<void>;
    configure(params: Params<'session.configure'>): Promise<Output<'session.configure'>>;
    /** 重命名只写标题记录；已打开与未打开的会话都可用，不要求先停止任务。 */
    rename(params: Params<'session.rename'>): Promise<void>;
    /** 置顶只改列表次序，可随时切换。 */
    pin(params: Params<'session.pin'>): Promise<void>;
  };
  run: {
    start(params: Params<'run.start'>): Promise<RunReceipt>;
    cancel(params: Params<'run.cancel'>): Promise<RunReceipt>;
    status(params: Params<'run.status'>): Promise<RunReceipt | null>;
  };
  approval: { reply(params: Params<'approval.reply'>): Promise<void> };
  presentation: {
    subscribe(params: Params<'presentation.subscribe'>): Promise<void>;
    unsubscribe(params: Params<'presentation.unsubscribe'>): Promise<void>;
    resync(params: Params<'presentation.resync'>): Promise<void>;
    installed(params: Params<'presentation.installed'>): Promise<void>;
  };
  onEvent(listener: (event: Notification) => void | Promise<void>): () => void;
};
/** UTF-8 编码预算用于中文和 emoji，不按 JavaScript 字符长度计数。 */
export function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
    .byteLength;
}

/** 每跳遵守同一业务分类；后台摘要和观察正文不能占用独立停止容量。 */
export function notificationLane(type: Notification['type']): 'data' | 'control' {
  return [
    'presentation.chunk',
    'presentation.event',
    'session.runtimeChanged',
    'session.inspectionChanged',
  ].includes(type)
    ? 'data'
    : 'control';
}
