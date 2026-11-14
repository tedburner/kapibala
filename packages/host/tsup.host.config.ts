import { defineConfig } from 'tsup';

/**
 * 宿主装配子路径：公共窄入口（index）与应用层内部门面（internal）。
 * internal 仅经 `@kiturone/kapibala-host/internal` 供仓库内 CLI 应用层消费。
 */
export default defineConfig({
  entry: { index: 'src/host/index.ts', internal: 'src/host/internal.ts' },
  outDir: 'dist/host',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
});
