/**
 * 本地分支与发布编排。远端推送永远由用户手动执行。
 *
 *   pnpm flow feat|fix|chore|docs [topic]   联网时从最新 origin/main、离线时从本地 main 切出并切换
 *   pnpm flow branch <name>                 按给定名称创建并切换
 *   pnpm flow release [version] [--dry-run] [--yes] [--scaffold]
 *                                           版本推进 → pnpm verify → 发布提交 → 打 tag
 *
 * tag 推送到远端后由 Actions 完成验证、npm 发布与 GitHub Release（见 .github/workflows/release.yml）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  STABLE_VERSION_PATTERN,
  nextVersion,
  readWorkspaceVersion,
  validateReleaseNotes,
} from './release.js';

const BRANCH_PREFIXES = ['feat', 'fix', 'chore', 'docs'] as const;
type BranchPrefix = (typeof BRANCH_PREFIXES)[number];
const VERSION_MANIFEST_FILES = [
  'package.json',
  'packages/core/package.json',
  'packages/cli/package.json',
] as const;
const CLI_VERSION_FILE = 'packages/cli/src/version.ts';

// ---------- 纯函数（可单测） ----------

/** 清洗分支主题：仅保留字母数字（含中文）、点与连字符；拒绝空结果与 .lock 后缀。 */
export function sanitizeTopic(input: string): string {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}.-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 60);
  if (!cleaned || cleaned.endsWith('.lock')) throw new Error(`Invalid branch topic: ${input}`);
  return cleaned;
}

/** 校验显式给出的完整分支名（可含一段路径分隔）。 */
export function sanitizeBranchName(input: string): string {
  const cleaned = input
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^[.\-/]+/, '');
  if (
    !/^[\p{L}\p{N}][\p{L}\p{N}./_-]*$/u.test(cleaned) ||
    cleaned.includes('..') ||
    cleaned.endsWith('.lock')
  ) {
    throw new Error(`Invalid branch name: ${input}`);
  }
  return cleaned;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 开发分支命名：有 topic 用 topic，否则用「日期-时分」兜底。 */
export function developmentBranchName(
  prefix: string,
  topic: string | undefined,
  now = new Date(),
): string {
  if (!(BRANCH_PREFIXES as readonly string[]).includes(prefix)) {
    throw new Error(`Unknown branch prefix: ${prefix}`);
  }
  const slug = topic
    ? sanitizeTopic(topic)
    : `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${prefix}/${slug}`;
}

/** 数值比较：a 是否严格大于 b。 */
export function isGreaterVersion(a: string, b: string): boolean {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}

/** 解析目标版本：缺省用 nextVersion 推演；显式版本允许带 v 前缀，必须大于当前版本。 */
export function parseTargetVersion(arg: string | undefined, current: string): string {
  if (!arg) return nextVersion(current);
  const candidate = arg.replace(/^v/, '');
  if (!STABLE_VERSION_PATTERN.test(candidate)) throw new Error(`Invalid target version: ${arg}`);
  if (!isGreaterVersion(candidate, current)) {
    throw new Error(`Target version ${candidate} must be greater than current ${current}`);
  }
  return candidate;
}

/** 三个 package.json 的版本字段推进；JSON.stringify 保持原有键序与两空格缩进。 */
export function bumpPackageJson(content: string, version: string): string {
  const manifest = JSON.parse(content) as { version?: string };
  if (typeof manifest.version !== 'string') throw new Error('Manifest is missing a version field');
  manifest.version = version;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** CLI 展示版本推进；找不到声明即失败，避免静默漏改。 */
export function bumpCliVersionSource(content: string, version: string): string {
  const updated = content.replace(/(CLI_VERSION\s*=\s*['"])([^'"]+)(['"])/, `$1${version}$3`);
  if (updated === content) throw new Error('CLI_VERSION declaration not found');
  return updated;
}

interface VersionChange {
  file: string;
  original: string;
  updated: string;
}

/** 先计算所有版本文件的新内容；任何源文件无效时均不写入。 */
export function prepareVersionBump(root: string, version: string): VersionChange[] {
  const changes: VersionChange[] = VERSION_MANIFEST_FILES.map((file) => {
    const original = fs.readFileSync(path.join(root, file), 'utf8');
    return { file, original, updated: bumpPackageJson(original, version) };
  });
  const original = fs.readFileSync(path.join(root, CLI_VERSION_FILE), 'utf8');
  changes.push({
    file: CLI_VERSION_FILE,
    original,
    updated: bumpCliVersionSource(original, version),
  });
  return changes;
}

/** 仅恢复仍保持脚本写入内容的文件，避免覆盖运行期间的其他修改。 */
export function restoreVersionBump(root: string, changes: VersionChange[]): string[] {
  const conflicts: string[] = [];
  for (const { file, original, updated } of changes) {
    const full = path.join(root, file);
    try {
      const current = fs.readFileSync(full, 'utf8');
      if (current === updated) fs.writeFileSync(full, original);
      else if (current !== original) conflicts.push(file);
    } catch {
      conflicts.push(file);
    }
  }
  return conflicts;
}

/** 发布说明骨架；占位符必须在发布前替换为真实内容（CI 与 GitHub Release 都取自该文件）。 */
export function releaseNotesSkeleton(tag: string): string {
  const version = tag.slice(1);
  return `# Kapibala ${tag}：<发布主题，发布前替换>

本版交付 <发布前补全：一段话概述>，已于 <发布日期> 发布至 npm 与 [GitHub Release](https://github.com/tedburner/kapibala/releases/tag/${tag})。

- <!-- 交付要点：能力、边界、已知限制，逐条列出 -->

升级前请阅读 [${tag} 迁移说明](../migration/${tag}.md)。
<!-- 若本版没有迁移说明，删除上一行；如有验收记录，可参照 v0.0.3 的结构补充链接 -->

需要 Node.js 20 或更高版本。按版本安装：

\`\`\`bash
npx @kiturone/kapibala-cli@${version}
npm install -g @kiturone/kapibala-cli@${version}
npm install @kiturone/kapibala@${version}
\`\`\`
`;
}

// ---------- Git 与命令执行 ----------

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function git(args: string[], capture: boolean, timeout?: number): RunResult {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** 执行并返回裁剪后的 stdout；非零退出即抛错。 */
function gitOut(args: string[], timeout?: number): string {
  const result = git(args, true, timeout);
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || result.status}`);
  }
  return result.stdout.trim();
}

/** 静默探测：退出码为零返回 true。 */
function gitOk(args: string[], timeout?: number): boolean {
  return git(args, true, timeout).status === 0;
}

/** 交给用户看的 git 操作（add/commit/tag/switch），输出透传。 */
function gitRun(args: string[]): void {
  const result = git(args, false);
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed with exit code ${result.status}`);
  }
}

function runPnpm(args: string[]): number {
  const result = spawnSync('pnpm', args, {
    encoding: 'utf8',
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function currentBranch(): string {
  return gitOut(['rev-parse', '--abbrev-ref', 'HEAD']);
}

function dirtyFiles(): string[] {
  return gitOut(['status', '--porcelain'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** 尽力同步远端引用；网络不可用时降级为本地判断。 */
function fetchOrigin(): boolean {
  return gitOk(['fetch', 'origin', '--quiet'], 30_000);
}

/** 远端获取失败时不使用可能过期的 origin/main 引用。 */
export function chooseBranchBase(fetched: boolean, hasOriginMain: boolean): 'origin/main' | 'main' {
  return fetched && hasOriginMain ? 'origin/main' : 'main';
}

// ---------- 流程 ----------

function createAndSwitch(name: string): void {
  if (gitOk(['show-ref', '--verify', '--quiet', `refs/heads/${name}`])) {
    throw new Error(`Branch ${name} already exists`);
  }
  const fetched = fetchOrigin();
  if (gitOk(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${name}`])) {
    throw new Error(`Remote branch origin/${name} already exists`);
  }
  const base = chooseBranchBase(
    fetched,
    gitOk(['rev-parse', '--verify', '--quiet', 'origin/main']),
  );
  if (!fetched) console.log('⚠️ 无法连接远端，基于本地 main 创建分支。');
  const dirty = dirtyFiles();
  if (dirty.length) {
    console.log(`⚠️ 工作区有未提交改动，将随切换带入新分支：\n  ${dirty.join('\n  ')}`);
  }
  gitRun(['switch', '-c', name, base]);
  console.log(`✅ 已创建并切换到 ${name}（基于 ${base}）`);
  console.log(`开发完成后合并回主干：git switch main && git merge --no-ff ${name}`);
}

function startBranch(prefix: BranchPrefix, topic: string | undefined): void {
  createAndSwitch(developmentBranchName(prefix, topic));
}

interface ReleaseOptions {
  target?: string;
  dryRun: boolean;
  yes: boolean;
  scaffold: boolean;
}

function resolveReleaseTag(target: string | undefined, root: string): string {
  const current = readWorkspaceVersion(root);
  return `v${parseTargetVersion(target, current)}`;
}

async function release(root: string, options: ReleaseOptions): Promise<void> {
  if (options.scaffold) {
    const tag = resolveReleaseTag(options.target, root);
    const notesPath = path.join(root, 'docs/releases', `${tag}.md`);
    if (fs.existsSync(notesPath))
      throw new Error(`Release notes already exist: docs/releases/${tag}.md`);
    fs.mkdirSync(path.dirname(notesPath), { recursive: true });
    fs.writeFileSync(notesPath, releaseNotesSkeleton(tag));
    console.log(`✅ 已生成发布说明骨架：docs/releases/${tag}.md`);
    console.log('请补全内容并手动提交，然后重新运行 pnpm release 完成发布。');
    return;
  }

  if (currentBranch() !== 'main') throw new Error('release 只能在 main 分支上执行');
  const dirty = dirtyFiles();
  if (dirty.length) {
    throw new Error(`工作区存在未提交改动，请先提交或暂存：\n  ${dirty.join('\n  ')}`);
  }
  if (fetchOrigin()) {
    const behind = Number(gitOut(['rev-list', '--count', 'main..origin/main']));
    if (behind > 0)
      throw new Error(`本地 main 落后 origin/main ${behind} 个提交，请先 git pull --ff-only`);
    const ahead = Number(gitOut(['rev-list', '--count', 'origin/main..main']));
    if (ahead > 0) console.log(`提示：本地 main 领先远端 ${ahead} 个提交，发布后需一并推送。`);
  } else {
    console.log('⚠️ 无法连接远端，跳过远端同步检查。');
  }

  const current = readWorkspaceVersion(root);
  const version = parseTargetVersion(options.target, current);
  const tag = `v${version}`;
  if (gitOk(['rev-parse', '-q', '--verify', `refs/tags/${tag}`])) {
    throw new Error(`Tag ${tag} already exists`);
  }
  const notesFile = `docs/releases/${tag}.md`;
  if (!fs.existsSync(path.join(root, notesFile))) {
    throw new Error(
      `缺少发布说明 ${notesFile}；请先撰写内容（可运行 pnpm flow release --scaffold 生成骨架）并提交。`,
    );
  }
  validateReleaseNotes(fs.readFileSync(path.join(root, notesFile), 'utf8'));

  if (options.dryRun) {
    console.log(`[dry-run] 版本：${current} → ${version}（标签 ${tag}）`);
    console.log(`[dry-run] 版本推进：${[...VERSION_MANIFEST_FILES, CLI_VERSION_FILE].join(', ')}`);
    console.log(`[dry-run] 发布说明：${notesFile}（要求已存在）`);
    console.log('[dry-run] 校验：pnpm verify（失败自动回滚版本改动）');
    console.log(`[dry-run] 提交：:bookmark: 发布 ${tag}`);
    console.log(`[dry-run] 标签：git tag -a ${tag} -m "Kapibala ${tag}"`);
    console.log(`[dry-run] 后续手动推送：git push origin main && git push origin ${tag}`);
    return;
  }

  // 非交互环境必须显式 --yes 才允许创建提交与标签。
  if (!options.yes && !process.stdin.isTTY) {
    throw new Error('非交互环境需要显式传入 --yes 才会创建提交与标签');
  }

  const changes = prepareVersionBump(root, version);
  const rollback = (): void => {
    const conflicts = restoreVersionBump(root, changes);
    if (conflicts.length) {
      throw new Error(`版本文件在校验期间发生其他修改，未覆盖：${conflicts.join(', ')}`);
    }
  };
  let cancelled = false;
  try {
    for (const { file, updated } of changes) fs.writeFileSync(path.join(root, file), updated);
    console.log('运行 pnpm verify（typecheck → test → lint）...');
    if (runPnpm(['verify']) !== 0) throw new Error('pnpm verify 未通过');

    if (!options.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(`确认创建发布提交并打标签 ${tag}？[y/N] `);
        cancelled = answer.trim().toLowerCase() !== 'y';
      } finally {
        rl.close();
      }
    }
  } catch (error) {
    try {
      rollback();
    } catch (rollbackError) {
      const reason = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new AggregateError([error, rollbackError], `发布中断，版本文件未能完全恢复：${reason}`);
    }
    throw error;
  }
  if (cancelled) {
    rollback();
    console.log('已取消，版本改动已回滚。');
    return;
  }

  gitRun(['add', '--', ...changes.map(({ file }) => file), notesFile]);
  gitRun(['commit', '-m', `:bookmark: 发布 ${tag}`]);
  try {
    gitRun(['tag', '-a', tag, '-m', `Kapibala ${tag}`]);
  } catch (error) {
    console.error('发布提交已创建，但标签创建失败，请手动处理后再推送。');
    throw error;
  }

  console.log(`✅ 已创建发布提交并打上标签 ${tag}（未推送）。`);
  console.log('后续请手动推送；tag 推送将触发 Actions 自动完成 npm 发布与 GitHub Release：');
  console.log('  git push origin main');
  console.log(`  git push origin ${tag}`);
}

function printUsage(): void {
  console.log(`Kapibala 分支与发布流程

用法：
  pnpm flow feat|fix|chore|docs [topic]   联网时从最新 origin/main、离线时从本地 main 切出并切换
                                          topic 省略时自动生成「日期-时分」分支名
  pnpm flow branch <name>                 按给定名称创建并切换
  pnpm flow release [version] [--dry-run] [--yes] [--scaffold]
                                          在 main 上推进版本 → pnpm verify → 发布提交 → 打 tag
  pnpm release [version]                  等价于 pnpm flow release

说明：
  - 版本推演遵循十进制位进位：0.0.9 → 0.1.0，0.9.9 → 1.0.0
  - 发布前必须先写好 docs/releases/vX.Y.Z.md（--scaffold 可生成骨架）
  - 本工具从不推送远端：git push origin main && git push origin vX.Y.Z 由你手动执行
  - tag 推送后 Actions 自动完成 verify、npm 发布与 GitHub Release`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const unknown = [...flags].filter(
    (flag) => !['--dry-run', '--yes', '--scaffold', '--help'].includes(flag),
  );
  if (unknown.length) throw new Error(`Unknown options: ${unknown.join(' ')}`);
  const [command] = argv;
  if (!command || flags.has('--help') || command === 'help') {
    printUsage();
    return;
  }
  const root = repoRoot();
  if (command === 'release') {
    const rest = argv.slice(1).filter((arg) => !arg.startsWith('--'));
    if (rest.length > 1) throw new Error('release 只接受一个可选版本参数');
    await release(root, {
      target: rest[0],
      dryRun: flags.has('--dry-run'),
      yes: flags.has('--yes'),
      scaffold: flags.has('--scaffold'),
    });
    return;
  }
  if ((BRANCH_PREFIXES as readonly string[]).includes(command)) {
    const extras = argv.slice(2).filter((arg) => !arg.startsWith('--'));
    if (extras.length) throw new Error(`Unexpected arguments: ${extras.join(' ')}`);
    startBranch(command as BranchPrefix, argv[1]);
    return;
  }
  if (command === 'branch') {
    if (!argv[1]) throw new Error('用法：pnpm flow branch <name>');
    const extras = argv.slice(2).filter((arg) => !arg.startsWith('--'));
    if (extras.length) throw new Error(`Unexpected arguments: ${extras.join(' ')}`);
    createAndSwitch(sanitizeBranchName(argv[1]));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
