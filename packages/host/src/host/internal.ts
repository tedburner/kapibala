/**
 * 宿主层内部门面：CLI 应用层（commands/local-host/入口/测试）消费的显式导出清单。
 *
 * 约束与边界：
 * - 仅供仓库内 CLI 应用层经 `@kiturone/kapibala-host/internal` 消费；不进入 npm 公共导出面；
 * - 显式命名导出，不用 `export *`：ESM 星号导出在多模块重导出同名符号时会静默丢弃（已踩过），
 *   新增消费符号时必须在此登记；类型重导出走 export type（isolatedModules 约束）。
 */
export { projectHistory } from './history-projection.js';
export {
  createManagedSession,
  createManagedSessionResources,
  loadCredentialSecrets,
} from './managed-session.js';
export {
  attachMcpToSession,
  bindSessionMcpPlugin,
  createCliServerStartAuthorizer,
  getSessionMcpPlugin,
  resolveCliMcpOptions,
} from './mcp.js';
export {
  CliModelBindings,
  PRIMARY_MODEL_ROLES,
  ROUTABLE_MODEL_ROLES,
  createModelBinding,
  parsePrimaryModelRole,
} from './model-bindings.js';
export { PresentationStore } from './presentation-store.js';
export { detectProjectRoot } from './project-root.js';
export { PROVIDER_METAS, listBuiltinProviders, providerCategory } from './providers.js';
export type { ProviderMeta } from './providers.js';
// local-host/redaction.ts 兼容 shim 经 `export *` 间接消费本模块全量脱敏面，必须整体登记。
export {
  StreamingRedactor,
  containsSensitiveMarker,
  redactCommonSecrets,
  redactKnownSecrets,
  redactText,
  sanitizeDisplayText,
} from './redaction.js';
export { SessionPresentation, presentationScope } from './session-presentation.js';
export {
  API_KEY_ENV_NONE,
  BUILTIN_CATALOG_VERSION,
  BUILTIN_PROFILES,
  DEFAULT_MODEL_ID,
  createUserSettingsSkeleton,
  credentialGroup,
  describeCredentialGroup,
  detectProviderFamily,
  ensureProfile,
  getGlobalSettingsPath,
  isProjectTrusted,
  loadGlobalSettingsForWrite,
  loadSettings,
  migrateBuiltinCatalog,
  migrateGlobalSettingsCatalog,
  mutateGlobalSettings,
  normalizeGroupApiKeys,
  readRawGlobalSettings,
  resolveApiKey,
  resolveApiKeyDetailed,
  resolveBaseURL,
  saveGlobalSettings,
  trustProject,
  updateProfileApiKey,
} from './settings.js';
export type { LoadSettingsOptions, LoadedSettings, UserSettings } from './settings.js';
export { getCliSkillOptions, hasProjectSkills } from './skills.js';
export { GitStatusCache, projectStatusFacts } from './status-facts.js';
export { createCliSubagentRunner } from './subagent-runner.js';
export { TaskObservation } from './task-observation.js';
export { registerBuiltinTools } from './tool-registration.js';
export { formatModelError, formatModelFailureSummary } from './ui/model-errors.js';
export { describeRuntimeError } from './ui/runtime-errors.js';
export { sanitizeUntrustedOutput } from './ui/text-safety.js';
export {
  formatToolDetail,
  formatToolInvocation,
  formatToolResultSummary,
  sanitizeToolName,
} from './ui/tool-presentation.js';
