import { isSkillName } from '@kiturone/kapibala';
import {
  EXPLICIT_SKILL_KICKOFF,
  SKILL_IMPORT_HARNESS_NAMES,
  type SkillImportResult,
  type SkillImportScan,
  sanitizeToolName,
} from '@kiturone/kapibala-host/internal';
import { resolveCommandOutput } from '../command-output.js';
import type { CommandContext, CommandHandler } from './dispatcher.js';

/** `/skill import` 的解析结果；`--all` 与单个名称互斥，`--from` 可限定来源。 */
export interface ParsedSkillImport {
  all: boolean;
  name?: string;
  from?: string;
  scope: 'global' | 'project';
  overwrite: boolean;
}

/**
 * 解析 `/skill import` 的尾部参数。
 *
 * 只接受设计 009 §6.1 列出的选项；未知选项、`--all` 与名称并用、非法技能名都返回错误，
 * 不猜测用户意图，也不把 `--from` 之后的值当成技能名。
 */
export function parseSkillImportArgs(tail: string): {
  value?: ParsedSkillImport;
  error?: string;
} {
  const tokens = tail.trim() ? tail.trim().split(/\s+/) : [];
  const value: ParsedSkillImport = { all: false, scope: 'global', overwrite: false };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '--all') value.all = true;
    else if (token === '--project') value.scope = 'project';
    else if (token === '--force') value.overwrite = true;
    else if (token === '--from') {
      const from = tokens[++index];
      if (!from || !(SKILL_IMPORT_HARNESS_NAMES as readonly string[]).includes(from))
        return {
          error: `未知来源: ${from ?? '（缺失）'}；可用: ${SKILL_IMPORT_HARNESS_NAMES.join(', ')}`,
        };
      value.from = from;
    } else if (token.startsWith('--')) return { error: `未知选项: ${token}` };
    else if (value.name) return { error: '一次只能导入一个技能名；全部导入请用 --all' };
    else value.name = token;
  }
  if (value.all && value.name) return { error: '--all 与技能名不能同时使用' };
  if (value.name && !isSkillName(value.name)) return { error: `技能名不合法: ${value.name}` };
  return { value };
}

/**
 * 解析一个技能名和可选任务；只消费一个分隔空白，保留任务的引号、其余空格与换行。
 * 任务缺省或全为空白时取宿主约定的启动任务（与桌面端无任务直发同一常量），
 * 使 `/skill <name>` 与 `/skill <name> <task>` 共用同一条受管运行路径；名称非法或超过 64 字符返回 undefined。
 */
export function parseSkillTask(tail: string): { name: string; task: string } | undefined {
  const match = tail.match(/^([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s([\s\S]*))?$/);
  if (!match || match[1].length > 64) return undefined;
  return {
    name: match[1],
    task: match[2]?.trim() ? match[2] : EXPLICIT_SKILL_KICKOFF,
  };
}

/** 只读当前集合、覆盖诊断和活动状态；禁用技能仍可检查，不触发正文读取或运行。 */
export const skillsCommand: CommandHandler = (args, ctx) => {
  const raw = args[0] ?? '';
  if (raw === 'inspect' || raw.startsWith('inspect ')) {
    inspectSkills(raw.slice('inspect'.length).trim(), ctx);
    return;
  }
  const snapshot = ctx.session.getSkills(raw);
  resolveCommandOutput(ctx).log('当前技能:');
  if (!snapshot.skills.length) resolveCommandOutput(ctx).log('  无匹配技能');
  for (const skill of snapshot.skills) {
    const active = snapshot.activations.find((item) => item.definition.name === skill.name);
    resolveCommandOutput(ctx).log(
      `  ${sanitizeToolName(skill.name)} [${skill.scope}] 用户:${skill.userInvocable ? '可用' : '禁用'} 模型:${skill.modelInvocable ? '可用' : '禁用'}${active ? ` 活动:${active.state}` : ''}`,
    );
    resolveCommandOutput(ctx).log(`    ${sanitizeToolName(skill.description)}`);
    resolveCommandOutput(ctx).log(
      `    来源: ${sanitizeToolName(skill.filePath)}${skill.available && !skill.disabled ? '' : ` · 不可用: ${sanitizeToolName(skill.unavailableReason ?? '已禁用')}`}`,
    );
  }
  resolveCommandOutput(ctx).log(`模型目录遗漏: ${snapshot.catalog.omitted}`);
  for (const diagnostic of snapshot.diagnostics)
    resolveCommandOutput(ctx).log(
      `  [${sanitizeToolName(diagnostic.code)}] ${sanitizeToolName(diagnostic.path)} · ${sanitizeToolName(diagnostic.message)}`,
    );
};

/**
 * `/skills inspect [--json]`：输出发现环境、逐技能来源、跳过节律与扫描诊断。
 *
 * 约束与边界：
 * - 只读当前会话注册表快照，不重新扫描、不加载正文、不改变信任；
 * - `--json` 与人类可读视图来自同一快照，避免两种口径分叉；
 * - 非 TTY 不做任何交互（本命令本身无交互）。
 */
function inspectSkills(tail: string, ctx: CommandContext): void {
  const output = resolveCommandOutput(ctx);
  const json = tail === '--json';
  if (tail && !json) {
    output.log('用法: /skills inspect [--json]');
    return;
  }
  const snapshot = ctx.session.getSkills('');
  const payload = {
    enabled: snapshot.enabled,
    roots: snapshot.roots.map((root) => ({
      path: root.path,
      scope: root.scope,
      kind: root.kind ?? 'native',
      trusted: root.trusted ?? root.scope !== 'project',
      boundary: root.boundary ?? root.path,
    })),
    catalog: snapshot.catalog,
    skills: snapshot.skills.map((skill) => ({
      name: skill.name,
      scope: skill.scope,
      available: skill.available,
      unavailableReason: skill.unavailableReason,
      disabled: skill.disabled,
      sourceRoot: skill.sourceRoot,
      filePath: skill.filePath,
    })),
    diagnostics: snapshot.diagnostics,
    lifecycle: snapshot.lifecycle,
  };
  if (json) {
    output.log(JSON.stringify(payload, null, 2));
    return;
  }
  output.log(
    `发现模式: ${payload.enabled ? '已启用' : '已停用'} · 扫描根 ${payload.roots.length} 个`,
  );
  for (const root of payload.roots)
    output.log(
      `  [${root.scope}/${root.kind}] ${root.trusted ? '已信任' : '未信任'} ${sanitizeToolName(root.path)}`,
    );
  output.log(`技能: ${payload.skills.length} 个 · 模型目录遗漏: ${payload.catalog.omitted}`);
  for (const skill of payload.skills) {
    const state = skill.disabled ? '已禁用' : skill.available ? '可用' : '不可用';
    output.log(`  ${sanitizeToolName(skill.name)} [${skill.scope}] ${state}`);
    output.log(`    路径: ${sanitizeToolName(skill.filePath || skill.sourceRoot || '未知')}`);
    if (!skill.available && skill.unavailableReason)
      output.log(`    原因: ${sanitizeToolName(skill.unavailableReason)}`);
  }
  if (payload.lifecycle.length) {
    output.log(`生命周期事件: ${payload.lifecycle.length} 条`);
    for (const event of payload.lifecycle)
      output.log(
        `  [${event.phase}] ${sanitizeToolName(event.name)} [${event.scope}] ${sanitizeToolName(event.filePath)}${event.code ? ` · ${sanitizeToolName(event.code)}` : ''}${event.message ? ` · ${sanitizeToolName(event.message)}` : ''}`,
      );
  }
  if (payload.diagnostics.length) {
    output.log(`扫描诊断: ${payload.diagnostics.length} 条`);
    for (const diagnostic of payload.diagnostics)
      output.log(
        `  [${sanitizeToolName(diagnostic.code)}] ${sanitizeToolName(diagnostic.path)} · ${sanitizeToolName(diagnostic.message)}`,
      );
  }
}

/**
 * 仅将合法名称与任务（缺省用启动任务）交给宿主受管运行；命令本身不读取文件、不扩大权限。
 *
 * `/skill import ...` 是保留子命令（设计 009 §6.1）：它优先于技能名解析，因此名为 `import`
 * 的技能不能从 CLI 直接激活；在帮助文案中显式说明，避免静默改变普通技能调用语义。
 */
export const skillCommand: CommandHandler = async (args, ctx) => {
  const raw = args[0] ?? '';
  if (raw === 'import' || raw.startsWith('import ')) {
    await importSkillCommand(raw.slice('import'.length).trim(), ctx);
    return;
  }
  const parsed = parseSkillTask(raw);
  if (!parsed) throw new Error('用法: /skill <name> [task...]');
  if (!ctx.runSkill) throw new Error('当前宿主未提供技能执行入口');
  await ctx.runSkill(parsed.name, parsed.task);
};

/** 冲突状态的人类可读标签；与设计 009 §5.2 的三种取值一一对应。 */
const CONFLICT_LABELS = {
  none: '无',
  'exists-enabled': '已存在（启用）',
  'exists-disabled': '已存在（禁用）',
} as const;

/**
 * 把候选列表打印成表格；非 TTY 与交互终端使用同一份文本，不做分页交互。
 *
 * 已导入候选追加来源差异徽标（来源未变 / 来源已改 N 文件，对齐设计 009 §5.5 的重导入口径），
 * 用户据此决定是否需要 `--force` 覆盖，而不是盲目导入后才发现内容没变或漏掉改动。
 */
function renderImportScan(scan: SkillImportScan, ctx: CommandContext): void {
  const output = resolveCommandOutput(ctx);
  output.log('可导入来源:');
  for (const source of scan.sources) {
    const roots = source.roots.length
      ? source.roots
          .map(
            (root) =>
              `${root.scope}:${sanitizeToolName(root.path)}${root.readable ? '' : '（不可读）'}`,
          )
          .join(' · ')
      : '未提供可用目录';
    output.log(
      `  ${source.label} (${source.harness}) · ${source.candidates} 个候选${source.partial ? ` · 已截断 ${source.truncated}` : ''}`,
    );
    output.log(`    ${roots}`);
  }
  output.log(`候选技能: ${scan.candidates.length} 个`);
  if (!scan.candidates.length) {
    output.log('  未发现可导入技能（来源目录不存在或为空）。');
    return;
  }
  for (const candidate of scan.candidates) {
    const size =
      candidate.bytes >= 1024 * 1024
        ? `${(candidate.bytes / (1024 * 1024)).toFixed(1)} MiB`
        : `${Math.max(1, Math.round(candidate.bytes / 1024))} KiB`;
    // previouslyImported 是宿主按溯源文件比对出的差异事实；未导入过则没有徽标。
    const previously = candidate.previouslyImported;
    const importState = previously
      ? previously.sourceUnchanged
        ? ' · 来源未变'
        : previously.changedFiles.length
          ? ` · 来源已改（${previously.changedFiles.length} 文件）`
          : ' · 来源已改'
      : '';
    output.log(
      `  ${sanitizeToolName(candidate.name)} [${candidate.harness}/${candidate.origin}] ${candidate.files} 文件 · ${size}${candidate.hasScripts ? ' · 含 scripts' : ''} · 冲突: ${CONFLICT_LABELS[candidate.conflict]}${candidate.strippedFields.length ? ` · 将剥离: ${candidate.strippedFields.join(', ')}` : ''}${importState}`,
    );
    if (candidate.description) output.log(`    ${sanitizeToolName(candidate.description)}`);
  }
  output.log('用法: /skill import <name> [--from <harness>] [--project] [--force]');
  output.log('      /skill import --all [--from <harness>] [--project]');
}

/**
 * `/skill import`：列出候选，或按单个名称 / `--all` 执行导入。
 *
 * 边界：
 * - 宿主未注入扫描/导入能力时明确报告不支持，不返回空表冒充「没有可导入项」；
 * - 宿主扫描/导入抛错按 output.error（stderr 通道）报告，与 mcp/watches 命令的失败口径一致，
 *   不冒泡到 dispatcher 的统一捕获（那里走 stdout，失败会混进正常输出）；
 * - 同名候选跨来源出现时必须用 `--from` 指定，不按目录顺序猜一个；
 * - 导入后提示「重新打开会话后生效」，因为当前会话的注册表是启动时快照。
 */
async function importSkillCommand(tail: string, ctx: CommandContext): Promise<void> {
  const output = resolveCommandOutput(ctx);
  const parsed = parseSkillImportArgs(tail);
  if (!parsed.value) {
    output.log(parsed.error ?? '用法: /skill import [<name> | --all]');
    return;
  }
  const options = parsed.value;
  if (!ctx.scanImportableSkills || !ctx.importSkills) {
    output.log('当前宿主不支持跨工具导入技能。');
    return;
  }
  let scan: SkillImportScan;
  try {
    scan = await ctx.scanImportableSkills(options.scope);
  } catch (error) {
    output.error(`扫描可导入技能失败: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!options.all && !options.name) {
    renderImportScan(scan, ctx);
    return;
  }
  const matches = scan.candidates.filter(
    (candidate) =>
      (!options.from || candidate.harness === options.from) &&
      (options.all || candidate.name === options.name),
  );
  if (!matches.length) {
    output.log(
      options.name
        ? `未找到可导入技能: ${sanitizeToolName(options.name)}${options.from ? `（来源 ${options.from}）` : ''}`
        : '没有匹配的可导入候选。',
    );
    return;
  }
  if (!options.all && matches.length > 1) {
    output.log(
      `同名技能来自多个来源，请用 --from 指定: ${matches.map((candidate) => candidate.harness).join(', ')}`,
    );
    return;
  }
  let result: SkillImportResult;
  try {
    result = await ctx.importSkills({
      scope: options.scope,
      overwrite: options.overwrite,
      items: matches.map((candidate) => ({
        harness: candidate.harness,
        name: candidate.name,
        expectedSourceRef: candidate.sourceRef,
      })),
    });
  } catch (error) {
    output.error(`导入失败: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  output.log(
    `导入完成（作用域: ${result.scope}）: 导入 ${result.imported} · 未变 ${result.unchanged} · 跳过 ${result.skippedConflict + result.skippedLimit}（冲突 ${result.skippedConflict}、超限 ${result.skippedLimit}）· 失败 ${result.failed}`,
  );
  for (const item of result.items) {
    const prefix =
      item.status === 'imported'
        ? '✓'
        : item.status === 'unchanged'
          ? '='
          : item.status === 'failed'
            ? '!'
            : '-';
    output.log(
      `  ${prefix} ${sanitizeToolName(item.name)} [${item.harness}] ${item.status}${item.message ? ` · ${sanitizeToolName(item.message)}` : ''}`,
    );
  }
  if (result.diagnostics.length) {
    for (const diagnostic of result.diagnostics)
      output.log(
        `  [${sanitizeToolName(diagnostic.code)}] ${sanitizeToolName(diagnostic.path)} · ${sanitizeToolName(diagnostic.message)}`,
      );
  }
  if (result.imported || result.unchanged) output.log('重新打开会话后技能列表才会刷新。');
}
