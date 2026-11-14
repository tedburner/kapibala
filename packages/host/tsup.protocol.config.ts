import { defineConfig } from 'tsup';

/** 协议是独立浏览器子路径：无 Node/终端依赖，导入不初始化宿主或读取配置。 */
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
