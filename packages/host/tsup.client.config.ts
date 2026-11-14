import { defineConfig } from 'tsup';

/** Node 客户端门面：protocol+transport 的组合导出；只清理自己的输出目录。 */
export default defineConfig({
  entry: { index: 'src/client/index.ts' },
  outDir: 'dist/client',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
});
