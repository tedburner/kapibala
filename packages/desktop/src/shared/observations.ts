import { z } from 'zod';
const id = z.string().min(1).max(256);
const phase = z.enum(['idle', 'running', 'cancelling', 'settling']);
const result = z.enum(['completed', 'failed', 'aborted']);
const label = z.string().max(1024);
const diagnostic = z.object({ code: label, message: label }).strict();
const themePreference = z.enum(['light', 'dark', 'system']);
const localePreference = z.enum(['system', 'zh-CN', 'en']);
const resolvedLocale = z.enum(['zh-CN', 'en']);
const preferredShell = z.enum([
  'auto',
  'pwsh',
  'powershell',
  'cmd',
  'git-bash',
  'zsh',
  'bash',
  'fish',
  'sh',
]);

/** 桌面常规、外观、排版与交互确认偏好的只读快照契约（不含项目完整物理根路径，仅保留父目录摘要）。 */
export const DesktopPreferencesSchema = z
  .object({
    theme: themePreference,
    mode: z.enum(['light', 'dark']),
    locale: localePreference,
    resolvedLocale,
    typography: z
      .object({
        uiFontFamily: z.string().min(1).max(120),
        codeFontFamily: z.string().min(1).max(120),
        chatFontSize: z.number().int().min(13).max(18),
        terminalFontSize: z.number().int().min(11).max(18),
        codeLigatures: z.boolean(),
      })
      .strict(),
    general: z
      .object({
        timeFormat: z.enum(['system', 'relative', '24h', '12h']),
        sendShortcut: z.enum(['enter', 'mod-enter']),
        codeWordWrap: z.boolean(),
        desktopNotifications: z.boolean(),
        preferredShell,
      })
      .strict(),
    confirmations: z
      .object({
        deleteSession: z.boolean(),
        archiveSession: z.boolean(),
        closeActiveTerminal: z.boolean(),
      })
      .strict(),
    recent: z.array(z.object({ id, name: z.string(), parent: z.string() }).strict()).max(20),
  })
  .strict();

/** 主进程向渲染层同步的桌面偏好快照类型（`preferences.read` 返回值与 `preferences.changed` 通知共用）。 */
export type DesktopPreferences = z.infer<typeof DesktopPreferencesSchema>;
/** 后台摘要只含最多八个已打开句柄的执行事实，不携带正文、参数、凭证或观察内容。 */
export const RuntimeSnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    items: z
      .array(
        z
          .object({
            workspaceId: id,
            sessionId: id,
            conversationId: id,
            runId: id.optional(),
            phase,
            result: result.optional(),
            approvals: z.number().int().nonnegative(),
            cleanup: z.enum(['none', 'closing', 'failed']),
            /** 仍在监视中的条件数量；缺省（旧宿主）按 0 处理，徽标不出现。 */
            watches: z.number().int().nonnegative().default(0),
            startedAt: z.number().optional(),
            settledAt: z.number().optional(),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
/** 摘要 revision 可以因合并跳号，仅能整体替换同一业务订阅中的旧快照。 */
export type RuntimeSnapshot = z.infer<typeof RuntimeSnapshotSchema>;
/** 观察字段与共享宿主投影一致，全部只读、有界；不存在执行、收集或服务启动入口。 */
export const InspectionSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    status: z
      .object({
        phase,
        model: label.optional(),
        permissionMode: label.optional(),
        gitBranch: label.optional(),
        contextUsage: z
          .object({
            usedTokens: z.number().optional(),
            limitTokens: z.number(),
            estimatedUsage: z.boolean().optional(),
            estimatedLimit: z.boolean(),
            percent: z.number().optional(),
          })
          .strict()
          .optional(),
        runUsage: z
          .object({
            promptTokens: z.number().optional(),
            completionTokens: z.number().optional(),
            totalTokens: z.number().optional(),
          })
          .strict()
          .optional(),
        tasks: z
          .array(
            z
              .object({
                agentId: label,
                sessionId: label.optional(),
                description: label,
                role: label,
                status: z.enum([
                  'preparing',
                  'accepted',
                  'running',
                  'waiting_children',
                  'cancelling',
                  'completed',
                  'failed',
                  'cancelled',
                  'interrupted',
                ]),
                originBranchId: label,
                isOtherBranch: z.boolean(),
                branchHint: label.optional(),
                delivery: z.enum(['not-ready', 'pending', 'collected', 'unknown']),
                summary: label.optional(),
                error: label.optional(),
              })
              .strict(),
          )
          .max(32)
          .optional(),
      })
      .strict(),
    branchDrift: z
      .object({ createdBranch: label.optional(), currentBranch: label.optional() })
      .strict()
      .optional(),
    skills: z
      .object({
        enabled: z.boolean(),
        entries: z
          .array(
            z
              .object({
                name: label,
                description: label,
                scope: label,
                available: z.boolean(),
                active: label.optional(),
                reason: label.optional(),
              })
              .strict(),
          )
          .max(32),
        diagnostics: z.array(diagnostic).max(32),
        omitted: z.number().int().nonnegative(),
        diagnosticsOmitted: z.number().int().nonnegative(),
      })
      .strict(),
    mcp: z
      .object({
        enabled: z.boolean(),
        servers: z
          .array(
            z
              .object({
                name: label,
                state: label,
                toolsState: label.optional(),
                promptsState: label.optional(),
                toolCount: z.number().optional(),
                promptCount: z.number().optional(),
                error: label.optional(),
              })
              .strict(),
          )
          .max(32),
        diagnostics: z.array(diagnostic).max(32),
        omitted: z.number().int().nonnegative(),
        diagnosticsOmitted: z.number().int().nonnegative(),
      })
      .strict(),
    tasksOmitted: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();
/** 页面按 revision 保留较新观察，不能用观察身份充当资源授权。 */
export type Inspection = z.infer<typeof InspectionSchema>;
