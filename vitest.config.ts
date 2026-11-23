import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/tests/**/*.test.ts', 'scripts/tests/**/*.test.ts'],
    // 单用例含真实进程、文件扫描与临时目录清理，默认 5s/10s 在并行压力下会把
    // 机器负载误判成断言失败；超时只用于兜底死锁，不是质量结论。
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 限制并发 worker：本仓库测试大量使用临时目录与真实子进程，过量并发会引发
    // Windows 句柄竞争（ENOTEMPTY/EPERM）与 CPU 饥饿，反而降低门禁可信度。
    maxWorkers: 4,
  },
});
