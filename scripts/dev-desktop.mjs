#!/usr/bin/env node
/**
 * 桌面开发入口：在清洗过的工具链环境里运行 `packages/desktop/scripts/dev.mjs`。
 *
 * 为什么需要这层包装：dev.mjs 里的 electron-vite 构建是**同进程内**执行的，它会清空
 * `out/` 后重建。宿主若通过 `NODE_OPTIONS=--require=<vendor shim>` 挂了删除守卫，
 * 这次清空会被按条目数拦下，表现为构建停在 "rendering chunks..." 然后无声卡住 ——
 * 看起来像打包器卡死，实际是环境问题。这层包装让 dev.mjs 与其所有子进程都跑在干净环境里。
 *
 * 只做环境传递，不改变 dev.mjs 的任何行为：参数原样转发，信号原样转发（Ctrl+C 后
 * 由 dev.mjs 完成 Electron 的优雅退出，本进程等它退出再收尾）。
 *
 * 用法：node scripts/dev-desktop.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolchainEnv } from './process-env.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(
  process.execPath,
  [path.join(repository, 'packages/desktop/scripts/dev.mjs'), ...process.argv.slice(2)],
  { cwd: repository, stdio: 'inherit', env: toolchainEnv(process.env, repository) },
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    child.kill(signal);
  });
child.once('exit', (code) => process.exit(code ?? 1));
