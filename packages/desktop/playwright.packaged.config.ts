import { defineConfig } from '@playwright/test';

/**
 * 已打包测试仅运行外部复制的应用，使用独立用户目录和受限 PATH，失败不降级为源码窗口。
 * 超时必须装下最坏冷启动链路：安装副本复制 + 首启 Defender 实时扫描（CI 实测握手可达分钟级）
 * + 完整对话验收流程。90 秒曾与 preload 就绪兜底同量级竞赛，把健康但慢的启动误判为死连接；
 * 这里放宽到 240 秒，覆盖 supervisor 两段 60 秒握手与后续流程，真正的失败由故障投递立即报错。
 */
export default defineConfig({
  testDir: './packaged-e2e',
  timeout: 240_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
});
