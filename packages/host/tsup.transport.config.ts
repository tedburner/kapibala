import { defineConfig } from 'tsup';

/** 传输层子路径：本地 socket / stdio / RPC 与帧协议；只清理自己的输出目录。 */
export default defineConfig({
  entry: { index: 'src/transport/index.ts' },
  outDir: 'dist/transport',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
});
