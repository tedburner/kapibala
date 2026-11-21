import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  SKILL_LIMITS,
  type SkillDiagnostic,
  type SkillDocument,
  isSkillName,
  parseSkillDocument,
  readBoundedSkillText,
  scanSkillRoot,
  skillDigest,
} from '@kiturone/kapibala';
import { type UserSettings, mutateGlobalSettings } from '../settings.js';

/**
 * 跨 Harness 技能导入服务。
 *
 * 定位与边界：
 * - 外部 Harness 目录**只作为一次性导入来源**：打开导入界面时扫描一次，不进运行期发现链、
 *   不参与优先级/预算，也不建立 watch 或自动同步；
 * - 导入是显式 mutation：预览 → 隔离写入 → 原子替换 → 写溯源；整个过程**不执行来源中的任何代码**；
 * - 目标只允许自有目录（全局 `~/.kapibala/skills`，项目 `<project>/.kapibala/skills`），
 *   项目作用域还要求项目已信任；
 * - 落盘文件一律经 `node:fs/promises` 写入，临时目录与备份目录都放在技能根之外，
 *   避免半成品或备份被技能发现链扫到。
 */

/** 可导入的外部 Harness 名单；只承诺这四种可验证格式，未知名称明确失败而不是猜测。 */
export const SKILL_IMPORT_HARNESS_NAMES = ['claude-code', 'codex', 'cursor', 'opencode'] as const;

/** 可导入的外部 Harness；由名单派生，新增来源必须同时补目录表。 */
export type SkillImportHarness = (typeof SKILL_IMPORT_HARNESS_NAMES)[number];

/** 目标作用域；全局为默认，项目级需显式切换且在未信任项目上直接拒绝。 */
export type SkillImportScope = 'global' | 'project';

/** 导入结果固定五桶之一；单桶失败不中断其余候选。 */
export type SkillImportStatus =
  | 'imported'
  | 'unchanged'
  | 'skipped-conflict'
  | 'skipped-limit'
  | 'failed';

/** 目标根中同名技能的冲突状态；导入时据此决定跳过或要求显式覆盖。 */
export type SkillImportConflict = 'none' | 'exists-enabled' | 'exists-disabled';

/** 溯源文件固定名；隐藏文件不参与资源列表，也不计入落地摘要。 */
export const SKILL_PROVENANCE_FILE = '.imported-from.json';

/** 单来源二次上限：候选数量与总字节；超出按目录名排序截断并标记 partial。 */
export const SKILL_IMPORT_LIMITS = Object.freeze({ candidates: 200, bytes: 64 * 1024 * 1024 });

/** 来源登记；项目目录缺省不可用，只有调用方明确提供 projectRoot 时才参与扫描。 */
const HARNESS_SOURCES: ReadonlyArray<{
  harness: SkillImportHarness;
  label: string;
  globalDirs: readonly string[];
  projectDirs: readonly string[];
}> = [
  {
    harness: 'claude-code',
    label: 'Claude Code',
    globalDirs: ['.claude/skills'],
    projectDirs: ['.claude/skills'],
  },
  {
    harness: 'codex',
    label: 'Codex',
    globalDirs: ['.codex/skills'],
    projectDirs: ['.codex/skills'],
  },
  {
    harness: 'cursor',
    label: 'Cursor',
    globalDirs: ['.cursor/skills'],
    projectDirs: ['.cursor/skills'],
  },
  {
    harness: 'opencode',
    label: 'opencode',
    globalDirs: ['.config/opencode/skills'],
    projectDirs: ['.opencode/skills'],
  },
];

/** 溯源文件内容；`sourceRef` 是来源身份，`installedDigest` 是落地副本摘要，两者刻意分离。 */
export interface ImportedSkillProvenance {
  version: 1;
  harness: string;
  sourceRef: string;
  installedAt: string;
  installedDigest: string;
  strippedFields: string[];
}

/** 单个导入候选；只含发现事实与预览结论，不含正文（正文一律由宿主按需读取）。 */
export interface SkillImportCandidate {
  harness: SkillImportHarness;
  /** 最终写入名（frontmatter `name`，缺省目录名）；也决定目标目录与冲突判定。 */
  name: string;
  directoryName: string;
  description: string;
  /** 来源身份（绝对路径）；执行导入时必须与预览记录一致，防 TOCTOU。 */
  sourceRef: string;
  origin: SkillImportScope;
  files: number;
  bytes: number;
  hasScripts: boolean;
  /** 归一阶段会被剥离的字段名；空数组表示原样拷贝。 */
  strippedFields: string[];
  conflict: SkillImportConflict;
  unpublished?: string;
  previouslyImported?: {
    installedAt: string;
    installedDigest: string;
    /** 来源侧（归一后）摘要与 `installedDigest` 相同：无需重新导入。 */
    sourceUnchanged: boolean;
    /** 来源与目标副本之间的差异文件（相对路径）；空数组表示内容一致。 */
    changedFiles: string[];
  };
}

/** 每个来源的扫描结论；`partial` 表示触达二次上限被截断。 */
export interface SkillImportSourceView {
  harness: SkillImportHarness;
  label: string;
  roots: Array<{ path: string; scope: SkillImportScope; readable: boolean }>;
  candidates: number;
  partial: boolean;
  truncated: number;
}

/** 预览结果；`candidates` 按来源分组顺序排列，供 CLI 表格与桌面抽屉共用。 */
export interface SkillImportScan {
  sources: SkillImportSourceView[];
  candidates: SkillImportCandidate[];
  diagnostics: SkillDiagnostic[];
  partial: boolean;
}

/** 导入选择项：只传来源身份，不传正文（与跨会话引用同一条信任原则）。 */
export interface SkillImportSelection {
  harness: string;
  name: string;
  expectedSourceRef: string;
}

/** 导入选项；`items` 为空数组表示全部候选。 */
export interface SkillImportOptions {
  homeDir: string;
  projectRoot: string;
  projectTrusted: boolean;
  settings: UserSettings;
  scope: SkillImportScope;
  items: readonly SkillImportSelection[];
  overwrite?: boolean;
  signal?: AbortSignal;
}

/** 单项导入结果；固定归入五桶之一，供两种宿主用同一分桶渲染。 */
export interface SkillImportOutcome {
  harness: string;
  name: string;
  status: SkillImportStatus;
  sourceRef?: string;
  targetPath?: string;
  message?: string;
  strippedFields?: string[];
}

/** 批量导入汇总；`skippedLimit` 含来源扫描截断项，不静默丢失。 */
export interface SkillImportResult {
  scope: SkillImportScope;
  items: SkillImportOutcome[];
  imported: number;
  unchanged: number;
  skippedConflict: number;
  skippedLimit: number;
  failed: number;
  truncated: number;
  diagnostics: SkillDiagnostic[];
}

/** frontmatter 归一结果；`strippedFields` 同时写入溯源文件，便于回答「为什么与来源不同」。 */
export interface NormalizedImportedSkill {
  content: string;
  strippedFields: string[];
  diagnostics: SkillDiagnostic[];
  document: SkillDocument;
}

/** Kapibala 保留的 frontmatter 字段；其余字段（含执行扩展）在导入时剥离并诊断。 */
const KNOWN_FIELDS = [
  'name',
  'description',
  'license',
  'compatibility',
  'when',
  'when_to_use',
  'argument-hint',
  'metadata',
  'allowed-tools',
  'disable-model-invocation',
  'user-invocable',
] as const;

const KNOWN_FIELD_SET = new Set<string>(KNOWN_FIELDS);

/** 动态 shell 检测与 core 解析器保持同一表达式；导入不执行、也不静默改写正文。 */
const DYNAMIC_SHELL = /!\x60[^\x60]+\x60|^\s*\x60{3}!/m;

/**
 * 来源身份归一：统一用 native realpath 展开符号链接与 Windows 8.3 短名。
 *
 * 为什么必须 native：JS 实现保留 8.3 短名、且 macOS 上 `/var` 与 `/private/var` 会得到不同字面量，
 * 预览记录与导入校验若按未归一形式比较，会出现「同一目录被判为已变化」的假 TOCTOU。
 * 目录已不存在时退回 `path.resolve`，保证只影响身份字符串、不阻断后续失败诊断。
 */
function normalizeSourceIdentity(target: string): string {
  try {
    return realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * 把源技能目录或整批来源扫描成可导入候选。
 *
 * 保证与边界：
 * - 目录不存在直接跳过（不产生告警）；存在但无法解析才产生 `import_source_unreadable`；
 * - 只认包含 `SKILL.md` 的技能包，复用 core 的有界发现上限（深度/目录/条目/单文件）；
 * - 单来源超过 200 候选或 64 MiB 时按目录名排序截断，返回 `partial` 与截断计数；
 * - 不做任何写入，也不读取技能正文到模型可见面。
 */
export async function scanImportableSkills(options: {
  homeDir: string;
  projectRoot: string;
  projectTrusted: boolean;
  settings: UserSettings;
  signal?: AbortSignal;
}): Promise<SkillImportScan> {
  const diagnostics: SkillDiagnostic[] = [];
  const candidates: SkillImportCandidate[] = [];
  const sources: SkillImportSourceView[] = [];
  const targetRoots = {
    global: path.join(options.homeDir, '.kapibala', 'skills'),
    project: path.join(options.projectRoot, '.kapibala', 'skills'),
  };
  const disabled = new Set(options.settings.skills?.disabled ?? []);
  const seen = new Set<string>();
  let partial = false;
  for (const source of HARNESS_SOURCES) {
    const roots: SkillImportSourceView['roots'] = [];
    let candidateCount = 0;
    let truncated = 0;
    let sourcePartial = false;
    for (const [scope, dirs] of [
      ['global', source.globalDirs],
      ['project', source.projectDirs],
    ] as const) {
      // 未信任项目不扫描其外部 Harness 目录：避免在用户确认信任前读取仓库内容。
      if (scope === 'project' && !options.projectTrusted) continue;
      for (const dir of dirs) {
        options.signal?.throwIfAborted();
        const rootPath =
          scope === 'global'
            ? path.join(options.homeDir, dir)
            : path.join(options.projectRoot, dir);
        const readability = await checkSourceRoot(rootPath);
        roots.push({ path: rootPath, scope, readable: readability.readable });
        if (!readability.exists) continue;
        if (!readability.readable) {
          diagnostics.push({
            code: 'import_source_unreadable',
            level: 'warn',
            path: rootPath,
            message: readability.message ?? '导入来源目录无法读取',
          });
          continue;
        }
        const scan = await scanSkillRoot(
          { path: rootPath, scope: 'global', trusted: true, boundary: rootPath },
          options.signal,
        );
        diagnostics.push(...scan.diagnostics);
        for (const skill of scan.skills) {
          options.signal?.throwIfAborted();
          const directoryName = path.basename(path.dirname(skill.filePath));
          const targetRoot = targetRoots[scope];
          const key = `${source.harness}:${skill.name}`;
          if (seen.has(key)) {
            diagnostics.push({
              code: 'import_duplicate_name',
              level: 'warn',
              path: skill.filePath,
              message: `同一来源存在同名技能，已忽略后出现的副本：${skill.name}`,
            });
            continue;
          }
          if (candidateCount >= SKILL_IMPORT_LIMITS.candidates) {
            truncated++;
            sourcePartial = true;
            continue;
          }
          const measured = await measurePackage(path.dirname(skill.filePath), options.signal);
          if (measured.overflow) {
            truncated++;
            sourcePartial = true;
            diagnostics.push({
              code: 'import_candidate_limit',
              level: 'warn',
              path: path.dirname(skill.filePath),
              message: `候选超过 ${SKILL_IMPORT_LIMITS.bytes} 字节上限，已截断`,
            });
            continue;
          }
          seen.add(key);
          candidateCount++;
          const targetDir = path.join(targetRoot, skill.name);
          const conflict = (await pathExists(targetDir))
            ? disabled.has(skill.name)
              ? 'exists-disabled'
              : 'exists-enabled'
            : 'none';
          const normalized = normalizeImportedSkill(
            await readBoundedSkillText(skill.filePath, SKILL_LIMITS.fileBytes, options.signal),
            skill.filePath,
          );
          diagnostics.push(...normalized.diagnostics);
          const sourceRef = normalizeSourceIdentity(path.dirname(skill.filePath));
          const previous = await readImportedSkillProvenance(targetDir);
          const previouslyImported =
            previous && skill.available
              ? await describeReimport(
                  targetDir,
                  sourceRef,
                  previous,
                  normalized,
                  options.signal,
                  diagnostics,
                )
              : undefined;
          candidates.push({
            harness: source.harness,
            name: skill.name,
            directoryName,
            description: skill.description,
            sourceRef,
            origin: scope,
            files: measured.files,
            bytes: measured.bytes,
            hasScripts: measured.hasScripts,
            strippedFields: normalized.strippedFields,
            conflict,
            ...(skill.unavailableReason ? { unpublished: skill.unavailableReason } : {}),
            ...(previouslyImported ? { previouslyImported } : {}),
          });
        }
      }
    }
    sources.push({
      harness: source.harness,
      label: source.label,
      roots,
      candidates: candidateCount,
      partial: sourcePartial,
      truncated,
    });
    if (sourcePartial) partial = true;
  }
  return { sources, candidates, diagnostics, partial };
}

/**
 * 执行导入：重新扫描来源 → 校验来源身份 → 归一 → 隔离写入 → 原子替换 → 写溯源。
 *
 * 关键保证：
 * - 项目作用域在未信任项目上整批拒绝，不进入确认流程；
 * - `expectedSourceRef` 与本次扫描不一致即 `failed`（预览的是 A、导入的不能是 B）；
 * - 默认跳过冲突、不覆盖已有技能；`overwrite` 时先把旧目录移出技能根再替换，失败可回滚；
 * - 目标内容摘要与来源相同返回 `unchanged`，不写盘；
 * - 导入过程不执行来源代码、不创建工作树；符号链接越界直接跳过。
 */
export async function importSkills(options: SkillImportOptions): Promise<SkillImportResult> {
  if (options.scope === 'project' && !options.projectTrusted)
    throw new Error('项目尚未信任，不能写入项目级技能目录');
  const scan = await scanImportableSkills(options);
  const diagnostics = [...scan.diagnostics];
  const items: SkillImportOutcome[] = [];
  const kapibalaRoot =
    options.scope === 'global'
      ? path.join(options.homeDir, '.kapibala')
      : path.join(options.projectRoot, '.kapibala');
  const targetRoot = path.join(kapibalaRoot, 'skills');
  const tempRoot = path.join(kapibalaRoot, '.import-tmp');
  const backupRoot = path.join(kapibalaRoot, '.skill-backups');
  await fs.mkdir(targetRoot, { recursive: true });
  const selected: Array<SkillImportCandidate | SkillImportSelection> = options.items.length
    ? [...options.items]
    : scan.candidates;
  const succeeded: string[] = [];
  for (const entry of selected) {
    options.signal?.throwIfAborted();
    let candidate: SkillImportCandidate | undefined;
    let expectedSourceRef: string | undefined;
    if ('sourceRef' in entry) {
      candidate = entry;
    } else {
      expectedSourceRef = entry.expectedSourceRef;
      candidate = scan.candidates.find(
        (item) => item.harness === entry.harness && item.name === entry.name,
      );
    }
    if (!candidate) {
      const wanted = entry as SkillImportSelection;
      const truncatedSource = scan.sources.find((source) => source.harness === wanted.harness);
      items.push({
        harness: wanted.harness,
        name: wanted.name,
        status: truncatedSource?.partial ? 'skipped-limit' : 'failed',
        message: truncatedSource?.partial
          ? '来源候选超过扫描上限，请缩小来源目录或先清理'
          : '来源扫描中未找到该候选，请重新扫描',
      });
      continue;
    }
    if (expectedSourceRef !== undefined && expectedSourceRef !== candidate.sourceRef) {
      items.push({
        harness: candidate.harness,
        name: candidate.name,
        status: 'failed',
        sourceRef: candidate.sourceRef,
        message: '来源在预览后发生变化，请重新扫描后再导入',
      });
      continue;
    }
    const outcome = await importCandidate({
      candidate,
      targetRoot,
      tempRoot,
      backupRoot,
      overwrite: options.overwrite === true,
      signal: options.signal,
    });
    if (outcome.item.status === 'imported') succeeded.push(candidate.name);
    diagnostics.push(...(outcome.diagnostics ?? []));
    items.push(outcome.item);
  }
  if (succeeded.length) enableImportedSkills(options, succeeded, diagnostics);
  for (const source of scan.sources) {
    if (!source.truncated) continue;
    diagnostics.push({
      code: 'import_source_truncated',
      level: 'warn',
      path: source.roots[0]?.path ?? source.harness,
      message: `${source.label} 超过导出上限，已截断 ${source.truncated} 个候选`,
    });
  }
  return {
    scope: options.scope,
    items,
    imported: items.filter((item) => item.status === 'imported').length,
    unchanged: items.filter((item) => item.status === 'unchanged').length,
    skippedConflict: items.filter((item) => item.status === 'skipped-conflict').length,
    skippedLimit:
      items.filter((item) => item.status === 'skipped-limit').length +
      scan.sources.reduce((sum, source) => sum + source.truncated, 0),
    failed: items.filter((item) => item.status === 'failed').length,
    truncated: scan.sources.reduce((sum, source) => sum + source.truncated, 0),
    diagnostics,
  };
}

/** 读取目标技能的溯源记录；文件缺失、格式非法或版本不符一律返回 undefined，不猜测。 */
export async function readImportedSkillProvenance(
  directory: string,
): Promise<ImportedSkillProvenance | undefined> {
  try {
    const raw = await fs.readFile(path.join(directory, SKILL_PROVENANCE_FILE), 'utf8');
    const value = JSON.parse(raw) as Partial<ImportedSkillProvenance>;
    if (
      value.version !== 1 ||
      typeof value.harness !== 'string' ||
      typeof value.sourceRef !== 'string' ||
      typeof value.installedAt !== 'string' ||
      typeof value.installedDigest !== 'string' ||
      !Array.isArray(value.strippedFields) ||
      value.strippedFields.some((field) => typeof field !== 'string')
    )
      return undefined;
    return {
      version: 1,
      harness: value.harness,
      sourceRef: value.sourceRef,
      installedAt: value.installedAt,
      installedDigest: value.installedDigest,
      strippedFields: [...value.strippedFields],
    };
  } catch {
    return undefined;
  }
}

/** 对比目标副本与来源文件的差异（相对路径，按 code point 排序）；忽略溯源文件。 */
export async function diffImportedSkill(
  targetDir: string,
  sourceDir: string,
  signal?: AbortSignal,
): Promise<{
  changedFiles: string[];
  targetDigest: string;
  sourceDigest: string;
  diagnostics: SkillDiagnostic[];
}> {
  const diagnostics: SkillDiagnostic[] = [];
  const target = await collectPackageDigests(targetDir, signal, diagnostics);
  const source = await collectPackageDigests(sourceDir, signal, diagnostics);
  const names = new Set([...target.keys(), ...source.keys()]);
  const changedFiles = [...names]
    .filter((name) => target.get(name) !== source.get(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    changedFiles,
    targetDigest: digestFromFiles(target),
    sourceDigest: digestFromFiles(source),
    diagnostics,
  };
}

/**
 * 将来源 frontmatter 归一到 Kapibala 支持字段。
 *
 * 边界：
 * - 没有需要剥离的字段时**原样返回**原内容，保持来源文件的字节与格式；
 * - 需要剥离时按固定顺序重新序列化，保留字段值语义，未知字段与执行扩展一律移除并诊断；
 * - `allowed-tools` 仅当全部条目是纯工具名时保留；出现参数模式或奇怪字符整条丢弃；
 * - 正文中的动态 shell 不自动改写（改写有破坏语义风险），只记诊断，落盘后仍按既有不可用规则处理。
 */
export function normalizeImportedSkill(content: string, filePath: string): NormalizedImportedSkill {
  const document = parseSkillDocument(content, filePath);
  const diagnostics: SkillDiagnostic[] = [];
  const stripped: string[] = [];
  const values = document.frontmatter;
  for (const key of Object.keys(values)) {
    if (!KNOWN_FIELD_SET.has(key)) stripped.push(key);
  }
  const allowedToolsKept = document.allowedTools?.length
    ? document.allowedTools.every((tool) => /^[a-zA-Z0-9_-]+$/.test(tool))
    : true;
  if (!allowedToolsKept) {
    stripped.push('allowed-tools');
    diagnostics.push({
      code: 'SKILL_IMPORT_TOOLS_DROPPED',
      level: 'warn',
      path: filePath,
      message: 'allowed-tools 含参数模式或非法工具名，导入时整条丢弃',
    });
  }
  if (DYNAMIC_SHELL.test(document.body)) {
    diagnostics.push({
      code: 'SKILL_IMPORT_DYNAMIC_SHELL',
      level: 'warn',
      path: filePath,
      message: '正文包含动态 shell 表达式；导入不改写正文，落地后仍按不可用处理',
    });
  }
  if (!stripped.length) return { content, strippedFields: [], diagnostics, document };
  diagnostics.unshift({
    code: 'SKILL_IMPORT_FIELD_STRIPPED',
    level: 'warn',
    path: filePath,
    message: `导入时剥离 Kapibala 不支持的字段：${stripped.join(', ')}`,
  });
  const header: string[] = [];
  for (const key of KNOWN_FIELDS) {
    if (key === 'allowed-tools' && !allowedToolsKept) continue;
    const value = values[key];
    if (value === undefined) continue;
    header.push(...serializeField(key, value));
  }
  return {
    content: `---\n${header.join('\n')}\n---\n${document.body}`,
    strippedFields: stripped,
    diagnostics,
    document,
  };
}

interface ImportCandidateContext {
  candidate: SkillImportCandidate;
  targetRoot: string;
  tempRoot: string;
  backupRoot: string;
  overwrite: boolean;
  signal?: AbortSignal;
}

/** 单项导入：五桶结果统一在这里产出；失败不抛出，以免中断整批。 */
async function importCandidate(context: ImportCandidateContext): Promise<{
  item: SkillImportOutcome;
  diagnostics?: SkillDiagnostic[];
}> {
  const { candidate, targetRoot, tempRoot, backupRoot, signal } = context;
  const targetDir = path.join(targetRoot, candidate.name);
  const base = { harness: candidate.harness, name: candidate.name, sourceRef: candidate.sourceRef };
  let normalized: NormalizedImportedSkill;
  try {
    normalized = normalizeImportedSkill(
      await readBoundedSkillText(
        path.join(candidate.sourceRef, 'SKILL.md'),
        SKILL_LIMITS.fileBytes,
        signal,
      ),
      path.join(candidate.sourceRef, 'SKILL.md'),
    );
    // 归一后名字必须仍与预览一致：曾出现过改 frontmatter 名绕过冲突检查的情况。
    if (normalized.document.name !== candidate.name || !isSkillName(candidate.name))
      throw new Error('导入后技能名与预览不一致');
  } catch (error) {
    return {
      item: { ...base, status: 'failed', message: errorMessage(error) },
    };
  }
  const tempDir = path.join(tempRoot, `${candidate.name}-${randomUUID()}`);
  try {
    await fs.mkdir(tempDir, { recursive: true });
    const copied = await copyPackage(candidate.sourceRef, tempDir, normalized.content, signal);
    const installed = await collectPackageDigests(tempDir, signal);
    const installedDigest = `sha256:${digestFromFiles(installed)}`;
    const targetExists = await pathExists(targetDir);
    const existing = targetExists
      ? await collectPackageDigests(targetDir, signal).catch(() => undefined)
      : undefined;
    if (targetExists && existing && digestFromFiles(existing) === digestFromFiles(installed))
      return {
        item: { ...base, status: 'unchanged', targetPath: targetDir },
      };
    if (targetExists && !context.overwrite)
      return {
        item: {
          ...base,
          status: 'skipped-conflict',
          targetPath: targetDir,
          message: '目标已存在同名技能；如需替换请显式选择覆盖',
        },
      };
    const provenance: ImportedSkillProvenance = {
      version: 1,
      harness: candidate.harness,
      sourceRef: candidate.sourceRef,
      installedAt: new Date().toISOString(),
      installedDigest,
      strippedFields: [...candidate.strippedFields],
    };
    await fs.writeFile(
      path.join(tempDir, SKILL_PROVENANCE_FILE),
      `${JSON.stringify(provenance, null, 2)}\n`,
      'utf8',
    );
    const backupPath = await replaceTarget({
      targetDir,
      tempDir,
      backupRoot,
      name: candidate.name,
      overwrite: context.overwrite && targetExists,
    });
    return {
      item: {
        ...base,
        status: 'imported',
        targetPath: targetDir,
        ...(candidate.strippedFields.length
          ? { strippedFields: [...candidate.strippedFields] }
          : {}),
        ...(backupPath ? { message: `旧副本已备份到 ${backupPath}` } : {}),
      },
      diagnostics: copied.diagnostics,
    };
  } catch (error) {
    return {
      item: { ...base, status: 'failed', targetPath: targetDir, message: errorMessage(error) },
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 原子替换目标目录：覆盖时先移走旧副本；第二步失败把旧副本移回，不留下切换中间态。 */
async function replaceTarget(options: {
  targetDir: string;
  tempDir: string;
  backupRoot: string;
  name: string;
  overwrite: boolean;
}): Promise<string | undefined> {
  if (!options.overwrite) {
    await fs.rename(options.tempDir, options.targetDir);
    return undefined;
  }
  await fs.mkdir(options.backupRoot, { recursive: true });
  const backupPath = path.join(
    options.backupRoot,
    `${options.name}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
  await fs.rename(options.targetDir, backupPath);
  try {
    await fs.rename(options.tempDir, options.targetDir);
  } catch (error) {
    await fs.rename(backupPath, options.targetDir).catch(() => undefined);
    throw error;
  }
  return backupPath;
}

/**
 * 复制技能包到临时目录；SKILL.md 用归一后内容，其余条目按物理字节复制。
 *
 * 复制期防线（TOCTOU）：扫描期测量与复制之间存在时间窗，来源条目可能被替换或膨胀，因此
 * - 每个来源条目统一 `fs.realpath` 后校验仍在来源根物理边界内，越界（含中途换成的符号链接）跳过并诊断；
 * - 单条目 `stat.size` 超过 `SKILL_IMPORT_LIMITS.bytes`（单文件最多不能独占整包预算）或
 *   累计字节超过整包 64 MiB 上限时直接抛错，由调用方按失败桶回滚临时目录，不留半成品。
 */
async function copyPackage(
  sourceDir: string,
  targetDir: string,
  normalizedSkill: string,
  signal?: AbortSignal,
): Promise<{ diagnostics: SkillDiagnostic[] }> {
  const diagnostics: SkillDiagnostic[] = [];
  // 来源根必须按物理身份判定边界：符号链接来源根（dotfiles 管理器常见）与 macOS 的 /var 别名
  // 都会让词法路径与物理路径失配，先解析一次再比较。
  const physicalRoot = await fs.realpath(sourceDir).catch(() => undefined);
  if (!physicalRoot) throw new Error(`来源包目录无法解析，已中止导入：${sourceDir}`);
  const visited = new Set<string>();
  let totalBytes = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if (depth > SKILL_LIMITS.depth) {
      diagnostics.push({
        code: 'import_depth_skipped',
        level: 'warn',
        path: path.join(physicalRoot, relative),
        message: '目录深度超过导入上限，已跳过更深层内容',
      });
      return;
    }
    const from = path.join(physicalRoot, relative);
    const physical = await fs.realpath(from).catch(() => undefined);
    if (!physical || visited.has(physical)) return;
    if (!isInside(physicalRoot, physical)) return;
    visited.add(physical);
    const entries = await fs.opendir(from);
    for await (const entry of entries) {
      const next = relative ? path.join(relative, entry.name) : entry.name;
      const destination = path.join(targetDir, next);
      // 复制瞬间条目可能已被换成符号链接（TOCTOU）：一律按物理位置复核，不信任词法路径。
      const real = await fs.realpath(path.join(physicalRoot, next)).catch(() => undefined);
      if (!real || !isInside(physicalRoot, real)) {
        diagnostics.push({
          code: 'import_symlink_skipped',
          level: 'warn',
          path: path.join(physicalRoot, next),
          message: '符号链接指向来源包之外，已跳过',
        });
        continue;
      }
      const stat = await fs.stat(real);
      if (stat.isDirectory()) {
        await fs.mkdir(destination, { recursive: true });
        await walk(next, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > SKILL_IMPORT_LIMITS.bytes)
        throw new Error(
          `来源文件 ${next} 超过单文件上限 ${SKILL_IMPORT_LIMITS.bytes} 字节，导入已中止`,
        );
      totalBytes += stat.size;
      if (totalBytes > SKILL_IMPORT_LIMITS.bytes)
        throw new Error(`来源包超过 ${SKILL_IMPORT_LIMITS.bytes} 字节总上限，导入已中止`);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      if (next === 'SKILL.md') await fs.writeFile(destination, normalizedSkill, 'utf8');
      else await fs.copyFile(real, destination);
    }
  };
  await walk('', 0);
  return { diagnostics };
}

/** 有界测量技能包；超限返回 overflow 而不抛出，由调用方截断并记录。 */
async function measurePackage(
  directory: string,
  signal?: AbortSignal,
): Promise<{ files: number; bytes: number; hasScripts: boolean; overflow: boolean }> {
  const result = { files: 0, bytes: 0, hasScripts: false, overflow: false };
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (result.overflow) return;
    signal?.throwIfAborted();
    if (depth > SKILL_LIMITS.depth) {
      result.overflow = true;
      return;
    }
    const entries = await fs.opendir(path.join(directory, relative));
    for await (const entry of entries) {
      if (result.overflow) return;
      const next = relative ? path.join(relative, entry.name) : entry.name;
      if (next.split(path.sep).includes('scripts')) result.hasScripts = true;
      const source = path.join(directory, next);
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink()) {
        const real = await fs.realpath(source).catch(() => undefined);
        if (!real || !isInside(directory, real)) continue;
        const targetStat = await fs.stat(real);
        if (targetStat.isDirectory()) await walk(next, depth + 1);
        else if (targetStat.isFile()) addBytes(targetStat.size);
        continue;
      }
      if (stat.isDirectory()) {
        await walk(next, depth + 1);
        continue;
      }
      if (stat.isFile()) addBytes(stat.size);
    }
  };
  const addBytes = (size: number) => {
    result.files++;
    result.bytes += size;
    if (result.bytes > SKILL_IMPORT_LIMITS.bytes) result.overflow = true;
  };
  await walk('', 0);
  return result;
}

/**
 * 收集技能包每文件的摘要（相对路径 → sha256）；跳过溯源文件，符号链接只记录物理内容。
 *
 * 边界与保证：
 * - 摘要按**原始字节**计算（Buffer 哈希）：utf8 解码会把非法序列替换成 U+FFFD，
 *   两个不同的二进制资源会得到同一摘要，导致 unchanged 误判与溯源失真；
 * - 有界遍历：物理目录去重（循环符号链接不再无限递归）+ 深度上限对齐发现链
 *   （`SKILL_LIMITS.depth`），超限跳过并向 `diagnostics` 记录（传入时）；
 * - 根路径先按 realpath 归一，词法来源根（如 macOS `/var` 别名）与物理边界保持同一口径。
 */
async function collectPackageDigests(
  directory: string,
  signal?: AbortSignal,
  diagnostics?: SkillDiagnostic[],
): Promise<Map<string, string>> {
  const digests = new Map<string, string>();
  const physicalRoot = (await fs.realpath(directory).catch(() => undefined)) ?? directory;
  const visited = new Set<string>();
  const walk = async (relative: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if (depth > SKILL_LIMITS.depth) {
      diagnostics?.push({
        code: 'import_depth_skipped',
        level: 'warn',
        path: path.join(physicalRoot, relative),
        message: '目录深度超过导入上限，摘要收集已跳过更深层内容',
      });
      return;
    }
    const from = path.join(physicalRoot, relative);
    const physical = await fs.realpath(from).catch(() => undefined);
    if (!physical || visited.has(physical)) return;
    if (!isInside(physicalRoot, physical)) return;
    visited.add(physical);
    const entries = await fs.opendir(from);
    for await (const entry of entries) {
      const next = relative ? path.join(relative, entry.name) : entry.name;
      if (next === SKILL_PROVENANCE_FILE) continue;
      const real = await fs.realpath(path.join(physicalRoot, next)).catch(() => undefined);
      if (!real || !isInside(physicalRoot, real)) continue;
      const stat = await fs.stat(real);
      if (stat.isDirectory()) {
        await walk(next, depth + 1);
        continue;
      }
      if (stat.isFile()) digests.set(next, digestBuffer(await fs.readFile(real)));
    }
  };
  await walk('', 0);
  return digests;
}

/** 原始字节摘要；文本文件的合法 UTF-8 重编码与逐字节结果一致，二进制不再被 U+FFFD 折叠。 */
function digestBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 对排序后的「相对路径 + 摘要」取总摘要，作为落地副本身份。 */
function digestFromFiles(files: Map<string, string>): string {
  const names = [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return skillDigest(names.map((name) => `${name}\u0000${files.get(name)}`).join('\n'));
}

/** 重新导入预览：来源（归一后）是否仍是当初那份，以及本地副本是否被改过。 */
async function describeReimport(
  targetDir: string,
  sourceDir: string,
  previous: ImportedSkillProvenance,
  normalized: NormalizedImportedSkill,
  signal?: AbortSignal,
  diagnostics?: SkillDiagnostic[],
): Promise<NonNullable<SkillImportCandidate['previouslyImported']>> {
  const target = await collectPackageDigests(targetDir, signal, diagnostics).catch(
    () => new Map<string, string>(),
  );
  const source = await collectPackageDigests(sourceDir, signal, diagnostics).catch(
    () => new Map<string, string>(),
  );
  const sourceWithNormalized = new Map(source);
  sourceWithNormalized.set('SKILL.md', skillDigest(normalized.content));
  const changedFiles = [...new Set([...target.keys(), ...sourceWithNormalized.keys()])]
    .filter((name) => target.get(name) !== sourceWithNormalized.get(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    installedAt: previous.installedAt,
    installedDigest: previous.installedDigest,
    sourceUnchanged: `sha256:${digestFromFiles(sourceWithNormalized)}` === previous.installedDigest,
    changedFiles,
  };
}

/** 导入成功后把名字从全局禁用列表移除（默认保持启用）；失败只记诊断，不回滚已有导入。 */
function enableImportedSkills(
  options: SkillImportOptions,
  names: string[],
  diagnostics: SkillDiagnostic[],
): void {
  const disabled = new Set(options.settings.skills?.disabled ?? []);
  const pending = names.filter((name) => disabled.has(name));
  if (!pending.length) return;
  try {
    mutateGlobalSettings(
      (draft) => {
        const list = new Set(draft.skills?.disabled ?? []);
        for (const name of pending) list.delete(name);
        draft.skills = { ...(draft.skills ?? {}), disabled: [...list] };
      },
      { homeDir: options.homeDir },
    );
  } catch (error) {
    diagnostics.push({
      code: 'import_enable_failed',
      level: 'warn',
      path: options.homeDir,
      message: `导入成功但未能更新禁用列表：${errorMessage(error)}`,
    });
  }
}

/**
 * 检查来源根：不存在返回 exists=false；存在但无法按目录读取时标记不可读。
 *
 * 符号链接来源根（dotfiles 管理器把 `~/.claude/skills` 做成软链很常见）按物理目标判定：
 * 能解析为目录即按可读来源正常处理；悬空链接或最终不是目录才给 `import_source_unreadable`，
 * 绝不把链接形态的来源静默当成「不存在」跳过。
 */
async function checkSourceRoot(
  root: string,
): Promise<{ exists: boolean; readable: boolean; message?: string }> {
  try {
    // fs.stat 跟随符号链接：普通目录与链接目录统一按物理目标判断。
    const target = await fs.stat(root);
    if (!target.isDirectory())
      return { exists: true, readable: false, message: '导入来源根不是目录，已按不可读处理' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // 悬空符号链接：链接本体存在但目标缺失（lstat 能确认），必须告警而不是静默跳过。
      const dangling = await fs
        .lstat(root)
        .then((stat) => stat.isSymbolicLink())
        .catch(() => false);
      if (dangling)
        return {
          exists: true,
          readable: false,
          message: '导入来源根是指向不存在目标的符号链接',
        };
      return { exists: false, readable: false };
    }
    return { exists: true, readable: false, message: errorMessage(error) };
  }
  try {
    await fs.realpath(root);
    return { exists: true, readable: true };
  } catch (error) {
    return { exists: true, readable: false, message: errorMessage(error) };
  }
}

/** 目标是否已存在（含无法解析的情况）；只用于冲突判定，不读取内容。 */
async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** 物理包含判定：路径按段比较，允许自身，不接受 `..` 或跨盘符。 */
function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** 把受控字段序列化成单行或多行 frontmatter；字符串一律走保守引号规则。 */
function serializeField(key: string, value: unknown): string[] {
  if (key === 'metadata') {
    const map = value as Record<string, string>;
    const lines = ['metadata:'];
    for (const [name, item] of Object.entries(map)) lines.push(`  ${name}: ${formatScalar(item)}`);
    return lines;
  }
  if (Array.isArray(value))
    return [`${key}: [${value.map((item) => formatScalar(String(item))).join(', ')}]`];
  if (typeof value === 'boolean' || typeof value === 'number') return [`${key}: ${value}`];
  return [`${key}: ${formatScalar(String(value))}`];
}

/**
 * 保守标量序列化：含 YAML 语义字符、首尾空白、换行或形似布尔/数字时用 JSON 双引号，
 * 保证 core 的解析器能无损读回字符串语义。
 */
function formatScalar(value: string): string {
  const needsQuote =
    value === '' ||
    /^\s|\s$/.test(value) ||
    /[:#[\]{},&*!|>'"%@`\r\n\t]/.test(value) ||
    /^(?:true|false|null|~|-?\d+(?:\.\d+)?)$/.test(value) ||
    value.startsWith('- ');
  return needsQuote ? JSON.stringify(value) : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
