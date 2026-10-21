import { defineConfig } from 'tsup';

/** 协议是独立浏览器子路径，清理范围不得覆盖 CLI 或 view-model 构建。 */
export default defineConfig({
  entry: { index: 'src/protocol/index.ts' },
  outDir: 'dist/protocol',
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  tsconfig: 'tsconfig.protocol.json',
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
});
