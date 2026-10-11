/** 技能知识来源；层级决定覆盖顺序，不授予文件或执行权限。 */
export type SkillScope = 'builtin' | 'global' | 'project';
/** 结构化技能诊断；路径及文案需由宿主安全展示，不包含正文或凭据。 */
export interface SkillDiagnostic {
  code: string;
  level: 'warn' | 'error';
  path: string;
  message: string;
  winnerPath?: string;
  loserPath?: string;
}
/** 已校验的文件内容；available=false 的执行扩展仅供诊断，不得激活。 */
export interface SkillDocument {
  name: string;
  description: string;
  body: string;
  when?: string;
  license?: string;
  compatibility?: string;
  argumentHint?: string;
  metadata?: Readonly<Record<string, string>>;
  frontmatter: Readonly<Record<string, unknown>>;
  allowedTools?: readonly string[];
  modelInvocable: boolean;
  userInvocable: boolean;
  available: boolean;
  unavailableReason?: string;
  diagnostics: readonly SkillDiagnostic[];
}
/** 宿主显式提供的扫描根；项目缺省不可信，boundary 必须是授权物理边界。 */
export interface SkillRoot {
  path: string;
  scope: SkillScope;
  kind?: 'native' | 'agents';
  trusted?: boolean;
  boundary?: string;
}
/** 可查询元数据；文件指纹来自发现快照，加载前必须重新核验。 */
export interface SkillMetadata extends Omit<SkillDocument, 'body' | 'frontmatter' | 'diagnostics'> {
  scope: SkillScope;
  sourceRoot: string;
  filePath: string;
  baseDir: string;
  contentDigest: string;
  /** 原词法发现身份；加载重核根链接，不以旧物理文件继续授权。 */
  discoveryRoot: string;
  discoveryPath: string;
  priority: number;
  disabled: boolean;
}
/** 完整快照实体；正文仅在校验通过后按需进入模型历史。 */
export interface SkillDefinition extends SkillMetadata {
  body: string;
}
/** 会话技能选项；无根即不扫描 home，disabled 名称不能由项目配置重新启用。 */
export interface SkillOptions {
  roots: readonly SkillRoot[];
  enabled?: boolean;
  disabled?: readonly string[];
}
/** 技能正文持久来源；只追踪事实，历史来源不恢复授权。 */
export interface SkillContentSource {
  version: 1;
  name: string;
  scope: SkillScope;
  filePath: string;
  baseDir: string;
  contentDigest: string;
  renderedDigest: string;
  caller: 'user' | 'model';
  runId: string;
  invocationId: string;
}
/** 本轮活动记录；pending 只收紧，committed 后才可受控读取资源。 */
export interface SkillActivation {
  definition: SkillDefinition;
  source: SkillContentSource;
  state: 'pending' | 'committed';
  allowedTools?: ReadonlySet<string>;
}
/** 统一默认限额；宿主不得另算一套目录、文件或响应预算。 */
export const SKILL_LIMITS = Object.freeze({
  fileBytes: 128 * 1024,
  frontmatterBytes: 16 * 1024,
  depth: 6,
  directories: 2000,
  entries: 20000,
  descriptionChars: 250,
  catalogTokens: 2000,
  queryTokens: 1000,
  resourceBytes: 64 * 1024,
  resourceFiles: 20,
});
