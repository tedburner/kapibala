import { defineConfig } from 'tsup';

/** 包根入口：Node 宿主进程消费的窄转发面；只清理自己的输出目录。 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
});
