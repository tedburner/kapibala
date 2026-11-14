import { defineConfig } from 'tsup';

/**
 * 宿主层兼容 barrel：仅转发 @kiturone/kapibala-host 的公共导出面。
 * noExternal 把宿主层内联进本包 dist，npm 消费者不需要安装未发布的宿主包。
 */
export default defineConfig({
  entry: { index: 'src/host/index.ts' },
  outDir: 'dist/host',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: { resolve: ['@kiturone/kapibala-host'] },
  clean: true,
  splitting: false,
  sourcemap: true,
  noExternal: ['@kiturone/kapibala-host'],
});
