/**
 * Kapibala UI 2.0 壳内设置与代理中心（`SettingsStage`）及八大模块化设置页公共出口（017 §6.7）。
 */
export {
  type ArchivedPreviewTarget,
  ArchivePreviewModal,
  type ArchivePreviewModalProps,
} from './ArchivePreviewModal.js';
export {
  type ArchivedWorkspaceGroup,
  ArchivesPage,
  type ArchivesPageProps,
  type ManagedWorktreeSummary,
} from './ArchivesPage.js';
export {
  DiagnosticsPage,
  type DiagnosticsPageProps,
} from './DiagnosticsPage.js';
export {
  ExternalBuiltinSection,
  type ExternalBuiltinSectionProps,
} from './ExternalBuiltinSection.js';
export {
  ExternalCustomSection,
  type ExternalCustomSectionProps,
} from './ExternalCustomSection.js';
export {
  ExternalHarnessesPage,
  type ExternalHarnessesPageProps,
} from './ExternalHarnessesPage.js';
export {
  type BuiltinOverrideDraft,
  createBlankCustomHarnessDraft,
  type CustomHarnessDraft,
  describeHarnessCache,
  draftFromCustomHarness,
  draftFromTemplate,
  type ExternalHarnessItem,
  type ExternalProbeResult,
  type ExternalTemplateItem,
  HARNESS_ID_RE,
  type HarnessesCatalogOutput,
  parseArgsLines,
  parseEnvNames,
  probeStatusPresentation,
  suggestHarnessId,
  transportBadgeText,
  validateCustomHarnessDraft,
} from './external-helpers.js';
export {
  GeneralPage,
  GeneralPage as AppearancePage,
  type GeneralPageProps,
  type GeneralPageProps as AppearancePageProps,
  type PreferredShellId,
} from './GeneralPage.js';
export {
  GeneralThemeCards,
  type GeneralThemeCardsProps,
} from './GeneralThemeCards.js';
export {
  GeneralUpdatesSection,
  type GeneralUpdatesSectionProps,
} from './GeneralUpdatesSection.js';
export {
  type McpFormDraft,
  McpServerModal,
  type McpServerModalProps,
} from './McpServerModal.js';
export {
  McpServerSection,
  type McpServerSectionProps,
  SkillsSection,
  type SkillsSectionProps,
} from './McpServerSection.js';
export {
  PermissionsPage,
  type PermissionsPageProps,
} from './PermissionsPage.js';
export {
  CONTEXT_WINDOW_PRESETS,
  OUTPUT_TOKEN_PRESETS,
  ProviderModelModal,
  type ProviderModelModalProps,
} from './ProviderModelModal.js';
export {
  ProvidersPage,
  type ProvidersPageProps,
} from './ProvidersPage.js';
export {
  ProviderVendorDetail,
  type ProviderVendorDetailProps,
} from './ProviderVendorDetail.js';
export {
  McpImportPanel,
  type McpImportPanelProps,
  type McpImportResultView,
  type McpImportScanView,
  resourceImportKey,
  SkillImportPanel,
  type SkillImportPanelProps,
  type SkillImportResultView,
  type SkillImportScanView,
} from './ResourceImportPanels.js';
export {
  ResourcesPage,
  type ResourcesPageProps,
} from './ResourcesPage.js';
export {
  RoutingPage,
  type RoutingPageProps,
} from './RoutingPage.js';
export {
  SettingsStage,
  type SettingsStageProps,
} from './SettingsStage.js';
export {
  buildSettingsNavItems,
  copyTextSafe,
  createBlankCustomProfileDraft,
  describeUpdateDownloadFailure,
  formatByteSize,
  type McpCatalog,
  type McpServerView,
  normalizeSettingsTab,
  profileToDraft,
  SETTINGS_NAV_ITEMS,
  type SettingsCatalog,
  type SettingsModelProfile,
  type SettingsNavItem,
  type SkillsCatalog,
  withSettingsWatchdog,
} from './settings-helpers.js';
