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
  /** 安装包流式下载的 RPC 总预算（空闲断连另由主进程 60s 看门狗逐块拦截，不得被常规 30s RPC 超时截断）。 */
  downloadTimeout: 30 * 60_000,
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
    /** 自定义厂商展示名；内置模型缺省，填写后桌面左栏按该名称独立成组。 */
    vendorName: z.string().max(64).optional(),
    /** 停用态：只影响选择入口，缺省视为启用。 */
    disabled: z.boolean().optional(),
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
  /** 读投影恒返回布尔，页面不必再判 undefined。 */
  disabled: z.boolean(),
  /** 归属范围：global 可在设置页管理；project 来自项目级配置，页面只读展示、不提供操作入口。 */
  scope: z.enum(['global', 'project']),
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
    /** 新建会话的默认审批档位；FullAccess 不会出现在全局默认里。 */
    permissionMode: mode,
    providers: z.array(
      z.object({ key: text, name: text, description: text, custom: z.boolean() }).strict(),
    ),
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
/** 工具产物只投影宿主已按允许根校验过的图片；路径与扩展名都是宿主下发值。 */
const artifact = z
  .object({
    kind: z.literal('image'),
    path: text,
    ext: text,
    /** 宿主观察到的大小（字节）；缺省表示未取得，渲染层按普通图片尝试读取。 */
    size: z.number().optional(),
  })
  .strict();
const tool = z
  .object({
    callId: id,
    name: text,
    /** 显示名（host 层解析的中文短名 / MCP 归一名）；只影响 UI，不参与权限判定。 */
    displayName: text,
    invocation: text,
    /** 动作动词与唯一对象 chip；缺省时渲染层退回 invocation。 */
    verb: text.optional(),
    chip: text.optional(),
    mono: z.boolean().optional(),
    input: text,
    status: z.enum(['running', 'succeeded', 'failed', 'interrupted']),
    result: text.optional(),
    durationMs: z.number().optional(),
    resultMessageId: text.optional(),
    elapsedMs: z.number().optional(),
    outputBytes: z.number().optional(),
    /** 缺省表示本次调用不投影产物；失败终态与非图片扩展一律缺省（SVG 纳入图片）。 */
    artifacts: z.array(artifact).optional(),
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
    /** 技能信封文本块的来源技能名；页面据此折叠为徽章，正文不再整段展开。 */
    skillName: text.optional(),
  })
  .strict();
/** 单条助手消息的模型消耗；只用于展示，旧记录缺失时整块省略。 */
const usage = z
  .object({
    promptTokens: z.number().nonnegative(),
    completionTokens: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
  })
  .strict();
const message = z
  .object({
    id: text,
    role: z.enum(['user', 'assistant', 'system', 'tool']),
    state: z.enum(['streaming', 'completed', 'interrupted']),
    persisted: z.boolean(),
    blocks: z.array(block),
    usage: usage.optional(),
  })
  .strict();
const identity = z
  .object({
    conversationId: id,
    branchId: id,
    viewEpoch: z.number().int().nonnegative(),
  })
  .strict();
const result = z.enum(['completed', 'failed', 'aborted']);
const notice = z.object({ id: text, level: z.enum(['info', 'warning', 'error']), text }).strict();
/** 任务清单只读投影；四态包含 cancelled，宿主按历史重算后整体下发。 */
const todoItem = z
  .object({
    id: text,
    title: text,
    status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
  })
  .strict();
const todos = z
  .object({
    items: z.array(todoItem),
    updatedAt: z.number().optional(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
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
    /** 无成功 `todo_write` 历史时缺省；桌面 pill 与浮层据此隐藏。 */
    todos: todos.optional(),
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
  // 重试截断历史后整体替换消息列表；页面必须丢弃旧回答，不能当增量追加。
  z
    .object({ type: z.literal('history_replaced'), messages: z.array(message) })
    .strict(),
  z
    .object({
      type: z.literal('set_expanded'),
      blockId: text,
      expanded: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal('todos_changed'), todos: todos.optional() }).strict(),
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

/** 会话看板：缺失事实用 null 显式表达，渲染层据此显示「未记录」而不是 0。 */
const evidenceChange = z
  .object({
    path: text,
    callId: text,
    status: z.enum(['recorded', 'truncated', 'missing']),
    additions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
  })
  .strict();
const evidenceReference = z
  .object({
    sessionId: text,
    recordId: text,
    role: z.enum(['user', 'assistant', 'branch_summary']),
    timestamp: z.number().int().nonnegative(),
    title: text.nullable(),
  })
  .strict();
const evidenceMcp = z
  .object({
    server: text,
    calls: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .strict();
const evidenceDelegation = z
  .object({
    sessionId: text,
    title: text,
    taskName: text,
    state: z.enum(['running', 'ended', 'finished', 'idle', 'archived']),
    summary: text.nullable(),
    lastActivityAt: z.number().int().nonnegative(),
  })
  .strict();
const evidence = z
  .object({
    summary: z
      .object({
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
        truncatedFiles: z.number().int().nonnegative(),
        missingFiles: z.number().int().nonnegative(),
        references: z.number().int().nonnegative(),
        mcpCalls: z.number().int().nonnegative(),
        mcpFailures: z.number().int().nonnegative(),
        runningDelegations: z.number().int().nonnegative(),
      })
      .strict(),
    changes: z.array(evidenceChange).max(100_000),
    references: z.array(evidenceReference).max(100_000),
    mcp: z.array(evidenceMcp).max(100_000),
    delegations: z.array(evidenceDelegation).max(100_000),
  })
  .strict();

/** 面板诊断条目；message 已过脱敏管道，不得携带密钥原文。 */
const mcpDiagnostic = z
  .object({
    severity: z.enum(['error', 'warning', 'info']),
    code: text,
    serverName: text.optional(),
    message: text,
  })
  .strict();
/** 批准状态只含结论与时间戳，绝不携带配置值或密钥。 */
const mcpApproval = z
  .object({
    approved: z.boolean(),
    /** 最近一次批准时间；配置变化后仍保留，用于提示「批准已过期」。 */
    approvedAt: text.optional(),
  })
  .strict();
const mcpServer = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    source: z.enum(['global', 'project']),
    type: z.enum(['stdio', 'http', 'disabled']),
    /** 目标摘要（命令行或 URL），已脱敏；env/headers 只报存在性不报值。 */
    target: text,
    /**
     * 编辑回填面：未脱敏的原始 command/args/url。目标串内嵌密钥（触发脱敏）时缺省，
     * 页面须转 keepTransport 编辑——禁止拿脱敏摘要回写传输字段。
     */
    edit: z
      .object({
        command: text.optional(),
        args: z.array(text).max(64).optional(),
        url: text.optional(),
      })
      .strict()
      .optional(),
    hasSecretSurface: z.boolean(),
    enabled: z.boolean(),
    required: z.boolean(),
    /**
     * 逐服务器启动批准状态；只对进入批准条目表的 server 下发。
     * 未信任项目的声明不启动，因此不提供批准态，页面据此显示为不可操作。
     */
    approval: mcpApproval.optional(),
    diagnostics: z.array(mcpDiagnostic).max(64),
  })
  .strict();
const mcpSnapshot = z
  .object({
    projectTrusted: z.boolean(),
    servers: z.array(mcpServer).max(200),
    diagnostics: z.array(mcpDiagnostic).max(200),
  })
  .strict();
/** 外部 Harness 名单与宿主导入服务一致；新增来源必须两侧同步。 */
const mcpImportHarness = z.enum(['claude-desktop', 'claude-code', 'cursor']);
/**
 * 导入候选的安全投影：宿主原对象还带完整 `config`（含 env / headers 值）与摘要，
 * 这些字段留在宿主进程，绝不进入 renderer。
 */
const mcpImportCandidate = z
  .object({
    harness: mcpImportHarness,
    name: z.string().min(1).max(256),
    /** 来源文件绝对路径；执行导入时按它做 TOCTOU 比对。 */
    sourceRef: text,
    origin: z.enum(['global', 'project']),
    transport: z.enum(['stdio', 'http']),
    /** 目标摘要（命令行或端点 URL），已脱敏。 */
    target: text,
    hasSecretSurface: z.boolean(),
    strippedFields: z.array(text).max(64),
    /** 名称不合法时的原因；非空表示导入必然失败。 */
    nameProblem: text.optional(),
    conflict: z.enum(['none', 'exists-enabled', 'exists-disabled']),
    previouslyImported: z
      .object({
        installedAt: text,
        installedDigest: text,
        sourceUnchanged: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
const mcpImportScan = z
  .object({
    sources: z
      .array(
        z
          .object({
            harness: mcpImportHarness,
            label: text,
            files: z
              .array(
                z
                  .object({
                    path: text,
                    origin: z.enum(['global', 'project']),
                    readable: z.boolean(),
                    servers: z.number().int().nonnegative(),
                  })
                  .strict(),
              )
              .max(8),
            candidates: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(8),
    candidates: z.array(mcpImportCandidate).max(400),
    diagnostics: z.array(mcpDiagnostic).max(4000),
  })
  .strict();
const mcpImportOutcome = z
  .object({
    harness: text,
    name: text,
    status: z.enum(['imported', 'unchanged', 'skipped-conflict', 'failed']),
    sourceRef: text.optional(),
    targetPath: text.optional(),
    message: text.optional(),
    strippedFields: z.array(text).max(64).optional(),
  })
  .strict();
const mcpImportResult = z
  .object({
    scope: z.enum(['global', 'project']),
    items: z.array(mcpImportOutcome).max(400),
    imported: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    skippedConflict: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    diagnostics: z.array(mcpDiagnostic).max(4000),
  })
  .strict();
const skillSummary = z
  .object({
    name: z.string().min(1).max(128),
    scope: z.enum(['global', 'project', 'builtin']),
    available: z.boolean(),
    unavailableReason: text.optional(),
    userInvocable: z.boolean(),
    disabled: z.boolean(),
    description: text,
    sourceRoot: text,
    filePath: text,
  })
  .strict();
const skillsSnapshot = z
  .object({
    enabled: z.boolean(),
    skills: z.array(skillSummary).max(5000),
    diagnostics: z
      .array(
        z
          .object({
            code: text,
            level: z.enum(['warn', 'error']),
            path: text,
            message: text,
          })
          .strict(),
      )
      .max(2000),
  })
  .strict();
const skillDiagnostic = z
  .object({ code: text, level: z.enum(['warn', 'error']), path: text, message: text })
  .strict();
/** 外部 Harness 名单与宿主导入服务一致；新增来源必须两侧同步。 */
const skillHarness = z.enum(['claude-code', 'codex', 'cursor', 'opencode']);
const skillImportCandidate = z
  .object({
    harness: skillHarness,
    name: z.string().min(1).max(128),
    directoryName: z.string().min(1).max(256),
    description: text,
    sourceRef: text,
    origin: z.enum(['global', 'project']),
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    hasScripts: z.boolean(),
    strippedFields: z.array(text).max(64),
    conflict: z.enum(['none', 'exists-enabled', 'exists-disabled']),
    unpublished: text.optional(),
    previouslyImported: z
      .object({
        installedAt: text,
        installedDigest: text,
        sourceUnchanged: z.boolean(),
        changedFiles: z.array(text).max(4096),
      })
      .strict()
      .optional(),
  })
  .strict();
const skillImportScan = z
  .object({
    sources: z
      .array(
        z
          .object({
            harness: skillHarness,
            label: text,
            roots: z
              .array(
                z
                  .object({
                    path: text,
                    scope: z.enum(['global', 'project']),
                    readable: z.boolean(),
                  })
                  .strict(),
              )
              .max(8),
            candidates: z.number().int().nonnegative(),
            partial: z.boolean(),
            truncated: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(8),
    candidates: z.array(skillImportCandidate).max(4000),
    diagnostics: z.array(skillDiagnostic).max(4000),
    partial: z.boolean(),
  })
  .strict();
const skillImportOutcome = z
  .object({
    harness: text,
    name: text,
    status: z.enum(['imported', 'unchanged', 'skipped-conflict', 'skipped-limit', 'failed']),
    sourceRef: text.optional(),
    targetPath: text.optional(),
    message: text.optional(),
    strippedFields: z.array(text).max(64).optional(),
  })
  .strict();
const skillImportResult = z
  .object({
    scope: z.enum(['global', 'project']),
    items: z.array(skillImportOutcome).max(1000),
    imported: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    skippedConflict: z.number().int().nonnegative(),
    skippedLimit: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    truncated: z.number().int().nonnegative(),
    diagnostics: z.array(skillDiagnostic).max(4000),
  })
  .strict();

/**
 * 更新检查结果：只携带判断结论与资产地址，不含下载内容。
 * `unknown` 表示网络或响应异常，页面静默降级，不阻断使用。
 */
const updateCheckResult = z
  .object({
    status: z.enum(['update-available', 'up-to-date', 'no-asset', 'unknown']),
    currentVersion: text,
    latestVersion: text.optional(),
    releaseUrl: z.url().max(2048).optional(),
    /** 当前平台安装包；仅在 `update-available` 时存在。 */
    installer: z
      .object({ name: text, url: z.url().max(2048), size: z.number().nonnegative() })
      .strict()
      .optional(),
    /** 同一平台的 SHA256 清单；下载与打开前必须校验（U0.2）。 */
    checksum: z
      .object({ name: text, url: z.url().max(2048) })
      .strict()
      .optional(),
    reason: text.optional(),
  })
  .strict();

/**
 * 下载结果：下载完成只代表文件已通过 SHA256 校验，`opened` 表示系统是否成功
 * 唤起安装包；失败只返回稳定原因码与可选细节，页面负责转成中文提示。
 */
const updateDownloadResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('downloaded'), filePath: text, opened: z.boolean() }).strict(),
  z.object({ status: z.literal('cancelled') }).strict(),
  z.object({ status: z.literal('failed'), reason: text, detail: text.optional() }).strict(),
]);

/** 每个业务入口独立校验；不能通过通用 channel 调用未登记方法。 */
export const PARAMS = {
  'app.getInfo': empty,
  'app.checkUpdate': empty,
  'app.downloadUpdate': empty,
  'app.cancelUpdateDownload': empty,
  'app.requestQuit': empty,
  'app.reconnect': empty,
  'app.reload': empty,
  'app.openExternal': z.object({ url: z.url().max(2048) }).strict(),
  'preferences.read': empty,
  'preferences.update': z.object({ theme }).strict(),
  'workspace.openDefault': empty,
  'workspace.pick': empty,
  'workspace.addProject': z
    .object({
      workspaceId: id,
      name: ProjectNameSchema,
      trustToken: id,
      acceptTrust: z.boolean(),
    })
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
      /** 端点协议族；决定鉴权头形状（anthropic 需 x-api-key），缺省按已存 Profile 或 openai-compatible。 */
      provider: z.enum(['openai-compatible', 'anthropic', 'openai-responses']).optional(),
    })
    .strict(),
  'settings.setDefault': z.object({ profileId: id }).strict(),
  /** 只允许三个常规档位；FullAccess 必须由本次会话显式确认，不能写进全局默认。 */
  'settings.setPermissionMode': z.object({ mode: z.enum(['Approval', 'Plan', 'Auto']) }).strict(),
  /** 启用/停用单个模型；停用当前默认模型时由 host 迁移默认与路由引用。 */
  'settings.setEnabled': z.object({ profileId: id, enabled: z.boolean() }).strict(),
  /** 删除模型：自定义模型移除条目，内置模型只写停用态并保留已存密钥。 */
  'settings.deleteProfile': z.object({ profileId: id }).strict(),
  /** 探测一次连接：复用已存或免密钥端点，只发 GET /models 请求。 */
  'settings.testProfile': z.object({ profileId: id }).strict(),
  'settings.setRouting': z
    .object({
      role: z.enum(['planning', 'execution', 'fast', 'summary']),
      profileId: id.optional(),
    })
    .strict(),

  'resources.readMcp': z.object({ workspaceId: id }).strict(),
  'resources.saveMcpServer': z
    .object({
      workspaceId: id,
      /** 写入目标；项目级要求已信任，宿主事务内强制校验，未信任必然失败。 */
      scope: z.enum(['global', 'project']).optional(),
      /** 编辑模式提供原名称；新增时省略。编辑保留声明中面板外的字段（env/headers/required）。 */
      editName: z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,64}$/)
        .optional(),
      /**
       * 原传输声明不满足面板编辑条件（快照未提供未脱敏回填面）时置位：
       * 服务端保留原 type/command/args/url 原文，仅允许改名与启停。
       */
      keepTransport: z.boolean().optional(),
      draft: z
        .object({
          name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
          type: z.enum(['stdio', 'http']),
          command: z.string().min(1).max(4096).optional(),
          args: z.array(z.string().max(4096)).max(64).optional(),
          url: z.string().min(1).max(4096).optional(),
          enabled: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  'resources.deleteMcpServer': z
    .object({
      workspaceId: id,
      scope: z.enum(['global', 'project']).optional(),
      name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    })
    .strict(),
  'resources.toggleMcpServer': z
    .object({
      workspaceId: id,
      scope: z.enum(['global', 'project']).optional(),
      name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      enabled: z.boolean(),
    })
    .strict(),
  /** 逐服务器启动批准：绑定当前配置摘要，不回显任何配置值。 */
  'resources.approveMcpServer': z
    .object({
      workspaceId: id,
      name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    })
    .strict(),
  'resources.revokeMcpServer': z
    .object({
      workspaceId: id,
      name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    })
    .strict(),
  /** MCP 导入预览；只扫描一次，不预热也不轮询外部配置文件。 */
  'resources.inspectMcpImport': z
    .object({
      workspaceId: id,
      scope: z.enum(['global', 'project']).optional(),
    })
    .strict(),
  /** 执行 MCP 导入：只传来源身份与目标作用域，配置正文由宿主重新扫描得到。 */
  'resources.importMcp': z
    .object({
      workspaceId: id,
      scope: z.enum(['global', 'project']),
      items: z
        .array(
          z
            .object({
              harness: mcpImportHarness,
              name: z.string().min(1).max(256),
              expectedSourceRef: z.string().min(1).max(4096),
            })
            .strict(),
        )
        .max(200),
      overwrite: z.boolean().optional(),
    })
    .strict(),
  'resources.readSkills': z.object({ workspaceId: id }).strict(),
  'resources.setSkillsEnabled': z.object({ workspaceId: id, enabled: z.boolean() }).strict(),
  'resources.setSkillDisabled': z
    .object({
      workspaceId: id,
      name: z.string().min(1).max(128),
      disabled: z.boolean(),
    })
    .strict(),
  'resources.inspectSkills': z.object({ workspaceId: id }).strict(),
  /** 只传来源身份，不传正文；`items` 为空数组表示导入全部候选。 */
  'resources.importSkills': z
    .object({
      workspaceId: id,
      scope: z.enum(['global', 'project']),
      items: z
        .array(
          z
            .object({
              harness: skillHarness,
              name: z.string().min(1).max(128),
              expectedSourceRef: z.string().min(1).max(4096),
            })
            .strict(),
        )
        .max(200),
      overwrite: z.boolean().optional(),
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
  'session.rename': conversation.extend({
    title: z.string().trim().min(1).max(200),
  }),
  /** 置顶只写控制记录并改变列表次序，不改活动时间，因此不需要停止在途任务。 */
  'session.pin': conversation.extend({ pinned: z.boolean() }),
  /** 会话看板只读聚合；每次按当前 canonical 历史重算，页面只消费聚合结果。 */
  'session.evidence': session,
  'run.start': session.extend({
    operationId: z.uuid(),
    input: z.string().min(1).max(512_000),
    /** 重试：宿主先截断上一轮再按同一输入重跑；缺省为普通发送。 */
    regenerate: z.boolean().optional(),
  }),
  'run.cancel': session.extend({ runId: id }),
  'run.status': session,
  'approval.reply': session.extend({
    approvalId: id,
    runId: id,
    choice: z.enum(['allow_once', 'allow_session', 'deny_once', 'cancel']),
  }),
  /** 斜杠命令执行；以 `/` 开头的输入由页面拦截后走命令系统，不再作为普通消息发模型。 */
  'run.command': session.extend({ input: z.string().min(1).max(4096) }).strict(),
  /** 命令目录（补全数据源）：与 CLI 命令目录同源，含交互分级供页面提示可用性。 */
  'run.commandList': empty,
  /**
   * 会话级技能目录（`/` 补全面板技能组数据源）：来自当前会话运行时 registry，
   * 宿主已按「现在就能跑」口径过滤（userInvocable 且 available 且未禁用），
   * 与 CLI 的 `/skill ` 名字补全同口径；诊断与激活态不进此面，仍走 session.inspect。
   */
  'run.skillCatalog': session,
  /** 命令交互应答：question/select/readSecret 的对话框回传；value 缺省视为取消。 */
  'interaction.reply': session.extend({
    requestId: id,
    value: z.string().max(32_768).optional(),
  }),
  /** 沙箱内文件路径枚举（相对路径清单），供 composer `@` 文件补全；有界返回。 */
  'workspace.listFiles': z.object({ workspaceId: id }).strict(),
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
  'app.checkUpdate': updateCheckResult,
  'app.downloadUpdate': updateDownloadResult,
  'app.cancelUpdateDownload': empty,
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
  'settings.setPermissionMode': empty,
  'settings.setEnabled': empty,
  'settings.deleteProfile': empty,
  /** ok=false 时 message 已是可展示的中文短句，页面直接渲染。 */
  'settings.testProfile': z.object({ ok: z.boolean(), message: text }).strict(),
  'settings.setRouting': empty,
  'resources.readMcp': mcpSnapshot,
  'resources.saveMcpServer': mcpSnapshot,
  'resources.deleteMcpServer': mcpSnapshot,
  'resources.toggleMcpServer': mcpSnapshot,
  'resources.approveMcpServer': mcpSnapshot,
  'resources.revokeMcpServer': mcpSnapshot,
  'resources.inspectMcpImport': mcpImportScan,
  'resources.importMcp': mcpImportResult,
  'resources.readSkills': skillsSnapshot,
  'resources.setSkillsEnabled': skillsSnapshot,
  'resources.setSkillDisabled': skillsSnapshot,
  'resources.inspectSkills': skillImportScan,
  'resources.importSkills': skillImportResult,
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
  'session.evidence': evidence,
  'run.start': runReceipt,
  'run.cancel': runReceipt,
  'run.status': runReceipt.nullable(),
  'approval.reply': empty,
  'run.command': z.object({ handled: z.boolean(), feedback: z.array(text).max(500) }).strict(),
  'run.commandList': z
    .object({
      commands: z
        .array(
          z
            .object({
              name: z.string().min(1).max(64),
              usage: text,
              description: text,
              interactionLevel: z.enum(['none', 'select', 'question', 'secret']),
            })
            .strict(),
        )
        .max(200),
    })
    .strict(),
  'interaction.reply': empty,
  /**
   * 会话技能目录的有界投影：只含补全面板需要的名称/描述/来源，
   * description 由宿主截断到 256 字符（契约上限放宽留余量）；超限置 truncated。
   */
  'run.skillCatalog': z
    .object({
      /**
       * 会话目录里是否存在技能条目（含不可调用项）；false 表示一个技能都没装。
       * installed 为 true 而 skills 为空 = 有技能但全部被禁用或不可调用，
       * 面板据此展示「已禁用」提示而不是把空目录误报成关闭。
       */
      installed: z.boolean(),
      skills: z
        .array(
          z
            .object({
              name: z.string().min(1).max(64),
              description: z.string().max(300),
              scope: z.enum(['global', 'project', 'builtin']),
            })
            .strict(),
        )
        .max(500),
      truncated: z.boolean(),
    })
    .strict(),
  'workspace.listFiles': z
    .object({
      files: z.array(text).max(5000),
      /** 超出深度/条目预算时截断；页面在补全面板明示「未列全」。 */
      truncated: z.boolean(),
    })
    .strict(),
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
  z
    .object({
      type: z.literal('session.runtimeInvalidated'),
      subscriptionId: id,
    })
    .strict(),
  session.extend({
    type: z.literal('session.inspectionInvalidated'),
    subscriptionId: id,
  }),
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
  session.extend({
    subscriptionId: id,
    type: z.literal('presentation.invalidated'),
    reason: text,
  }),
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
  session.extend({
    type: z.literal('interaction.requested'),
    requestId: id,
    kind: z.enum(['question', 'secret', 'select']),
    prompt: text,
    options: z
      .array(z.object({ value: text, label: text }).strict())
      .max(50)
      .optional(),
  }),
  session.extend({
    type: z.literal('interaction.closed'),
    requestId: id,
    reason: z.enum(['resolved', 'timeout', 'aborted']).optional(),
  }),
  z.object({ type: z.literal('run.changed'), receipt: runReceipt }).strict(),
  // 监视终态只带身份与状态：目标路径与文件内容留在宿主侧，系统通知也不需要它们。
  // kind 与宿主协议同源收窄：process_exit 自 v0.1.4 摘除、不再出现在 wire 上，
  // 通知面保留它会放宽出宿主永远不会发送的死枚举值。
  z
    .object({
      type: z.literal('watch.triggered'),
      sessionId: id,
      watchId: id,
      kind: z.enum(['file_change', 'port_ready']),
      state: z.enum(['fired', 'timeout', 'cancelled', 'orphaned']),
    })
    .strict(),
  z
    .object({
      type: z.literal('theme.changed'),
      mode: z.enum(['light', 'dark']),
    })
    .strict(),
  // 下载进度只用于界面反馈：主进程节流后发送，丢一帧不影响最终结果（结果走 RPC 回复）。
  z
    .object({
      type: z.literal('update.downloadProgress'),
      downloaded: z.number().int().nonnegative(),
      /** 未知总大小时为 0，页面不得据此计算百分比。 */
      total: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ type: z.literal('host.unavailable'), error }).strict(),
]);
/** 页面只能收到这些安全通知，不暴露 MessagePort 或原始 SessionEvent。 */
export type Notification = z.infer<typeof NOTIFICATION>;
/** 命令交互请求事件（question/select/secret）；应答经 interaction.reply 单点回传。 */
export type InteractionRequest = Extract<Notification, { type: 'interaction.requested' }>;
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
    .object({
      kind: z.literal('reply'),
      requestId: id,
      ok: z.literal(true),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reply'),
      requestId: id,
      ok: z.literal(false),
      error,
    })
    .strict(),
]);
/** 页面注入的 API 由每个命名方法组成；底层请求、通道和端口不暴露。 */
export type DesktopAPI = {
  /** 首帧仅返回 Main 验证来源后的主题枚举，不访问文件或提供同步业务调用。 */
  initialTheme(): 'light' | 'dark';
  ready(): Promise<void>;
  app: {
    getInfo(): Promise<Output<'app.getInfo'>>;
    /** 用户显式触发的一次性检查；离线或响应异常返回 `unknown`，不影响启动。 */
    checkUpdate(): Promise<Output<'app.checkUpdate'>>;
    /** 下载最近一次检查到的安装包（无参数，URL 只保存在主进程），校验通过后才打开。 */
    downloadUpdate(): Promise<Output<'app.downloadUpdate'>>;
    /** 取消在途下载；没有下载时是空操作。 */
    cancelUpdateDownload(): Promise<void>;
    requestQuit(): Promise<void>;
    reconnect(): Promise<void>;
    reload(): Promise<void>;
    openExternal(url: string): Promise<void>;
  };
  preview: {
    /** 登记一份预览文档并取回独立来源的地址；超过预览上限或来源不合法时拒绝。 */
    url(html: string): Promise<string>;
    /**
     * 按路径读取本地图片并返回 data URL；相对路径以传入的 root 解析。
     * 只接受图片扩展名白名单与大小上限内的文件，其余一律拒绝。
     */
    file(params: { path: string; root?: string }): Promise<string>;
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
    listFiles(workspaceId: string): Promise<Output<'workspace.listFiles'>>;
  };
  settings: {
    read(workspaceId?: string): Promise<Output<'settings.read'>>;
    /** 直接写入本地配置并回读结果；不经过预览令牌。 */
    saveProfile(params: Params<'settings.saveProfile'>): Promise<Output<'settings.saveProfile'>>;
    /** 只读探测：按 Base URL 拉取模型目录，供自定义端点直接选模型。 */
    listModels(params: Params<'settings.listModels'>): Promise<Output<'settings.listModels'>>;
    setDefault(profileId: string): Promise<void>;
    /** 写入新建会话的默认审批档位；只接受常规档位，完全访问不进全局默认。 */
    setPermissionMode(mode: 'Approval' | 'Plan' | 'Auto'): Promise<void>;
    /** 启用/停用模型；停用后从选择入口消失，配置与密钥保留。 */
    setEnabled(params: Params<'settings.setEnabled'>): Promise<void>;
    /** 删除模型：内置模型等价于停用，自定义模型移除条目。 */
    deleteProfile(profileId: string): Promise<void>;
    /** 探测连接；失败也以 ok=false 正常返回，不当作 RPC 错误。 */
    testProfile(profileId: string): Promise<Output<'settings.testProfile'>>;
    setRouting(params: Params<'settings.setRouting'>): Promise<void>;
  };
  resources: {
    readMcp(workspaceId: string): Promise<Output<'resources.readMcp'>>;
    saveMcpServer(
      params: Params<'resources.saveMcpServer'>,
    ): Promise<Output<'resources.saveMcpServer'>>;
    deleteMcpServer(
      params: Params<'resources.deleteMcpServer'>,
    ): Promise<Output<'resources.deleteMcpServer'>>;
    toggleMcpServer(
      params: Params<'resources.toggleMcpServer'>,
    ): Promise<Output<'resources.toggleMcpServer'>>;
    /** 批准单个服务器启动；绑定当前配置摘要，配置改动后需重新批准。 */
    approveMcpServer(
      params: Params<'resources.approveMcpServer'>,
    ): Promise<Output<'resources.approveMcpServer'>>;
    /** 撤销批准；下一次启动会重新请求确认。 */
    revokeMcpServer(
      params: Params<'resources.revokeMcpServer'>,
    ): Promise<Output<'resources.revokeMcpServer'>>;
    /** 扫描外部工具的 MCP 声明；只返回脱敏投影，不返回配置正文。 */
    inspectMcpImport(
      params: Params<'resources.inspectMcpImport'>,
    ): Promise<Output<'resources.inspectMcpImport'>>;
    /** 执行 MCP 导入；冲突默认跳过，`overwrite` 才替换。 */
    importMcp(params: Params<'resources.importMcp'>): Promise<Output<'resources.importMcp'>>;
    readSkills(workspaceId: string): Promise<Output<'resources.readSkills'>>;
    setSkillsEnabled(
      params: Params<'resources.setSkillsEnabled'>,
    ): Promise<Output<'resources.setSkillsEnabled'>>;
    setSkillDisabled(
      params: Params<'resources.setSkillDisabled'>,
    ): Promise<Output<'resources.setSkillDisabled'>>;
    /** 扫描外部 Harness 的可导入技能；只在打开导入抽屉时调用一次。 */
    inspectSkills(workspaceId: string): Promise<Output<'resources.inspectSkills'>>;
    /** 执行导入；项目作用域在未信任项目上由 host 直接拒绝。 */
    importSkills(
      params: Params<'resources.importSkills'>,
    ): Promise<Output<'resources.importSkills'>>;
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
    /** 会话看板只读聚合；面板与摘要 chip 消费同一份结果。 */
    evidence(params: Params<'session.evidence'>): Promise<Output<'session.evidence'>>;
  };
  run: {
    start(params: Params<'run.start'>): Promise<RunReceipt>;
    cancel(params: Params<'run.cancel'>): Promise<RunReceipt>;
    status(params: Params<'run.status'>): Promise<RunReceipt | null>;
    command(params: Params<'run.command'>): Promise<Output<'run.command'>>;
    commandList(): Promise<Output<'run.commandList'>>;
    /** 会话技能目录（`/` 补全技能组）；未打开会话时由页面不发请求。 */
    skillCatalog(params: Params<'run.skillCatalog'>): Promise<Output<'run.skillCatalog'>>;
  };
  approval: { reply(params: Params<'approval.reply'>): Promise<void> };
  interaction: { reply(params: Params<'interaction.reply'>): Promise<void> };
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
