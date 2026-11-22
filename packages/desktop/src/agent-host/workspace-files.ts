import fs from 'node:fs';
import path from 'node:path';

/** 通用忽略目录：依赖、构建产物与版本库元数据一律不进补全清单。 */
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'coverage',
  'test-results',
  'playwright-report',
]);

/**
 * 工作区相对路径枚举：composer `@` 文件补全的数据源。
 *
 * 保证与边界：
 * - 只枚举路径，不读取文件内容；调用方负责先确认工作区已受信任（requireTrust）；
 * - **广度优先 + 逐层按名称排序**：浅层文件先于深层入列——深度优先加 readdir 原生
 *   顺序会让先走到的大子树吃满文件预算，根目录文件（如 update-all.sh）反而没被
 *   枚举到，且顺序随平台变化、不可复现；
 * - 条目数与深度双重预算：命中即停止并明示 `truncated`，调用方据此提示用户
 *   继续输入缩小范围；
 * - 通用忽略目录与点开头目录一律跳过。
 */
export function enumerateWorkspaceFiles(
  root: string,
  budgets: { maxFiles: number; maxDepth: number },
): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  // 队列元素：待枚举目录的绝对路径与它相对 root 的深度（root 为 0）。
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    if (files.length >= budgets.maxFiles) {
      truncated = true;
      break;
    }
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // 个别目录不可读（权限等）只跳过该目录，不让整份清单失败：补全是尽力而为的数据源。
      continue;
    }
    const directories: string[] = [];
    const directoryFiles: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
        directories.push(entry.name);
      } else if (entry.isFile()) {
        directoryFiles.push(entry.name);
      }
    }
    // 逐层排序后再产出：跨平台、跨机器的枚举顺序完全一致。
    directories.sort((a, b) => a.localeCompare(b));
    directoryFiles.sort((a, b) => a.localeCompare(b));
    for (const name of directoryFiles) {
      if (files.length >= budgets.maxFiles) {
        truncated = true;
        break;
      }
      files.push(path.relative(root, path.join(dir, name)));
    }
    if (files.length >= budgets.maxFiles) break;
    if (depth + 1 > budgets.maxDepth) {
      // 还有目录因深度预算没有展开：明示截断而不是静默缺失。
      if (directories.length > 0) truncated = true;
      continue;
    }
    for (const name of directories) {
      queue.push({ dir: path.join(dir, name), depth: depth + 1 });
    }
  }
  return { files, truncated };
}
