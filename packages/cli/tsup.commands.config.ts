import { defineConfig } from 'tsup';

/**
 * 斜杠命令系统子路径构建：CLI 与桌面共用的分发器装配面。
 * noExternal 把宿主层（CommandContext 依赖的 UserSettings 等）内联进产物；
 * dts 从源码内联，发布包自包含，npm 消费者不感知工作区私有依赖。
 */
export default defineConfig({
  entry: { index: 'src/commands/index.ts' },
  outDir: 'dist/commands',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: { resolve: ['@kiturone/kapibala-host'] },
  clean: true,
  splitting: false,
  sourcemap: true,
  noExternal: ['@kiturone/kapibala-host'],
});
