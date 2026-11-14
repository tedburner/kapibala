/** Node 宿主窄入口；不重导出 CLI 启动、输入协调器、终端渲染或原始资源句柄。 */
export {
  createManagedSession,
  type ManagedSessionOptions,
  type ManagedSessionConfiguration,
  type ManagedHostSession,
} from './managed-session.js';
export { PresentationStore } from './presentation-store.js';
export { SessionPresentation, presentationScope } from './session-presentation.js';
export { projectHistory, displayMessageId, displayBlockId } from './history-projection.js';
export { projectStatusFacts, GitStatusCache, type GitStatusCacheOptions } from './status-facts.js';
export { TaskObservation, type TaskObservationScope } from './task-observation.js';
export { redactText, redactCommonSecrets, StreamingRedactor } from './redaction.js';
export {
  redactPresentationState,
  redactViewMessage,
  redactViewBlock,
  redactPresentationChange,
  type PublicTextRedactor,
} from './public-projection.js';
export {
  type UserSettings,
  type LoadSettingsOptions,
  BUILTIN_PROFILES,
  DEFAULT_MODEL_ID,
  API_KEY_ENV_NONE,
  resolveBaseURL,
  loadSettings,
  loadGlobalSettingsForWrite,
  mutateGlobalSettings,
  getGlobalSettingsPath,
  isProjectTrusted,
  trustProject,
  credentialGroup,
  describeCredentialGroup,
  resolveApiKeyDetailed,
  ensureProfile,
  updateProfileApiKey,
} from '../settings.js';
export {
  PROVIDER_METAS,
  CUSTOM_PROVIDER_KEY,
  providerCategory,
  type ProviderMeta,
} from '../providers.js';

export type { ManagedInspection } from './inspection.js';
