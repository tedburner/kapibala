/**
 * @fileoverview `/worktrees` 命令：管理当前项目下的受管 Git Worktree（列表、创建、状态、Diff、冲突隔离合并、安全移除与孤儿清理）。
 *
 * 工程安全边界：
 * 1. 所有工作树操作均严格校验目标记录归属当前 `projectRoot`，拒绝跨项目越权访问；
 * 2. `merge` 遵循两阶段冲突隔离合并（先在工作树内预合并目标分支，冲突留在工作树内不污染主工作区，通过后再对主仓 `--ff-only`）；
 * 3. `remove` 默认执行三路脏状态预检（未提交文件、未合并提交、敏感 `.env*` 改动），仅在显式 `--force` 时强制清理。
 */

import { isSamePath } from '@kiturone/kapibala';
import { isProjectTrusted, loadSettings } from '@kiturone/kapibala-host/internal';
import { resolveCommandOutput } from '../command-output.js';
import type { CommandContext, CommandHandler } from './dispatcher.js';

const WORKTREES_USAGE =
  '/worktrees [list | create [name] [--branch <branch>] [--base <ref>] | status <id> | diff <id> | merge <id> [--commit <msg>] | remove <id> [--force] | prune]';

function tokenizeWorktreesArgs(raw: string): { tokens: string[]; unclosedQuote: boolean } {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let sawQuote = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      sawQuote = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0 || sawQuote) {
        tokens.push(current);
        current = '';
        sawQuote = false;
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0 || sawQuote) {
    tokens.push(current);
  }
  return { tokens, unclosedQuote: quote !== null };
}

/**
 * 判定 `/worktrees` 单次调用是否产生状态变更（供 `CommandDispatcher` 在运行忙碌期拦截写操作）。
 */
export function isWorktreesCommandMutating(args: string[]): boolean {
  const raw = (args[0] ?? '').trim();
  if (!raw) return false;
  const { tokens } = tokenizeWorktreesArgs(raw);
  const sub = tokens[0]?.toLowerCase() ?? 'list';
  return sub === 'create' || sub === 'merge' || sub === 'remove' || sub === 'prune';
}

/**
 * 校验 `/worktrees` 命令原始尾部参数（`rawTail: true` 模式下 `args` 为至多 1 项整串）。
 */
export function validateWorktreesCommandArgs(args: string[]): string | undefined {
  const raw = (args[0] ?? '').trim();
  if (!raw) return undefined;
  const { tokens, unclosedQuote } = tokenizeWorktreesArgs(raw);
  if (unclosedQuote) return '参数引号未闭合';
  const sub = tokens[0]?.toLowerCase();
  if (!sub || sub === 'list' || sub === 'prune') {
    return tokens.length <= 1 ? undefined : `用法: /worktrees ${sub ?? 'list'}`;
  }
  if (sub === 'status' || sub === 'diff') {
    return tokens.length === 2 && tokens[1]?.trim() ? undefined : `用法: /worktrees ${sub} <id>`;
  }
  if (sub === 'create') {
    let idx = 1;
    let positional = 0;
    while (idx < tokens.length) {
      const tok = tokens[idx]!;
      if (tok === '--branch' || tok === '--base') {
        if (!tokens[idx + 1]?.trim()) return `选项 ${tok} 需要提供参数值`;
        idx += 2;
        continue;
      }
      if (tok.startsWith('--')) return `未知选项: ${tok}`;
      positional += 1;
      if (positional > 1)
        return '用法: /worktrees create [name] [--branch <branch>] [--base <ref>]';
      idx += 1;
    }
    return undefined;
  }
  if (sub === 'merge') {
    if (tokens.length < 2 || !tokens[1]?.trim() || tokens[1]!.startsWith('--')) {
      return '用法: /worktrees merge <id> [--commit <msg>]';
    }
    if (tokens.length === 2) return undefined;
    if (tokens[2] === '--commit' && tokens.length >= 4) {
      const msg = tokens.slice(3).join(' ').trim();
      return msg ? undefined : '提交说明不能为空';
    }
    return '用法: /worktrees merge <id> [--commit <msg>]';
  }
  if (sub === 'remove') {
    const rest = tokens.slice(1);
    const nonFlags = rest.filter((item) => item !== '--force');
    const flagCount = rest.length - nonFlags.length;
    return nonFlags.length === 1 && nonFlags[0]?.trim() && flagCount <= 1
      ? undefined
      : '用法: /worktrees remove <id> [--force]';
  }
  return `未知子命令 '${tokens[0]}'`;
}

function ensureProjectTrusted(ctx: CommandContext, projectRoot: string): boolean {
  const globalSettings = loadSettings({
    cwd: projectRoot,
    homeDir: ctx.homeDir,
    includeProject: false,
  }).settings;
  return (
    isProjectTrusted(ctx.settings, projectRoot) || isProjectTrusted(globalSettings, projectRoot)
  );
}

/**
 * `/worktrees` 命令处理器：CLI REPL 与桌面斜杠命令面共享同一套受管工作树管理逻辑。
 */
export const worktreesCommand: CommandHandler = async (args, ctx) => {
  const output = resolveCommandOutput(ctx);
  const service = ctx.worktrees;
  if (!service) {
    output.log('当前宿主未启用受管 Git Worktree 服务。');
    return;
  }

  const projectRoot =
    ctx.projectRoot ?? ctx.controller?.manager.project.projectRoot ?? ctx.session.workspaceRoot;
  const raw = (args[0] ?? '').trim();
  const { tokens } = tokenizeWorktreesArgs(raw);
  const sub = (tokens[0] ?? 'list').toLowerCase();

  if (sub === 'list') {
    const items = service.list(projectRoot);
    if (items.length === 0) {
      output.log(
        '当前项目暂无受管 Git Worktree。可用 /worktrees create [name] 或 /delegate ... --worktree 创建。',
      );
      return;
    }
    output.log(`受管 Git Worktree 列表（共 ${items.length} 个）:`);
    for (const item of items) {
      output.log(
        `• [${item.id}] ⎇ ${item.branch} (基线: ${item.baseRef} @ ${item.baseCommit.slice(0, 8)}) -> ${item.worktreePath}`,
      );
    }
    return;
  }

  if (isWorktreesCommandMutating(args) && !ensureProjectTrusted(ctx, projectRoot)) {
    output.error(`当前项目 (${projectRoot}) 尚未被信任，拒绝执行工作树变更操作。`);
    return;
  }

  if (sub === 'create') {
    let name: string | undefined;
    let branch: string | undefined;
    let baseRef: string | undefined;
    for (let i = 1; i < tokens.length; i++) {
      const tok = tokens[i]!;
      if (tok === '--branch') {
        branch = tokens[++i]?.trim();
      } else if (tok === '--base') {
        baseRef = tokens[++i]?.trim();
      } else {
        name = tok.trim();
      }
    }
    const created = await service.create({
      projectRoot,
      ...(name ? { name } : {}),
      ...(branch ? { branch } : {}),
      ...(baseRef ? { baseRef } : {}),
    });
    output.log(
      `已创建受管工作树 [${created.binding.id}] ⎇ ${created.binding.branch} -> ${created.binding.worktreePath}`,
    );
    if (created.copiedIncludeFiles.length > 0) {
      output.log(`已按 .worktreeinclude 拷贝 ${created.copiedIncludeFiles.length} 个环境文件。`);
    }
    return;
  }

  if (sub === 'prune') {
    const { prunedIds } = await service.prune(projectRoot);
    if (prunedIds.length === 0) {
      output.log('未发现残留孤儿工作树记录。');
    } else {
      output.log(`已清理 ${prunedIds.length} 条孤儿工作树记录: ${prunedIds.join(', ')}`);
    }
    return;
  }

  const targetId =
    sub === 'remove' ? tokens.slice(1).find((item) => item !== '--force')! : tokens[1]!;
  const owned = service.get(targetId);
  if (!owned || !isSamePath(owned.projectRoot, projectRoot)) {
    output.error(`未在当前项目中找到受管工作树 '${targetId}'。`);
    return;
  }

  if (sub === 'status') {
    const st = await service.status(owned.id);
    const stateBadge = !st.exists
      ? '目录缺失'
      : !st.linkVerified
        ? '回链校验失败'
        : st.dirty
          ? '有未提交改动'
          : '干净';
    output.log(
      `工作树 [${st.id}] ⎇ ${st.branch} · ${stateBadge} · 领先 ${st.aheadCount} / 落后 ${st.behindCount} (${st.baseRef}) · +${st.additions} -${st.deletions}`,
    );
    output.log(`路径: ${st.worktreePath}`);
    for (const file of st.changedFiles) {
      const statText = file.binary ? 'binary' : `+${file.additions} -${file.deletions}`;
      output.log(`  [${file.status}] ${file.path} (${statText})`);
    }
    return;
  }

  if (sub === 'diff') {
    const diff = await service.diff(owned.id);
    if (diff.files.length === 0) {
      output.log(`工作树 [${owned.id}] 相对基线 (${diff.baseCommit.slice(0, 8)}) 暂无变更。`);
      return;
    }
    output.log(
      `工作树 [${diff.id}] ⎇ ${diff.branch} 变更明细（共 ${diff.files.length} 个文件，+${diff.additions} -${diff.deletions}）:`,
    );
    for (const file of diff.files) {
      const statText = file.binary ? 'binary' : `+${file.additions} -${file.deletions}`;
      output.log(`• [${file.status}] ${file.path} (${statText})`);
      if (file.patch) {
        output.log(file.patch.trimEnd());
      }
    }
    return;
  }

  if (sub === 'merge') {
    const commitMsg = tokens[2] === '--commit' ? tokens.slice(3).join(' ').trim() : undefined;
    const preview = await service.previewMerge(owned.id);
    if (!preview.canApply) {
      output.error(
        `无法将工作树 [${owned.id}] 合并回主工作区: ${preview.blockingReason ?? '状态不满足合并条件'}`,
      );
      return;
    }
    const outcome = await service.applyMerge({
      id: owned.id,
      previewToken: preview.previewToken,
      ...(commitMsg ? { commitMessage: commitMsg } : {}),
    });
    if (outcome.status === 'conflict') {
      output.error(
        `合并发生代码冲突（冲突已隔离在工作树 ${owned.worktreePath} 内，主工作区毫发无损）:`,
      );
      for (const file of outcome.conflictedFiles) {
        output.error(`  - ${file}`);
      }
      output.error('请在工作树会话中解决冲突后再重新执行 /worktrees merge。');
      return;
    }
    output.log(
      `已将工作树 [${owned.id}] (⎇ ${owned.branch}) 原子快进合并至主分支 ${outcome.targetBranch} (${outcome.mergedCommit.slice(0, 8)})。`,
    );
    return;
  }

  if (sub === 'remove') {
    const force = tokens.includes('--force');
    const outcome = await service.remove({
      id: owned.id,
      force,
      ...(ctx.onBeforeRemoveWorktree ? { onBeforeRemove: ctx.onBeforeRemoveWorktree } : {}),
    });
    if (!outcome.removed) {
      const reasonMap: Record<typeof outcome.reason, string> = {
        dirty: '存在未提交或未跟踪文件',
        unmerged_commits: '存在尚未合入基线分支的提交',
        at_risk_ignored_files: '存在相对主仓已修改的敏感环境文件（如 .env*）',
      };
      output.error(`拒绝移除受管工作树 [${owned.id}]：${reasonMap[outcome.reason]}:`);
      for (const detail of outcome.details) {
        output.error(`  - ${detail}`);
      }
      output.error(`若确认丢弃上述内容，请执行 /worktrees remove ${owned.id} --force。`);
      return;
    }
    output.log(`已安全移除受管工作树 [${owned.id}]。`);
  }
};
