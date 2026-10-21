import { defineConfig } from 'tsup';

/** Node 客户端不带 CLI shebang，也不导入启动入口；清理只作用于自身目录。 */
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
