import { defineConfig } from 'tsup';

/** 独立浏览器展示构建；仅清理自己的输出目录，不继承可执行入口的 shebang。 */
export default defineConfig({
  entry: { index: 'src/view-model/index.ts' },
  outDir: 'dist/view-model',
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  tsconfig: 'tsconfig.view-model.json',
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
});
