import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 优先使用 Git 工作树根作为项目指令起点；没有 Git 时退回当前目录。 */
export function detectProjectRoot(cwd: string): string {
  const current = fs.realpathSync(cwd);
  try {
    const output = execFileSync('git', ['-C', current, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const root = fs.realpathSync(path.resolve(output));
    const relative = path.relative(root, current);
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      ? current
      : root;
  } catch {
    return current;
  }
}
