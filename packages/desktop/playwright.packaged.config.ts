import { defineConfig } from '@playwright/test';

/**
 * 已打包测试仅运行外部复制的应用，使用独立用户目录和受限 PATH，失败不降级为源码窗口。
 * 超时给最坏冷启动链路留足余量：安装副本复制 + 首次 asar 解包 + 完整对话验收流程，并覆盖
 * supervisor 两段 60 秒握手，避免与 preload 就绪兜底同量级竞赛；真正的失败由故障投递立即报错。
 * 注意：Windows CI 的稳定失败并非冷启动慢，而是 8.3 短名里的 ~ 被 pathToFileURL 编码成 %7E、
 * 与 Chromium 帧 URL 的字面 ~ 不等，kpbl:ready 守卫静默拒绝（见 main/url.ts 的 normalizeUrl，
 * 安装目录刻意带 ~ 作回归）；放宽超时不是该失败的修复。
 */
export default defineConfig({
  testDir: './packaged-e2e',
  timeout: 240_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
});
