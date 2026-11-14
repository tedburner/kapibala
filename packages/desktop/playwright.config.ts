import { defineConfig } from '@playwright/test';

/** 真 Electron 验收使用隔离 home 与本地 Provider，不读取个人凭证或访问付费模型。 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
});
