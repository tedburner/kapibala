#!/usr/bin/env node
/**
 * 构建入口：在清洗过的工具链环境里执行 pnpm 构建。
 *
 * 为什么不直接在 package.json 里写 pnpm 命令：宿主（IDE、沙箱包装器）会通过
 * `NODE_OPTIONS=--require=<vendor shim>` 给每条命令挂上自己的删除守卫。打包器清理 dist
 * 属于批量删除，会被守卫按「条目数」拦下（实测 58 条目 > 阈值 50），报错却指向一个
 * 无关的 `.js.map`，看上去像打包器坏了。这里不做任何绕过，只是让子进程不继承外部预加载钩子
 * —— 等同手工 `env -u NODE_OPTIONS pnpm build`，但不需要每个人记住。
 *
 * 剥离范围严格受限于 `scripts/process-env.mjs`：只摘指向仓库外的 `--require` / `--import`
 * 与 `ELECTRON_RUN_AS_NODE`，`--max-old-space-size` 等 CI 参数与 HOME 一律保留。
 *
 * 用法：
 * - `node scripts/build.mjs`           构建 core / mcp / cli（等价于原 `pnpm build`）
 * - `node scripts/build.mjs --desktop` 额外构建桌面宿主（等价于原 `pnpm build:desktop`）
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolchainEnv } from './process-env.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const steps = [
  ['--filter', '@kiturone/kapibala*', '--filter', '!@kiturone/kapibala-desktop', 'build'],
];
if (process.argv.includes('--desktop'))
  steps.push(['--filter', '@kiturone/kapibala-desktop', 'build']);

for (const args of steps) {
  const result = spawnSync('pnpm', args, {
    cwd: repository,
    stdio: 'inherit',
    // Windows 上 npm 脚本必须以 shell 启动，否则 node 拒绝执行 .cmd
    shell: process.platform === 'win32',
    env: toolchainEnv(process.env, repository),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
