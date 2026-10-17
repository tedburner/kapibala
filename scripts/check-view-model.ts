import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 独立浏览器构建与 ESM 导入的检查结果；只记录产物事实，不启动 CLI 或会话。 */
export interface ViewModelArtifactResult {
  readonly exports: readonly string[];
  readonly browserBytes: number;
}

const importProbe = `
const { readFileSync } = await import('node:fs');
const targets = JSON.parse(readFileSync(0, 'utf8'));
const stdout = process.stdout;
const stderr = process.stderr;
const listeners = () => process.eventNames().map(name => [String(name), process.listenerCount(name)]).sort();
const beforeListeners = JSON.stringify(listeners());
const beforeGlobals = JSON.stringify(Object.getOwnPropertyNames(globalThis).sort());
let names;
for (const target of targets) {
  const loaded = await import(target);
  const current = Object.keys(loaded).sort();
  if (names && JSON.stringify(names) !== JSON.stringify(current)) throw new Error('export mismatch');
  names = current;
}
await new Promise(resolve => setImmediate(resolve));
if (JSON.stringify(listeners()) !== beforeListeners ||
    JSON.stringify(Object.getOwnPropertyNames(globalThis).sort()) !== beforeGlobals) {
  throw new Error('side-effect detected during ViewModel import');
}
stdout.write(JSON.stringify({ exports: names }));
`;

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * 校验发布 manifest 的独立子路径、声明与 ESM，实际进行 browser 目标打包并在隔离进程导入两份产物。
 * 构建复用 CLI 已安装 tsup 的 esbuild，不安装工具；依赖闭包必须完全留在独立展示产物目录，不能偷偷拉入根入口。
 * 导入检查拒绝额外输出、信号/事件监听变化和全局污染，不运行 CLI root/bin；超时也视为失败。
 * 这是自动化的浏览器目标兼容检查，不代替真实浏览器引擎、Node 20 安装或 tarball 平台验收。
 */
export async function checkViewModelArtifact(
  cliRoot = path.join(repositoryRoot, 'packages/cli'),
): Promise<ViewModelArtifactResult> {
  const manifest = JSON.parse(fs.readFileSync(path.join(cliRoot, 'package.json'), 'utf8'));
  const subpath = manifest.exports?.['./view-model'];
  if (!subpath || typeof subpath.import !== 'string' || typeof subpath.types !== 'string')
    throw new Error('ViewModel requires independent import/types exports');
  const rootExport = manifest.exports?.['.'];
  const rootTarget = typeof rootExport === 'string' ? rootExport : rootExport?.import;
  if (rootTarget !== manifest.main || manifest.bin?.kpbl !== './dist/bin.js')
    throw new Error('CLI root/bin compatibility changed');
  const entry = path.resolve(cliRoot, subpath.import);
  const declaration = path.resolve(cliRoot, subpath.types);
  const artifactRoot = path.resolve(cliRoot, 'dist/view-model');
  if (!inside(artifactRoot, entry) || !inside(artifactRoot, declaration))
    throw new Error('ViewModel artifact closure escapes its standalone directory');
  if (!fs.existsSync(declaration) || fs.statSync(declaration).size === 0)
    throw new Error('ViewModel declaration missing');
  const source = fs.readFileSync(entry, 'utf8');
  if (source.startsWith('#!')) throw new Error('ViewModel ESM must not have a shebang');

  // esbuild 是既有 tsup 的依赖；从该安装位置解析，避免依赖 pnpm 的非公开扁平链接。
  const cliRequire = createRequire(path.join(repositoryRoot, 'packages/cli/package.json'));
  const toolRequire = createRequire(cliRequire.resolve('tsup'));
  const build = toolRequire('esbuild').build as (options: Record<string, unknown>) => Promise<{
    outputFiles: { text: string; contents: Uint8Array }[];
    metafile: { inputs: Record<string, { imports: { external?: boolean }[] }> };
  }>;
  const result = await build({
    entryPoints: [entry],
    absWorkingDir: cliRoot,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    write: false,
    metafile: true,
    treeShaking: false,
    logLevel: 'silent',
  });
  for (const [input, metadata] of Object.entries(result.metafile.inputs)) {
    if (
      !inside(artifactRoot, path.resolve(cliRoot, input)) ||
      metadata.imports.some((item) => item.external)
    )
      throw new Error('ViewModel browser dependency closure escapes its standalone directory');
  }
  const browser = result.outputFiles[0];
  if (browser.text.startsWith('#!')) throw new Error('ViewModel browser bundle leaked a shebang');
  const browserUrl = `data:text/javascript;base64,${Buffer.from(browser.contents).toString('base64')}`;
  const probe = spawnSync(process.execPath, ['--input-type=module', '--eval', importProbe], {
    input: JSON.stringify([pathToFileURL(entry).href, browserUrl]),
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (probe.error || probe.status !== 0 || probe.stderr)
    throw new Error(
      `ViewModel import side-effect or failure: ${probe.error?.message ?? probe.stderr}`,
    );
  let imported: { exports: string[] };
  try {
    imported = JSON.parse(probe.stdout);
    if (!Array.isArray(imported.exports)) throw new Error('missing export list');
  } catch {
    throw new Error('ViewModel import side-effect: unexpected stdout');
  }
  if (imported.exports.length === 0) throw new Error('ViewModel artifact exports nothing');
  return { exports: imported.exports, browserBytes: browser.contents.byteLength };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkViewModelArtifact().then(
    (result) =>
      console.log(
        `✔ ViewModel browser 构建与独立导入通过（${result.exports.length} 个导出，${result.browserBytes} bytes）。`,
      ),
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
