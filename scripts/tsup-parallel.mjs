#!/usr/bin/env node
/**
 * 并行执行多个 tsup 配置。
 *
 * 存在的理由：host 与 cli 各有 5–6 个互不重叠的输出目录，逐个串行 tsup 让
 * 全量构建多等数秒。这里按配置并发拉起 tsup，默认并发取 CPU 核数并上限 4，
 * 避免 CI 双核机器上把内存与 IO 打满。
 *
 * 边界：
 * - 只负责并行调度，不改变任何 tsup 配置；DTS 与产物内容仍由各配置决定。
 * - 输出目录必须互不重叠，且不能有 clean 落在其它配置输出目录的父级
 *   （root 级 clean 由调用方先单独构建一次）。
 * - 任一配置失败时立即返回非零，由 package script 让 pnpm 构建失败。
 *
 * 用法（cwd 为包目录）：
 *   node ../../scripts/tsup-parallel.mjs tsup.a.config.ts tsup.b.config.ts
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const cwd = process.cwd();
const requireFromCwd = createRequire(path.join(cwd, 'package.json'));
const tsupPackage = requireFromCwd('tsup/package.json');
const tsupBin = path.resolve(
  path.dirname(requireFromCwd.resolve('tsup/package.json')),
  typeof tsupPackage.bin === 'string' ? tsupPackage.bin : tsupPackage.bin.tsup,
);

const configs = process.argv.slice(2);
if (configs.length === 0) {
  console.error('用法: node scripts/tsup-parallel.mjs <tsup.config.ts...>');
  process.exit(2);
}
const cores =
  typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
const concurrency = Math.max(1, Math.min(4, cores, configs.length));

/** 启动单个 tsup；stdio 直通，保留原有构建日志。 */
function run(config) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsupBin, '--config', config], {
      cwd,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', (error) => resolve({ config, code: 1, error }));
    child.on('exit', (code, signal) => resolve({ config, code: code ?? 1, signal }));
  });
}

const pending = [...configs];
const failures = [];
let running = 0;
await new Promise((resolve) => {
  const launchNext = () => {
    while (running < concurrency && pending.length > 0 && failures.length === 0) {
      const config = pending.shift();
      running++;
      void run(config).then((result) => {
        running--;
        if (result.code !== 0) {
          failures.push(result);
          console.error(`[tsup-parallel] ${config} 构建失败（${result.signal ?? result.code}）`);
        }
        if (running === 0 && (pending.length === 0 || failures.length > 0)) resolve();
        else launchNext();
      });
    }
    if (running === 0 && pending.length === 0) resolve();
  };
  launchNext();
});
if (failures.length > 0) process.exit(1);
