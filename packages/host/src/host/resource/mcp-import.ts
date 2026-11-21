import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  type McpConfigDiagnostic,
  type RawServerConfig,
  validateAndNormalizeServerConfig,
  validateServerName,
} from '@kiturone/kapibala-mcp';
import { readMcpConfigFile } from '../mcp.js';
import { redactCommonSecrets } from '../redaction.js';
import { getGlobalMcpConfigPath, getProjectMcpConfigPath, mutateMcpConfig } from './mcp-config.js';

/**
 * 从其它 Harness 导入 MCP 配置的一次性导入服务。
 *
 * 定位与边界：
 * - 只承诺三种可核实的来源格式（Claude Desktop / Claude Code / Cursor），不猜测未核实来源；
 * - 外部配置**只作为一次性快照**读取：不进入运行时配置解析链、不建立同步或监听；
 * - 导入是显式 mutation：预览 → 校验 → `mutateMcpConfig` 配置事务原子写入（溯源在同一把锁内
 *   随 `onCommitted` 落盘）；整个过程不执行来源中的任何命令，也不联网；
 * - 目标只允许自有配置文件（全局 `~/.kapibala/mcp.json` / 项目 `<project>/.kapibala/mcp.json`），
 *   项目作用域要求项目已信任；未信任项目既不扫描项目级来源，也不允许写入；
 * - 已知限制：扫描与导入是**同步函数**（`readFileSync` + `JSON.parse`），来源文件很大时
 *   （如数十 MB 的 `~/.claude.json`）会阻塞宿主事件循环；桌面侧
 *   `resources.inspectMcpImport` / `resources.importMcp` 契约目前按同步返回值定义，
 *   改造为 async 需要同步修改桌面契约与 resource-service，留给下一版随契约一起迁移。
 */

/** 可导入的外部 Harness 名单；只承诺这三种可验证格式，未知名称明确失败。 */
export const MCP_IMPORT_HARNESS_NAMES = ['claude-desktop', 'claude-code', 'cursor'] as const;

/** 可导入的外部 Harness；由名单派生，新增来源必须同时补来源表。 */
export type McpImportHarness = (typeof MCP_IMPORT_HARNESS_NAMES)[number];

/** 导入目标作用域；全局为默认，项目级需显式切换且在未信任项目上直接拒绝。 */
export type McpImportScope = 'global' | 'project';

/**
 * 溯源文件名：与 009 技能导入同名同格式，放在目标 mcp.json 同目录的 `.kapibala` 下。
 *
 * 文件内容是「server 名 → 记录」的映射，每条记录与技能溯源字段完全一致
 * （version / harness / sourceRef / installedAt / installedDigest / strippedFields），
 * 不另立字段；服务名不可能与顶层元数据键冲突，因为顶层键就是服务名。
 */
export const MCP_PROVENANCE_FILE = '.imported-from.json';

/** 单条溯源记录；与技能导入的溯源结构一致，便于两种资源共用同一解释方式。 */
export interface ImportedMcpProvenance {
  version: 1;
  harness: string;
  sourceRef: string;
  installedAt: string;
  installedDigest: string;
  strippedFields: string[];
}

/** 目标配置中同名服务的冲突状态；导入时据此决定跳过或要求显式覆盖。 */
export type McpImportConflict = 'none' | 'exists-enabled' | 'exists-disabled';

/** 单个导入候选；只含发现事实与预览结论，不含任何密钥值。 */
export interface McpImportCandidate {
  harness: McpImportHarness;
  name: string;
  /** 来源文件绝对路径；执行导入时必须与预览一致（防 TOCTOU）。 */
  sourceRef: string;
  /** 来源所在层级：user 级配置文件为 global，仓库内文件为 project。 */
  origin: McpImportScope;
  transport: 'stdio' | 'http';
  /** 目标摘要（命令行或端点 URL），经既有脱敏管道处理。 */
  target: string;
  /** 声明中是否携带环境变量或自定义请求头（只报存在性）。 */
  hasSecretSurface: boolean;
  /** 被丢弃的字段名（只报名字，不含值）；空数组表示原样保留传输字段。 */
  strippedFields: string[];
  /** 名称不符合 `^[a-zA-Z0-9_-]+$` 时的原因；非空则导入必然失败。 */
  nameProblem?: string;
  /** 转换后的配置原文；预览不展示，仅导入时写入。 */
  config: RawServerConfig;
  /** 转换后配置的稳定摘要，用于判断来源是否变化。 */
  configDigest: string;
  conflict: McpImportConflict;
  previouslyImported?: {
    installedAt: string;
    installedDigest: string;
    sourceUnchanged: boolean;
  };
}

/** 单个来源文件的扫描结论；文件不存在不会产生诊断，存在但不可读才告警。 */
export interface McpImportSourceView {
  harness: McpImportHarness;
  label: string;
  files: Array<{
    path: string;
    origin: McpImportScope;
    readable: boolean;
    servers: number;
  }>;
  candidates: number;
}

/** 预览结果；`candidates` 按来源表顺序排列，供 CLI 表格与桌面抽屉共用。 */
export interface McpImportScan {
  sources: McpImportSourceView[];
  candidates: McpImportCandidate[];
  diagnostics: McpConfigDiagnostic[];
}

/** 导入选择项：只传来源身份，不传配置正文。 */
export interface McpImportSelection {
  harness: string;
  name: string;
  expectedSourceRef: string;
}

/** 导入选项；`items` 为空数组表示全部候选，`scope` 决定写入哪份 mcp.json。 */
export interface McpImportOptions {
  homeDir: string;
  projectRoot: string;
  projectTrusted: boolean;
  scope?: McpImportScope;
  items?: readonly McpImportSelection[];
  overwrite?: boolean;
  /** 覆盖平台判定，仅用于测试与宿主显式指定；缺省取 `process.platform`。 */
  platform?: NodeJS.Platform;
  /** 覆盖 APPDATA 根（Windows 的 Claude Desktop 配置位置）；缺省取环境变量。 */
  appDataDir?: string;
  signal?: AbortSignal;
}

/** 单项导入结果；固定四桶之一，单条失败不中断其余候选。 */
export interface McpImportOutcome {
  harness: string;
  name: string;
  status: 'imported' | 'unchanged' | 'skipped-conflict' | 'failed';
  sourceRef?: string;
  targetPath?: string;
  message?: string;
  strippedFields?: string[];
}

/** 批量导入汇总；冲突按设计默认跳过，不静默覆盖。 */
export interface McpImportResult {
  scope: McpImportScope;
  items: McpImportOutcome[];
  imported: number;
  unchanged: number;
  skippedConflict: number;
  failed: number;
  diagnostics: McpConfigDiagnostic[];
}

/** 来源登记：`origin` 决定该文件发现的声明属于哪一层，与写入作用域无关。 */
interface SourceFileEntry {
  harness: McpImportHarness;
  label: string;
  file: string;
  origin: McpImportScope;
  /** Claude Code 的 `~/.claude.json` 需要额外解析 `projects[<项目>]`。 */
  profileFile?: boolean;
}

const HARNESS_LABELS: Record<McpImportHarness, string> = {
  'claude-desktop': 'Claude Desktop',
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
};

/**
 * 解析全部来源文件位置；项目级来源在未信任项目上直接跳过。
 *
 * 边界：Windows 的 Claude Desktop 配置随 APPDATA 走（`%APPDATA%/Claude/...`），
 * 其余平台按各自约定；路径只用于读取，不存在时不产生任何诊断。
 */
function resolveSourceFiles(options: {
  homeDir: string;
  projectRoot: string;
  projectTrusted: boolean;
  platform: NodeJS.Platform;
  appDataDir?: string;
}): SourceFileEntry[] {
  const home = options.homeDir;
  const claudeDesktop =
    options.platform === 'win32'
      ? path.join(
          options.appDataDir ?? process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'),
          'Claude',
          'claude_desktop_config.json',
        )
      : options.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  const files: SourceFileEntry[] = [
    {
      harness: 'claude-desktop',
      label: HARNESS_LABELS['claude-desktop'],
      file: claudeDesktop,
      origin: 'global',
    },
    {
      harness: 'claude-code',
      label: HARNESS_LABELS['claude-code'],
      file: path.join(home, '.claude.json'),
      origin: 'global',
      profileFile: true,
    },
    {
      harness: 'cursor',
      label: HARNESS_LABELS.cursor,
      file: path.join(home, '.cursor', 'mcp.json'),
      origin: 'global',
    },
  ];
  // 项目级来源只在项目已信任时读取：未确认信任前不读仓库内容。
  if (options.projectTrusted) {
    files.push(
      {
        harness: 'claude-code',
        label: HARNESS_LABELS['claude-code'],
        file: path.join(options.projectRoot, '.mcp.json'),
        origin: 'project',
      },
      {
        harness: 'cursor',
        label: HARNESS_LABELS.cursor,
        file: path.join(options.projectRoot, '.cursor', 'mcp.json'),
        origin: 'project',
      },
    );
  }
  return files;
}

/** 扫描可导入的 MCP 服务，产出预览（名称 / 来源 / 传输 / 冲突 / 脱敏字段名）。 */
export function scanImportableMcpServers(options: McpImportOptions): McpImportScan {
  const scope = options.scope ?? 'global';
  const diagnostics: McpConfigDiagnostic[] = [];
  const candidates: McpImportCandidate[] = [];
  const sources: McpImportSourceView[] = [];
  const targetServers = readTargetServers(options, scope, diagnostics);
  const provenance = readImportedMcpProvenance({ ...options, scope });
  const seen = new Set<string>();
  for (const entry of resolveSourceFiles({
    homeDir: options.homeDir,
    projectRoot: options.projectRoot,
    projectTrusted: options.projectTrusted,
    platform: options.platform ?? process.platform,
    appDataDir: options.appDataDir,
  })) {
    options.signal?.throwIfAborted();
    const view: McpImportSourceView = {
      harness: entry.harness,
      label: entry.label,
      files: [],
      candidates: 0,
    };
    sources.push(view);
    const parsed = readSourceFile(entry, options, diagnostics);
    view.files.push({
      path: entry.file,
      origin: entry.origin,
      readable: parsed !== undefined,
      servers: parsed?.length ?? 0,
    });
    for (const discovered of parsed ?? []) {
      options.signal?.throwIfAborted();
      const key = `${entry.harness}:${discovered.name}`;
      if (seen.has(key)) {
        diagnostics.push({
          severity: 'info',
          code: 'MCP_IMPORT_DUPLICATE_NAME',
          serverName: discovered.name,
          message: `${entry.label} 内出现同名服务，已忽略后出现的副本：${discovered.name}`,
        });
        continue;
      }
      const converted = convertServerEntry(discovered.name, discovered.raw);
      diagnostics.push(...converted.diagnostics);
      if (!converted.config) {
        // 无法转换的声明也进入预览，让用户看到「为什么不能导入」而不是静默消失。
        view.candidates++;
        seen.add(key);
        const nameCheck = validateServerName(discovered.name);
        candidates.push({
          harness: entry.harness,
          name: discovered.name,
          sourceRef: entry.file,
          origin: discovered.origin,
          transport: 'stdio',
          target: '',
          hasSecretSurface: false,
          strippedFields: converted.strippedFields,
          ...(nameCheck.valid ? {} : { nameProblem: nameCheck.reason }),
          config: {},
          configDigest: '',
          conflict: 'none',
        });
        continue;
      }
      const nameCheck = validateServerName(discovered.name);
      const digest = digestConfig(converted.config);
      const previous = provenance[discovered.name];
      view.candidates++;
      seen.add(key);
      candidates.push({
        harness: entry.harness,
        name: discovered.name,
        sourceRef: entry.file,
        origin: discovered.origin,
        transport: converted.config.type === 'http' ? 'http' : 'stdio',
        target: redactCommonSecrets(describeTarget(converted.config)),
        hasSecretSurface: hasSecretSurface(converted.config),
        strippedFields: converted.strippedFields,
        ...(nameCheck.valid ? {} : { nameProblem: nameCheck.reason }),
        config: converted.config,
        configDigest: digest,
        conflict: conflictOf(targetServers, discovered.name),
        ...(previous
          ? {
              previouslyImported: {
                installedAt: previous.installedAt,
                installedDigest: previous.installedDigest,
                sourceUnchanged: previous.installedDigest === digest,
              },
            }
          : {}),
      });
    }
  }
  return { sources, candidates, diagnostics };
}

/** 导入计划的单项状态；`outcome` 原地改写，事务失败时无需重建顺序。 */
interface PlannedImport {
  candidate?: McpImportCandidate;
  outcome: McpImportOutcome;
  write: boolean;
}

/**
 * 执行导入：重新扫描来源 → 校验身份与配置 → 单事务写入 → 写溯源。
 *
 * 关键保证：
 * - 项目作用域在未信任项目上整批拒绝，不进入确认流程；
 * - `expectedSourceRef` 与本次扫描不一致即 `failed`（预览的是 A、导入的不能是 B）；
 * - 同名默认跳过，只有 `overwrite` 才替换；目标配置已存在且内容一致返回 `unchanged` 不写盘；
 * - 所有候选在同一次配置事务内提交，事务失败整批 `failed`，绝不留下半批写入；
 * - 溯源在同一把配置锁内随事务提交写入（`onCommitted`），与并发导入串行；
 *   溯源写失败只记诊断，不回滚已成功的配置写入。
 */
export function importMcpServers(options: McpImportOptions): McpImportResult {
  const scope = options.scope ?? 'global';
  if (scope === 'project' && !options.projectTrusted)
    throw new Error('项目尚未信任，不能写入项目级 MCP 配置');
  const scan = scanImportableMcpServers(options);
  const diagnostics = [...scan.diagnostics];
  const targetPath =
    scope === 'project'
      ? getProjectMcpConfigPath(options.projectRoot)
      : getGlobalMcpConfigPath(options.homeDir);
  const targetOptions =
    scope === 'project'
      ? { scope, projectRoot: options.projectRoot, projectTrusted: true }
      : { scope, homeDir: options.homeDir };
  // 事务内重新判定冲突，避免预览后目标被他人改动导致覆盖或误判。
  const targetServers = readTargetServers(options, scope, diagnostics);
  const selections = options.items?.length ? options.items : scan.candidates;
  const planned: PlannedImport[] = [];
  for (const selection of selections) {
    options.signal?.throwIfAborted();
    const candidate = scan.candidates.find(
      (item) => item.harness === selection.harness && item.name === selection.name,
    );
    if (!candidate) {
      planned.push({
        outcome: {
          harness: selection.harness,
          name: selection.name,
          status: 'failed',
          message: '来源扫描中未找到该服务，请重新扫描',
        },
        write: false,
      });
      continue;
    }
    const base = {
      harness: candidate.harness,
      name: candidate.name,
      sourceRef: candidate.sourceRef,
    };
    if ('expectedSourceRef' in selection && selection.expectedSourceRef !== candidate.sourceRef) {
      planned.push({
        candidate,
        outcome: {
          ...base,
          status: 'failed',
          message: '来源在预览后发生变化，请重新扫描后再导入',
        },
        write: false,
      });
      continue;
    }
    if (candidate.nameProblem) {
      planned.push({
        candidate,
        outcome: { ...base, status: 'failed', message: `服务名不合法：${candidate.nameProblem}` },
        write: false,
      });
      continue;
    }
    if (!candidate.configDigest) {
      planned.push({
        candidate,
        outcome: {
          ...base,
          status: 'failed',
          message: '来源声明缺少 command 或 url，无法转换为 MCP 服务',
        },
        write: false,
      });
      continue;
    }
    const check = validateAndNormalizeServerConfig(candidate.name, candidate.config);
    const error = check.diagnostics.find((item) => item.severity === 'error');
    if (!check.config || error) {
      planned.push({
        candidate,
        outcome: { ...base, status: 'failed', message: error?.message ?? '配置校验失败' },
        write: false,
      });
      continue;
    }
    // 目标已有同名服务且配置逐字段一致：内容未变，不写盘也不计入冲突。
    const existingRaw = targetServers.get(candidate.name);
    if (existingRaw !== undefined && stableJson(existingRaw) === stableJson(candidate.config)) {
      planned.push({
        candidate,
        outcome: { ...base, status: 'unchanged', targetPath },
        write: false,
      });
      continue;
    }
    if (existingRaw !== undefined && options.overwrite !== true) {
      planned.push({
        candidate,
        outcome: {
          ...base,
          status: 'skipped-conflict',
          targetPath,
          message: '目标已存在同名服务；如需替换请显式选择覆盖',
        },
        write: false,
      });
      continue;
    }
    planned.push({
      candidate,
      outcome: {
        ...base,
        status: 'imported',
        targetPath,
        ...(candidate.strippedFields.length
          ? { strippedFields: [...candidate.strippedFields] }
          : {}),
      },
      write: true,
    });
  }
  const writes = planned.filter(
    (item): item is PlannedImport & { candidate: McpImportCandidate; write: true } =>
      item.write && item.candidate !== undefined,
  );
  if (writes.length) {
    // 溯源更新放进同一把配置锁：事务提交后、锁释放前写入（onCommitted），
    // 并发导入不再各自「锁外读改写」溯源文件，避免 last-writer-wins 丢记录。
    const provenanceCandidates = writes
      .filter((item) => item.outcome.status === 'imported')
      .map((item) => item.candidate);
    try {
      mutateMcpConfig(
        (file) => {
          file.mcpServers ??= {};
          for (const item of writes) file.mcpServers[item.candidate.name] = item.candidate.config;
        },
        targetOptions,
        provenanceCandidates.length
          ? () => writeProvenance(options, scope, provenanceCandidates, diagnostics)
          : undefined,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const item of writes) {
        item.outcome = {
          harness: item.outcome.harness,
          name: item.outcome.name,
          sourceRef: item.outcome.sourceRef,
          status: 'failed',
          message,
        };
      }
    }
  }
  const items = planned.map((item) => item.outcome);
  return {
    scope,
    items,
    imported: items.filter((item) => item.status === 'imported').length,
    unchanged: items.filter((item) => item.status === 'unchanged').length,
    skippedConflict: items.filter((item) => item.status === 'skipped-conflict').length,
    failed: items.filter((item) => item.status === 'failed').length,
    diagnostics,
  };
}

/** 读取已导入服务的溯源记录；文件缺失、损坏或记录非法时一律忽略该条，不猜测。 */
export function readImportedMcpProvenance(options: {
  scope?: McpImportScope;
  homeDir: string;
  projectRoot?: string;
}): Record<string, ImportedMcpProvenance> {
  const file = provenancePath({
    scope: options.scope ?? 'global',
    homeDir: options.homeDir,
    projectRoot: options.projectRoot,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const result: Record<string, ImportedMcpProvenance> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    const record = value as Partial<ImportedMcpProvenance>;
    if (
      record.version !== 1 ||
      typeof record.harness !== 'string' ||
      typeof record.sourceRef !== 'string' ||
      typeof record.installedAt !== 'string' ||
      typeof record.installedDigest !== 'string' ||
      !Array.isArray(record.strippedFields) ||
      record.strippedFields.some((field) => typeof field !== 'string')
    )
      continue;
    result[name] = {
      version: 1,
      harness: record.harness,
      sourceRef: record.sourceRef,
      installedAt: record.installedAt,
      installedDigest: record.installedDigest,
      strippedFields: [...record.strippedFields],
    };
  }
  return result;
}

/** 读取目标 mcp.json 的服务清单；损坏时记诊断并返回空表（事务阶段仍会失败，不会静默覆盖）。 */
function readTargetServers(
  options: McpImportOptions,
  scope: McpImportScope,
  diagnostics: McpConfigDiagnostic[],
): Map<string, RawServerConfig> {
  const file =
    scope === 'project'
      ? getProjectMcpConfigPath(options.projectRoot)
      : getGlobalMcpConfigPath(options.homeDir);
  try {
    return new Map(Object.entries(readMcpConfigFile(file)?.mcpServers ?? {}));
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code: 'MCP_IMPORT_TARGET_INVALID',
      message: `读取目标 MCP 配置失败 [${file}]：${error instanceof Error ? error.message : String(error)}`,
    });
    return new Map();
  }
}

/** 读取并解析单个来源文件；不存在返回 undefined，存在但无法解析时记诊断并返回 undefined。 */
function readSourceFile(
  entry: SourceFileEntry,
  options: McpImportOptions,
  diagnostics: McpConfigDiagnostic[],
): Array<{ name: string; raw: unknown; origin: McpImportScope }> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    diagnostics.push({
      severity: 'warning',
      code: 'MCP_IMPORT_SOURCE_UNREADABLE',
      message: `无法读取 ${entry.label} 配置 [${entry.file}]：${error instanceof Error ? error.message : String(error)}`,
    });
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    diagnostics.push({
      severity: 'warning',
      code: 'MCP_IMPORT_SOURCE_INVALID',
      message: `${entry.label} 配置根节点不是 JSON 对象 [${entry.file}]`,
    });
    return undefined;
  }
  const root = raw as Record<string, unknown>;
  const groups: Array<{ origin: McpImportScope; servers: unknown }> = [
    { origin: entry.origin, servers: root.mcpServers },
  ];
  // Claude Code 把项目级声明嵌在 projects[绝对路径].mcpServers；只认与当前项目物理身份一致的键。
  if (entry.profileFile) {
    const projects = root.projects;
    if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
      for (const [key, value] of Object.entries(projects as Record<string, unknown>)) {
        if (!sameProjectPath(key, options.projectRoot, options.platform ?? process.platform))
          continue;
        const servers = (value as { mcpServers?: unknown } | null)?.mcpServers;
        groups.push({ origin: 'project', servers });
      }
    }
  }
  const entries: Array<{ name: string; raw: unknown; origin: McpImportScope }> = [];
  for (const group of groups) {
    if (!group.servers) continue;
    if (typeof group.servers !== 'object' || Array.isArray(group.servers)) {
      diagnostics.push({
        severity: 'warning',
        code: 'MCP_IMPORT_SOURCE_INVALID',
        message: `${entry.label} 的 mcpServers 不是对象 [${entry.file}]`,
      });
      continue;
    }
    for (const [name, value] of Object.entries(group.servers as Record<string, unknown>))
      entries.push({ name, raw: value, origin: group.origin });
  }
  return entries;
}

/** 把来源条目转换成 Kapibala 的 `RawServerConfig`，并记录被丢弃的字段名。 */
function convertServerEntry(
  name: string,
  raw: unknown,
): {
  config?: RawServerConfig;
  strippedFields: string[];
  diagnostics: McpConfigDiagnostic[];
} {
  const diagnostics: McpConfigDiagnostic[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    diagnostics.push({
      severity: 'warning',
      code: 'MCP_IMPORT_ENTRY_INVALID',
      serverName: name,
      message: `服务 '${name}' 的声明不是对象，已跳过`,
    });
    return { strippedFields: [], diagnostics };
  }
  const record = raw as Record<string, unknown>;
  const strippedFields: string[] = [];
  const command = typeof record.command === 'string' ? record.command.trim() : '';
  const url = typeof record.url === 'string' ? record.url.trim() : '';
  if (command && url) {
    diagnostics.push({
      severity: 'warning',
      code: 'MCP_IMPORT_AMBIGUOUS_TRANSPORT',
      serverName: name,
      message: `服务 '${name}' 同时声明 command 与 url，按 stdio 导入并丢弃 url`,
    });
    strippedFields.push('url');
  }
  let config: Record<string, unknown> | undefined;
  if (command) {
    config = { type: 'stdio', command };
    const args = convertStringArray(record.args);
    if (args) config.args = args;
    else if (record.args !== undefined) strippedFields.push('args');
    const env = convertStringMap(record.env);
    if (env) config.env = env;
    else if (record.env !== undefined) strippedFields.push('env');
    if (typeof record.type === 'string' && record.type !== 'stdio') strippedFields.push('type');
  } else if (url) {
    config = { type: 'http', url };
    const headers = convertStringMap(record.headers);
    if (headers) config.headers = headers;
    else if (record.headers !== undefined) strippedFields.push('headers');
    // Cursor 的 `sse` / `streamable-http` 一律折叠为 http 传输，原 type 值不再保留。
    if (typeof record.type === 'string' && record.type !== 'http') strippedFields.push('type');
  } else {
    diagnostics.push({
      severity: 'warning',
      code: 'MCP_IMPORT_ENTRY_INVALID',
      serverName: name,
      message: `服务 '${name}' 缺少 command 或 url，已跳过`,
    });
    return { strippedFields, diagnostics };
  }
  // 只保留本版支持的传输字段；其余（disabled / alwaysAllow / autoApprove 等）只记录字段名。
  const kept = new Set(['command', 'args', 'env', 'url', 'headers', 'type']);
  for (const key of Object.keys(record)) {
    if (!kept.has(key)) strippedFields.push(key);
  }
  return {
    config: config as RawServerConfig,
    strippedFields: [...new Set(strippedFields)],
    diagnostics,
  };
}

/** 字符串数组归一：全部元素为字符串才保留，否则整体丢弃（不把对象塞进 args）。 */
function convertStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === 'string') ? [...(value as string[])] : undefined;
}

/** 字符串映射归一：只保留字符串值，对象/数组值无法安全表达，整体丢弃。 */
function convertStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, item]) => typeof item !== 'string')) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

/** 目标摘要：stdio 取命令行，http 取端点；只用于展示，随后仍会脱敏。 */
function describeTarget(config: RawServerConfig): string {
  const record = config as Record<string, unknown>;
  if (record.type === 'http') return String(record.url ?? '');
  return [record.command, ...((record.args as string[] | undefined) ?? [])]
    .filter(Boolean)
    .join(' ');
}

/** 是否存在环境变量或请求头（只报存在性，值不进入预览）。 */
function hasSecretSurface(config: RawServerConfig): boolean {
  const record = config as Record<string, unknown>;
  const env = record.env as Record<string, string> | undefined;
  const headers = record.headers as Record<string, string> | undefined;
  return Boolean(
    (env && Object.keys(env).length > 0) || (headers && Object.keys(headers).length > 0),
  );
}

/** 冲突判定：同名且显式 `enabled: false` 视为已停用，其余同名均视为占用。 */
function conflictOf(servers: Map<string, RawServerConfig>, name: string): McpImportConflict {
  if (!servers.has(name)) return 'none';
  const raw = servers.get(name) as Record<string, unknown> | undefined;
  return raw?.enabled === false ? 'exists-disabled' : 'exists-enabled';
}

/** 顶层键排序后的稳定 JSON，保证同一配置在不同字段顺序下摘要一致。 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 配置摘要：`sha256:` 前缀与技能溯源一致，便于两种导入结果相互解释。 */
function digestConfig(config: RawServerConfig): string {
  return `sha256:${createHash('sha256').update(stableJson(config)).digest('hex')}`;
}

/** 溯源文件路径：与目标 mcp.json 的 `.kapibala` 目录同处，按作用域隔离。 */
function provenancePath(options: {
  scope: McpImportScope;
  homeDir: string;
  projectRoot?: string;
}): string {
  if (options.scope === 'project') {
    if (!options.projectRoot) throw new Error('项目级溯源缺少项目根');
    return path.join(options.projectRoot, '.kapibala', MCP_PROVENANCE_FILE);
  }
  return path.join(options.homeDir, '.kapibala', MCP_PROVENANCE_FILE);
}

/**
 * 写入溯源映射：只更新本次导入的服务，保留其它记录。
 *
 * 调用时机：必须在 `mutateMcpConfig` 的 `onCommitted` 回调内执行（仍持有配置锁），
 * 与并发导入的溯源更新严格串行；单独调用会退化为无锁读改写。
 *
 * 边界：既有溯源文件损坏时**不覆盖**（那是用户/他人写的现场），只记诊断；
 * 临时文件与目标同目录，tmp + rename 保证不会读到半份 JSON；
 * 溯源写失败不回滚已提交的配置，只记诊断。
 */
function writeProvenance(
  options: McpImportOptions,
  scope: McpImportScope,
  candidates: readonly McpImportCandidate[],
  diagnostics: McpConfigDiagnostic[],
): void {
  const file = provenancePath({
    scope,
    homeDir: options.homeDir,
    projectRoot: options.projectRoot,
  });
  let existing: Record<string, ImportedMcpProvenance>;
  try {
    existing = fs.existsSync(file)
      ? readImportedMcpProvenance({
          scope,
          homeDir: options.homeDir,
          projectRoot: options.projectRoot,
        })
      : {};
    if (fs.existsSync(file) && !Object.keys(existing).length) {
      // 空映射与损坏文件都读成空表；只有字面 `{}` 才是可以安全追加的空文件。
      if (fs.readFileSync(file, 'utf8').trim() !== '{}') {
        diagnostics.push({
          severity: 'warning',
          code: 'MCP_IMPORT_PROVENANCE_INVALID',
          message: `溯源文件损坏，未覆盖：[${file}]`,
        });
        return;
      }
    }
    const installedAt = new Date().toISOString();
    for (const candidate of candidates) {
      existing[candidate.name] = {
        version: 1,
        harness: candidate.harness,
        sourceRef: candidate.sourceRef,
        installedAt,
        installedDigest: candidate.configDigest,
        strippedFields: [...candidate.strippedFields],
      };
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, `${JSON.stringify(existing, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporary, file);
  } catch (error) {
    diagnostics.push({
      severity: 'warning',
      code: 'MCP_IMPORT_PROVENANCE_FAILED',
      message: `导入成功但溯源写入失败：${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/** 项目路径物理身份比较：按平台折叠大小写与分隔符，并兼容 Windows 8.3 短名。 */
function sameProjectPath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string): string => {
    let resolved = path.resolve(value);
    try {
      resolved = fs.realpathSync.native(value);
    } catch {
      /* 路径不存在时退回 resolve 结果。 */
    }
    const unified = resolved.replace(/\\/g, '/').replace(/\/+$/, '');
    return platform === 'win32' ? unified.toLowerCase() : unified;
  };
  return normalize(a) === normalize(b);
}
