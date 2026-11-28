import type { ManagedSession, SessionManager, SessionWorktreeBinding } from '@kiturone/kapibala';

/** CLI 启动阶段解析出的 `-w` / `--worktree [branch]` 配置。 */
export interface StartupWorktreeOption {
  readonly enabled: boolean;
  readonly branch?: string;
}

/** 启动会话的互斥与恢复控制项。 */
export interface SessionStartupOptions {
  readonly continue?: boolean;
  readonly resume?: string;
  readonly worktree?: boolean | StartupWorktreeOption;
}

const VALUE_TAKING_FLAGS = new Set([
  '-m',
  '--model',
  '--role',
  '--base-url',
  '--api-key',
  '-p',
  '--prompt',
  '--permission',
  '--shell',
  '--resume',
  '--output-detail',
]);

/**
 * 校验候选字符串是否为合法的短 Git 分支名（兼容 `git check-ref-format --branch` 核心约束且不含空白与 CJK）。
 *
 * 设计取舍：用于在 `kpbl -w <arg>` 单参数场景下无歧义区分分支名（如 `feat/auth`、`my-branch`）与自然语言单次提问（如 `"请重构目录"`、`"explain this"`）。
 */
export function isValidGitBranchSlug(value: string): boolean {
  if (!value || value.length > 100) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return false;
  if (value === '@' || value.startsWith('-')) return false;
  if (
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.startsWith('.') ||
    value.endsWith('.')
  ) {
    return false;
  }
  if (value.includes('..') || value.includes('//') || value.includes('@{')) {
    return false;
  }
  for (const segment of value.split('/')) {
    if (!segment || segment.startsWith('.') || segment.endsWith('.lock')) {
      return false;
    }
  }
  return true;
}

/**
 * 在交给 `minimist` 前从原始 `argv` 中无歧义提取 `-w` / `--worktree [branch]`：
 * - 支持 `--worktree`、`-w`（自动分支）与 `--worktree=<branch>` / `-w=<branch>`；
 * - 支持 `-w <branch>` 后跟 `-p <prompt>` 或第二个位置参数（任务提示词）；
 * - 若 `-w` 后仅跟唯一非选项参数且未传 `-p`/`--prompt`：仅当该参数满足合法短分支名（无空白、无 CJK、无非法 Git ref 标点）时作为分支名，否则将 `-w` 视为自动分支布尔开关并保留该参数作为单次提问。
 */
export function extractWorktreeCliOption(argv: readonly string[]): {
  readonly normalizedArgv: string[];
  readonly worktree?: StartupWorktreeOption;
} {
  let hasExplicitPromptFlag = false;
  const positionalIndices: number[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      for (let j = i + 1; j < argv.length; j++) positionalIndices.push(j);
      break;
    }
    if (
      token === '-p' ||
      token === '--prompt' ||
      token.startsWith('--prompt=') ||
      (token.startsWith('-p') && token.length > 2 && !token.startsWith('--'))
    ) {
      hasExplicitPromptFlag = true;
    }
    if (VALUE_TAKING_FLAGS.has(token)) {
      i += 1;
      continue;
    }
    if (token === '-w' || token === '--worktree') {
      continue;
    }
    if (token.startsWith('-')) {
      continue;
    }
    positionalIndices.push(i);
  }

  const normalizedArgv: string[] = [];
  let worktree: StartupWorktreeOption | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      normalizedArgv.push(...argv.slice(i));
      break;
    }
    if (VALUE_TAKING_FLAGS.has(token)) {
      normalizedArgv.push(token);
      if (i + 1 < argv.length) {
        normalizedArgv.push(argv[++i]!);
      }
      continue;
    }
    if (token.startsWith('--worktree=') || token.startsWith('-w=')) {
      const eqIdx = token.indexOf('=');
      const branchVal = token.slice(eqIdx + 1);
      worktree = { enabled: true, branch: branchVal };
      continue;
    }
    if (token === '-w' || token === '--worktree') {
      const next = argv[i + 1];
      if (next !== undefined && next !== '--' && !next.startsWith('-')) {
        const otherPositionals = positionalIndices.filter((idx) => idx !== i + 1);
        if (hasExplicitPromptFlag || otherPositionals.length > 0) {
          worktree = { enabled: true, branch: next };
          i += 1;
          continue;
        }
        if (isValidGitBranchSlug(next)) {
          worktree = { enabled: true, branch: next };
          i += 1;
          continue;
        }
      }
      worktree = worktree ?? { enabled: true };
      continue;
    }
    normalizedArgv.push(token);
  }

  return {
    normalizedArgv,
    ...(worktree ? { worktree } : {}),
  };
}

/** 启动参数互斥与缺值校验，必须在创建会话或配置向导之前执行。 */
export function validateSessionStartup(options: SessionStartupOptions): void {
  if (options.continue && options.resume !== undefined)
    throw new Error('--continue 与 --resume 不能同时指定');
  if (options.resume !== undefined && !options.resume.trim())
    throw new Error('--resume 需要会话 ID 或唯一前缀');
  const worktreeEnabled =
    typeof options.worktree === 'object' ? options.worktree.enabled : Boolean(options.worktree);
  const worktreeBranch = typeof options.worktree === 'object' ? options.worktree.branch : undefined;
  if (worktreeEnabled && (options.continue || options.resume !== undefined)) {
    throw new Error('--worktree 不能与 --continue 或 --resume 同时指定');
  }
  if (worktreeBranch !== undefined) {
    const trimmed = worktreeBranch.trim();
    if (!trimmed) {
      throw new Error('--worktree 分支名称不能为空');
    }
    if (!isValidGitBranchSlug(trimmed)) {
      throw new Error(`--worktree 分支名称不合法: ${trimmed}`);
    }
  }
}

/** 默认隔离新建；显式恢复失败不替换为空会话，继续最近会话由 Core 确定有内容的目标。 */
export async function openStartupSession(
  manager: SessionManager,
  options: SessionStartupOptions & { readonly worktreeBinding?: SessionWorktreeBinding },
): Promise<ManagedSession> {
  validateSessionStartup(options);
  if (options.resume !== undefined)
    return manager.open(options.resume, { autoUpgradeLegacy: true });
  if (options.continue) return manager.continueRecent();
  return manager.create(
    options.worktreeBinding ? { worktree: options.worktreeBinding } : undefined,
  );
}
