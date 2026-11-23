import type { ShellScope } from '../security/permissions.js';
import { classifyShellCommandClass, toShellCommandSafety } from './command-class.js';

/**
 * 公开的命令安全分级（wire、审计与公共 API 快照沿用此三值）：
 * - `safe`：在 workspace 边界内可控，可在 Auto 模式自动放行；
 * - `unsafe`：网络、破坏性、越界或提权等明确危险，必须询问；
 * - `unknown`：结构无法静态判读（命令替换、变量、未收录程序等），按 fail-closed 询问。
 *
 * 类别判定与映射的唯一实现在 `command-class.ts`；本层只保留兼容入口，不得在此重新维护程序表。
 */
export type ShellCommandSafety = 'safe' | 'unsafe' | 'unknown';

/**
 * 依据 `ShellScope` 的最终执行目标做保守分级。
 *
 * 边界：
 * - cwd 必须物理落在 rootDir 内，否则 `unsafe`；
 * - 多段命令取最严：`escape` > `destructive` > `network` > `unknown` > `workspace-write`
 *   > `vcs-write` > `read`；
 * - 本函数不读文件系统，脚本清洁度与路径存在性由宿主在执行前另行确认。
 */
export function classifyShellCommandSafety(shell: ShellScope, rootDir: string): ShellCommandSafety {
  return toShellCommandSafety(classifyShellCommandClass(shell, rootDir));
}
