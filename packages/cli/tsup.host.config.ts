import { defineConfig } from 'tsup';

/** Node 20 宿主独立构建；不带 CLI shebang，清理仅限自身目录，声明随包发布。 */
export default defineConfig({
  entry: { index: 'src/host/index.ts' },
  outDir: 'dist/host',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
});
