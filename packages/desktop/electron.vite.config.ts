import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'electron-vite';
import { type BundledLicense, collectBundledLicenses } from './scripts/bundle-notices.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const vendorNotices = JSON.parse(
  fs.readFileSync(path.join(root, 'licenses/kumo-2.15.0-vendors.json'), 'utf8'),
) as { owner: string; version: string; entries: BundledLicense[] };
if (
  vendorNotices.owner !== '@cloudflare/kumo' ||
  vendorNotices.version !==
    JSON.parse(fs.readFileSync(require.resolve('@cloudflare/kumo/package.json'), 'utf8')).version
)
  throw new Error('VENDOR_NOTICE_VERSION_MISMATCH');
// Preload 与 Renderer 内联的第三方源码也属于分发内容；编译期输出无绝对路径的许可附件。
const bundleNotices = () => ({
  name: 'kapibala-bundle-notices',
  generateBundle(this: {
    getModuleIds(): IterableIterator<string>;
    emitFile(asset: { type: 'asset'; fileName: string; source: string }): void;
  }) {
    this.emitFile({
      type: 'asset',
      fileName: 'bundle-licenses.json',
      source: JSON.stringify(
        collectBundledLicenses(
          [...this.getModuleIds(), require.resolve('tailwindcss/package.json')],
          vendorNotices.entries,
        ),
        null,
        2,
      ),
    });
  },
});
/** Main 与 utility Host 各自入口；sandbox Preload 内联依赖并只保留有限 Electron require。 */
export default defineConfig({
  main: {
    root,
    plugins: [
      {
        name: 'kapibala-native-icon',
        writeBundle() {
          fs.copyFileSync(
            path.resolve(root, '../../assets/icon.png'),
            path.join(root, 'out/main/icon.png'),
          );
        },
      },
    ],
    build: {
      outDir: path.join(root, 'out/main'),
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: path.join(root, 'src/main/index.ts'),
          'agent-host': path.join(root, 'src/agent-host/index.ts'),
        },
        output: { format: 'es', entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    root,
    plugins: [bundleNotices()],
    build: {
      outDir: path.join(root, 'out/preload'),
      externalizeDeps: false,
      rollupOptions: {
        input: path.join(root, 'src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs', inlineDynamicImports: true },
        external: ['electron'],
      },
    },
  },
  renderer: {
    root: path.join(root, 'src/renderer'),
    publicDir: path.join(root, 'src/renderer/public'),
    // 品牌资产只保留 assets/ 一份真源；Renderer 通过别名引用，避免复制派生文件造成漂移。
    resolve: { alias: { '@kapibala-assets': path.resolve(root, '../../assets') } },
    plugins: [tailwindcss(), bundleNotices()],
    build: {
      outDir: path.join(root, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: { input: path.join(root, 'src/renderer/index.html') },
    },
  },
});
