/**
 * 宿主层内部门面：仓库内宿主应用层（CLI 的 commands/local-host/入口/测试，
 * 以及桌面 agent-host 的资源服务）消费的显式导出清单。
 *
 * 约束与边界：
 * - 仅供仓库内宿主应用层经 `@kiturone/kapibala-host/internal` 消费；不进入 npm 公共导出面；
 *   桌面侧的准入范围由 scripts/check-desktop.ts 的 agent-host 门禁锚点显式限定；
 * - 显式命名导出，不用 `export *`：ESM 星号导出在多模块重导出同名符号时会静默丢弃（已踩过），
 *   新增消费符号时必须在此登记；类型重导出走 export type（isolatedModules 约束）。
 */
export { EXPLICIT_SKILL_KICKOFF, buildTodoState, projectHistory } from './history-projection.js';
export { buildSessionEvidence } from './evidence.js';
export type { SessionEvidenceInput } from './evidence.js';
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
  readMcpConfigFile,
  resolveCliMcpOptions,
} from './mcp.js';
export {
  CliModelBindings,
  PRIMARY_MODEL_ROLES,
  ROUTABLE_MODEL_ROLES,
  createModelBinding,
  parsePrimaryModelRole,
} from './model-bindings.js';
export {
  probeModelCatalog,
  type ModelCatalogProbeOptions,
  type ModelCatalogProbeResult,
  type ModelCatalogProbeStatus,
} from './model-probe.js';
export { PresentationStore } from './presentation-store.js';
export { detectProjectRoot } from './project-root.js';
export {
  CUSTOM_PROVIDER_KEY,
  CUSTOM_VENDOR_KEY_PREFIX,
  PROVIDER_METAS,
  listBuiltinProviders,
  listProviderMetas,
  providerCategory,
} from './providers.js';
export type { ProviderMeta } from './providers.js';
export {
  assembleReferenceBlocks,
  readReferenceBlocks,
} from './reference-blocks.js';
export type { ReferenceAssemblyOptions, ReferenceSelection } from './reference-blocks.js';
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
export {
  MAX_RETAINED_DELEGATIONS,
  countRetainedDelegations,
  listDelegationSessions,
  readDelegationRequestEntries,
} from './delegations.js';
export type { DelegationSessionSummary } from './delegations.js';
export { createCliSubagentResumer, createCliSubagentRunner } from './subagent-runner.js';
export { TaskObservation } from './task-observation.js';
export { registerBuiltinTools } from './tool-registration.js';
export { WATCH_RESUME_INPUT, WatchService } from './watch/service.js';
export type {
  WatchFileSystem,
  WatchServiceOptions,
  WatchStateStore,
  WatchView,
} from './watch/service.js';
export { createWatchTools } from './watch/tools.js';
export type { WatchCancelInput, WatchStartInput } from './watch/tools.js';
export { formatModelError, formatModelFailureSummary } from './ui/model-errors.js';
export { describeRuntimeError } from './ui/runtime-errors.js';
export { sanitizeUntrustedOutput } from './ui/text-safety.js';
export {
  formatMcpToolLabel,
  formatToolDetail,
  formatToolInvocation,
  formatToolResultSummary,
  resolveToolDisplay,
  sanitizeToolName,
} from './ui/tool-presentation.js';
export type { ToolDisplay } from './ui/tool-presentation.js';
export {
  getGlobalMcpConfigPath,
  getProjectMcpConfigPath,
  mutateGlobalMcpConfig,
  mutateMcpConfig,
  readMcpApprovalEntries,
  readMcpResourceSnapshot,
  resolveMcpConfigTarget,
} from './resource/mcp-config.js';
export type {
  McpApprovalEntry,
  McpConfigTarget,
  McpResourceSnapshot,
  McpServerSummary,
} from './resource/mcp-config.js';
export { readSkillsResourceSnapshot } from './resource/skills-catalog.js';
export type { SkillSummary, SkillsResourceSnapshot } from './resource/skills-catalog.js';
export {
  MCP_IMPORT_HARNESS_NAMES,
  MCP_PROVENANCE_FILE,
  importMcpServers,
  readImportedMcpProvenance,
  scanImportableMcpServers,
} from './resource/mcp-import.js';
export type {
  ImportedMcpProvenance,
  McpImportCandidate,
  McpImportConflict,
  McpImportHarness,
  McpImportOptions,
  McpImportOutcome,
  McpImportResult,
  McpImportScan,
  McpImportScope,
  McpImportSelection,
  McpImportSourceView,
} from './resource/mcp-import.js';
export {
  MCP_APPROVAL_FILE,
  McpServerApprovalStore,
  createApprovedStartAuthorizer,
  digestServerConfig,
} from './resource/mcp-approval.js';
export type {
  McpApprovalRecord,
  McpApprovalSource,
  McpApprovalStatus,
  McpApprovalTarget,
} from './resource/mcp-approval.js';
export {
  SKILL_IMPORT_HARNESS_NAMES,
  SKILL_IMPORT_LIMITS,
  SKILL_PROVENANCE_FILE,
  diffImportedSkill,
  importSkills,
  normalizeImportedSkill,
  readImportedSkillProvenance,
  scanImportableSkills,
} from './resource/skill-import.js';
export type {
  ImportedSkillProvenance,
  NormalizedImportedSkill,
  SkillImportCandidate,
  SkillImportConflict,
  SkillImportHarness,
  SkillImportOptions,
  SkillImportOutcome,
  SkillImportResult,
  SkillImportScan,
  SkillImportScope,
  SkillImportSelection,
  SkillImportSourceView,
  SkillImportStatus,
} from './resource/skill-import.js';
export {
  ExternalHarnessError,
  SAFE_NATIVE_SESSION_ID_PATTERN,
  isReservedObjectPropertyName,
  isValidNativeSessionId,
} from './external/types.js';
export type {
  ExternalApprovalDecision,
  ExternalApprovalOption,
  ExternalDriverOpenResult,
  ExternalDriverSessionHandle,
  ExternalErrorCode,
  ExternalEvent,
  ExternalHarnessDefinition,
  ExternalHarnessDriver,
  ExternalInspectResult,
  ExternalInspectStatus,
  ExternalTransportKind,
  ExternalTurnResult,
} from './external/types.js';
export {
  ENV_VAR_NAME_PATTERN,
  FORBIDDEN_EXTERNAL_ENV_KEYS,
  buildExternalLaunchEnv,
  resolveForwardedEnvSecrets,
} from './external/env.js';
export type {
  BuildExternalLaunchEnvOptions,
  ExternalLaunchEnvResult,
} from './external/env.js';
export {
  ExternalProcessSupervisor,
  getStandardCliFallbackDirs,
  resolveExternalCommand,
} from './external/process.js';
export type {
  ExternalCommandUnwrapKind,
  ExternalProcessCloseResult,
  ResolveExternalCommandOptions,
  ResolvedExternalCommand,
  SpawnExternalProcessOptions,
} from './external/process.js';
export {
  DEFAULT_EXTERNAL_MAX_FRAME_BYTES,
  NdjsonChannel,
} from './external/ndjson-channel.js';
export type {
  IncomingRpcRequestHandler,
  JsonRpcRequestId,
  NdjsonChannelOptions,
  NdjsonRequestOptions,
} from './external/ndjson-channel.js';
export { AcpStdioDriver } from './external/drivers/acp/acp-driver.js';
export type { AcpStdioDriverOptions } from './external/drivers/acp/acp-driver.js';
export { ClaudeCliDriver } from './external/drivers/claude-cli.js';
export type { ClaudeCliDriverOptions } from './external/drivers/claude-cli.js';
export { CodexAppServerDriver } from './external/drivers/codex-app-server.js';
export type { CodexAppServerDriverOptions } from './external/drivers/codex-app-server.js';
export {
  PiRpcDriver,
  buildPiLaunchArgs,
  ensurePiApprovalGuardExtension,
} from './external/drivers/pi-rpc.js';
export type { PiRpcDriverOptions } from './external/drivers/pi-rpc.js';
export {
  isAcpAuthRequiredError,
  resolveAcpFlavor,
} from './external/drivers/acp/flavors.js';
export type { AcpHarnessFlavor } from './external/drivers/acp/flavors.js';
export { ExternalTranscriptProjector } from './external/drivers/acp/projector.js';
export {
  extractAcpChunkText,
  normalizeAcpConfigSummary,
  normalizeAcpInitializeResult,
  normalizeAcpPermissionRequest,
  normalizeAcpPlanUpdate,
  normalizeAcpToolUpdate,
  normalizeAcpUsage,
} from './external/drivers/acp/tolerance.js';
export type { NormalizedAcpInitialize } from './external/drivers/acp/tolerance.js';
export {
  ACP_REGISTRY_TEMPLATES,
  BUILTIN_EXTERNAL_HARNESSES,
  findBuiltinExternalHarness,
} from './external/presets.js';
export type { AcpRegistryTemplate } from './external/presets.js';
export {
  EXTERNAL_HARNESSES_FILE_NAME,
  EXTERNAL_STATE_DIR_NAME,
  computeHarnessConfigDigest,
  getExternalHarnessesConfigPath,
  getExternalStateDirPath,
  listResolvedExternalHarnesses,
  mutateExternalHarnessesConfig,
  readExternalHarnessesConfig,
  removeCustomExternalHarness,
  resetBuiltinHarnessOverride,
  saveBuiltinHarnessOverride,
  toggleExternalHarness,
  upsertCustomExternalHarness,
} from './external/config.js';
export type {
  BuiltinHarnessOverride,
  CustomExternalHarnessInput,
  ExternalHarnessesConfigFile,
  ResolvedExternalHarnessEntry,
} from './external/config.js';
export {
  EXTERNAL_SESSIONS_FILE_NAME,
  EXTERNAL_SNAPSHOTS_DIR_NAME,
  ExternalSessionRegistry,
  MAX_EXTERNAL_ARCHIVE_BYTES,
  MAX_EXTERNAL_ARCHIVE_MESSAGES,
  MAX_RETAINED_EXTERNAL_SESSIONS,
} from './external/registry.js';
export type {
  ExternalSessionArchive,
  ExternalSessionRecord,
} from './external/registry.js';
export {
  ExternalSessionService,
  MAX_ACTIVE_EXTERNAL_PROCESSES,
} from './external/service.js';
export type { ExternalSessionServiceOptions } from './external/service.js';
