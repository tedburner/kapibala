import { defineConfig } from '@playwright/test';

/** 已打包测试仅运行外部复制的应用，使用独立用户目录和受限 PATH，失败不降级为源码窗口。 */
export default defineConfig({
  testDir: './packaged-e2e',
  timeout: 90_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
});
