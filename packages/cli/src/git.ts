import { execFileSync } from 'node:child_process';

/** 分支读取的可注入实现（缺省 execFileSync 调 git）；同步签名，失败以抛错表达。 */
export type GitBranchReader = (cwd: string) => string;

function readGitBranch(cwd: string): string {
  return execFileSync('git', ['branch', '--show-current'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 500,
    windowsHide: true,
  });
}

/**
 * 读取指定工作目录当前所在的 Git 分支。
 *
 * 非 Git 目录、detached HEAD、Git 不可用或探测超时时返回 undefined，
 * 状态展示不得因为工作区信息探测失败而中断正常对话。
 */
export function getCurrentGitBranch(
  cwd = process.cwd(),
  readBranch: GitBranchReader = readGitBranch,
): string | undefined {
  try {
    const branch = readBranch(cwd).trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}
