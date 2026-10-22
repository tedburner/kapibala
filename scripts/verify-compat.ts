import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifestPath = path.join(repositoryRoot, 'scripts/fixtures/public-api/v0.0.9/manifest.json');
const defaultCacheRoot = path.join(repositoryRoot, '.workbuddy/v0.0.10-compat');
const harnessPath = path.join(repositoryRoot, 'scripts/compat-harness.mjs');
const cursorPath = path.join(repositoryRoot, 'scripts/compat-cursor.mjs');

/** 旧端固定清单条目；只接受 registry.npmjs.org 的固定版本 tarball。 */
interface LegacyPackage {
  name: string;
  version: string;
  tarball: string;
  integrity: string;
  sha256: string;
}

/** tarball 的下载字节校验结果；integrity 与 sha256 必须同时匹配固定清单。 */
export interface TarballCheck {
  ok: boolean;
  sha256: string;
  integrity: string;
  bytes: number;
}

/** 旧端安装标记；tarball 集合变化后必须重新安装，不能复用混合版本。 */
interface InstallMarker {
  schemaVersion: 1;
  packages: { name: string; version: string; sha256: string; integrity: string }[];
}

type ClientSide = 'old' | 'new';
type HostSide = 'old' | 'new';
type TransportKind = 'stdio' | 'socket';

/** 四组合的身份固定为客户端产物与宿主产物来源，显示名与设计文档保持一致。 */
export interface CompatCombo {
  id: 'old-old' | 'old-new' | 'new-old' | 'new-new';
  client: ClientSide;
  host: HostSide;
}

export const COMPAT_COMBOS: readonly CompatCombo[] = [
  { id: 'old-old', client: 'old', host: 'old' },
  { id: 'old-new', client: 'old', host: 'new' },
  { id: 'new-old', client: 'new', host: 'old' },
  { id: 'new-new', client: 'new', host: 'new' },
];

const EXPECTED_PACKAGES = [
  '@kiturone/kapibala',
  '@kiturone/kapibala-cli',
  '@kiturone/kapibala-mcp',
] as const;

/** 从固定 manifest 读取旧端三包；版本、包名与来源 host 不符时拒绝继续。 */
export function readLegacyManifest(file = manifestPath): LegacyPackage[] {
  const entries = JSON.parse(fs.readFileSync(file, 'utf8')) as LegacyPackage[];
  if (!Array.isArray(entries) || entries.length !== EXPECTED_PACKAGES.length)
    throw new Error('Legacy manifest must contain exactly the three published packages');
  const names = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...EXPECTED_PACKAGES].sort()))
    throw new Error('Legacy manifest package names do not match the published set');
  for (const entry of entries) {
    if (!/^\d+\.\d+\.\d+$/.test(entry.version))
      throw new Error(`Invalid legacy version: ${entry.name}@${entry.version}`);
    const url = new URL(entry.tarball);
    if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org')
      throw new Error(`Legacy tarball must come from registry.npmjs.org: ${entry.tarball}`);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || !entry.integrity.startsWith('sha512-'))
      throw new Error(`Invalid legacy checksum for ${entry.name}`);
  }
  return entries;
}

/** 计算 tarball 的 sha256 与 sha512 integrity；只比较固定清单，不读取注册表当前状态。 */
export function checkTarball(
  file: string,
  expected: Pick<LegacyPackage, 'sha256' | 'integrity'>,
): TarballCheck {
  const bytes = fs.readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  return {
    ok: sha256 === expected.sha256 && integrity === expected.integrity,
    sha256,
    bytes: bytes.length,
    integrity,
  };
}

function tarballFile(cacheRoot: string, entry: LegacyPackage): string {
  return path.join(cacheRoot, 'tarballs', path.basename(new URL(entry.tarball).pathname));
}

function legacyInstallDir(cacheRoot: string): string {
  return path.join(cacheRoot, 'old');
}

function markerPath(cacheRoot: string): string {
  return path.join(legacyInstallDir(cacheRoot), '.compat-install.json');
}

function installMarker(entries: LegacyPackage[]): InstallMarker {
  return {
    schemaVersion: 1,
    packages: entries.map((entry) => ({
      name: entry.name,
      version: entry.version,
      sha256: entry.sha256,
      integrity: entry.integrity,
    })),
  };
}

/** 安装标记、已装版本与关键入口都必须匹配；任一缺失都要求重新准备旧端。 */
export function isLegacyInstallValid(cacheRoot: string, entries: LegacyPackage[]): boolean {
  const markerFile = markerPath(cacheRoot);
  if (!fs.existsSync(markerFile)) return false;
  try {
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')) as InstallMarker;
    if (JSON.stringify(marker) !== JSON.stringify(installMarker(entries))) return false;
    for (const entry of entries) {
      const installed = path.join(legacyInstallDir(cacheRoot), 'node_modules', entry.name);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(installed, 'package.json'), 'utf8'),
      ) as {
        version?: string;
      };
      if (manifest.version !== entry.version) return false;
    }
    return [
      'node_modules/@kiturone/kapibala/dist/index.js',
      'node_modules/@kiturone/kapibala-mcp/dist/index.js',
      'node_modules/@kiturone/kapibala-cli/dist/bin.js',
      'node_modules/@kiturone/kapibala-cli/dist/client/index.js',
    ].every((relative) => fs.existsSync(path.join(legacyInstallDir(cacheRoot), relative)));
  } catch {
    return false;
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && command === 'npm',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-16_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-16_000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out: ${command} ${args.join(' ')}`));
    }, options.timeoutMs ?? 180_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `${command} ${args.join(' ')} failed (${code ?? signal}):\n${stderr || stdout}`,
          ),
        );
    });
  });
}

function tsupBinary(packageDir: string): string {
  const manifestFile = path.join(packageDir, 'node_modules/tsup/package.json');
  if (!fs.existsSync(manifestFile))
    throw new Error(
      `Missing tsup in ${path.relative(repositoryRoot, packageDir)}; run pnpm install`,
    );
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.tsup;
  if (!bin) throw new Error('tsup package does not expose a bin entry');
  return path.join(path.dirname(manifestFile), bin);
}

/** 候选端只从当前源码构建；构建失败即中止，绝不退回复用旧 dist。 */
async function buildCandidate(): Promise<void> {
  const coreDir = path.join(repositoryRoot, 'packages/core');
  const mcpDir = path.join(repositoryRoot, 'packages/mcp');
  const cliDir = path.join(repositoryRoot, 'packages/cli');
  await run(process.execPath, [tsupBinary(coreDir)], { cwd: coreDir });
  await run(process.execPath, [tsupBinary(mcpDir)], { cwd: mcpDir });
  const cliTsup = tsupBinary(cliDir);
  for (const config of [
    'tsup.config.ts',
    'tsup.view-model.config.ts',
    'tsup.protocol.config.ts',
    'tsup.client.config.ts',
  ]) {
    await run(process.execPath, [cliTsup, '--config', config], { cwd: cliDir });
  }
}

async function download(file: string, url: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 32 * 1024 * 1024)
    throw new Error(`Unexpected tarball size: ${bytes.length}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.part`, bytes);
  fs.renameSync(`${file}.part`, file);
}

async function installLegacy(cacheRoot: string, entries: LegacyPackage[]): Promise<void> {
  const directory = legacyInstallDir(cacheRoot);
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    `${JSON.stringify({ name: 'kapibala-compat-legacy', private: true }, null, 2)}\n`,
  );
  await run(
    'npm',
    [
      'install',
      '--no-save',
      '--no-package-lock',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...entries.map((entry) => tarballFile(cacheRoot, entry)),
    ],
    { cwd: directory, timeoutMs: 300_000 },
  );
  fs.writeFileSync(markerPath(cacheRoot), `${JSON.stringify(installMarker(entries), null, 2)}\n`);
}

/** 旧端网络准备与无网络回归分开：缓存缺失或校验失败时，只有 --prepare 才允许联网修复。 */
async function ensureLegacy(cacheRoot: string, prepare: boolean): Promise<LegacyPackage[]> {
  const entries = readLegacyManifest();
  fs.mkdirSync(path.join(cacheRoot, 'tarballs'), { recursive: true });
  for (const entry of entries) {
    const file = tarballFile(cacheRoot, entry);
    if (fs.existsSync(file) && checkTarball(file, entry).ok) continue;
    if (!prepare)
      throw new Error(
        `Legacy tarball cache is missing or invalid: ${path.relative(repositoryRoot, file)}. Run \`pnpm verify:compat:prepare\` once with network access.`,
      );
    await download(file, entry.tarball);
    const check = checkTarball(file, entry);
    if (!check.ok)
      throw new Error(
        `Legacy tarball checksum mismatch for ${entry.name}@${entry.version}: ${check.sha256}`,
      );
  }
  if (!isLegacyInstallValid(cacheRoot, entries)) {
    if (!prepare)
      throw new Error(
        `Legacy install is missing or stale: ${path.relative(repositoryRoot, legacyInstallDir(cacheRoot))}. Run \`pnpm verify:compat:prepare\` once with network access.`,
      );
    await installLegacy(cacheRoot, entries);
    if (!isLegacyInstallValid(cacheRoot, entries))
      throw new Error('Legacy install did not produce the expected entry points');
  }
  return entries;
}

function candidatePaths(): { client: string; host: string } {
  const client = path.join(repositoryRoot, 'packages/cli/dist/client/index.js');
  const host = path.join(repositoryRoot, 'packages/cli/dist/bin.js');
  for (const file of [client, host])
    if (!fs.existsSync(file)) throw new Error(`Candidate build is missing: ${file}`);
  return { client, host };
}

function legacyPaths(cacheRoot: string): { client: string; host: string } {
  const root = path.join(legacyInstallDir(cacheRoot), 'node_modules/@kiturone/kapibala-cli/dist');
  return { client: path.join(root, 'client/index.js'), host: path.join(root, 'bin.js') };
}

export interface HarnessResult {
  ok: boolean;
  transport: TransportKind;
  clientVersion: string;
  error?: string;
  [key: string]: unknown;
}

async function executeHarness(options: {
  script: string;
  combo: CompatCombo;
  transport: TransportKind;
  clientEntry: string;
  hostEntry: string;
  runDir: string;
  keepTemp: boolean;
}): Promise<HarnessResult> {
  // Unix socket 端点有 100 字节上限，macOS 的 os.tmpdir() 会超长；POSIX 使用短 /tmp 路径。
  const temp = fs.mkdtempSync(
    path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'kpbl-c-'),
  );
  const root = path.join(temp, 'root');
  const home = path.join(temp, 'home');
  const runtime = path.join(temp, 'runtime');
  for (const directory of [root, home, runtime]) fs.mkdirSync(directory, { recursive: true });
  fs.chmodSync(runtime, 0o700);
  const kind = path.basename(options.script, '.mjs');
  const resultFile = path.join(
    options.runDir,
    `${options.combo.id}-${options.transport}-${kind}.json`,
  );
  const args = [
    options.script,
    '--client',
    options.clientEntry,
    '--host',
    options.hostEntry,
    '--client-version',
    options.combo.client === 'old' ? 'old' : 'candidate',
    '--transport',
    options.transport,
    '--runtime-dir',
    runtime,
    '--root',
    root,
    '--home',
    home,
    '--result',
    resultFile,
  ];
  try {
    await run(process.execPath, args, { timeoutMs: 180_000 });
  } catch (error) {
    const detail = fs.existsSync(resultFile)
      ? fs.readFileSync(resultFile, 'utf8')
      : error instanceof Error
        ? error.message
        : String(error);
    throw new Error(`[${options.combo.id}/${options.transport}] harness failed:\n${detail}`);
  } finally {
    if (!options.keepTemp) fs.rmSync(temp, { recursive: true, force: true });
  }
  return JSON.parse(fs.readFileSync(resultFile, 'utf8')) as HarnessResult;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** 正常路径四组合共用断言；非法工作区须由宿主拒绝，错误后连接仍可复用。 */
export function assertNormalResult(result: HarnessResult, combo: CompatCombo): void {
  assert(result.ok === true, `${combo.id}: harness did not report success`);
  assert(
    result.clientVersion === (combo.client === 'old' ? 'old' : 'candidate'),
    `${combo.id}: client version mismatch`,
  );
  const negative = result.negative as { invalidParams: string; pingAfterInvalid: boolean };
  assert(
    negative.pingAfterInvalid === true,
    `${combo.id}: connection not usable after invalid params`,
  );
  assert(negative.invalidParams === 'INVALID_PARAMS', `${combo.id}: expected host INVALID_PARAMS`);
  const list = result.list as { before: number; after: number; cursor: string | null };
  assert(list.cursor === null, `${combo.id}: unexpected session list cursor`);
  assert(list.after >= 1 && list.after >= list.before, `${combo.id}: session list did not grow`);
  const tool = result.tool as { outcome: string; file: string };
  assert(
    tool.outcome === 'completed' && tool.file === 'compat',
    `${combo.id}: tool transaction failed`,
  );
  const dedupe = result.dedupe as { sameRunId: boolean; newEvents: number };
  assert(dedupe.sameRunId === true, `${combo.id}: operation id replay created a new run`);
  assert(dedupe.newEvents === 0, `${combo.id}: operation id replay emitted new events`);
  const approval = result.approval as {
    outcome: string;
    file: string;
    prompts: { toolName: string; target: string }[];
  };
  assert(
    approval.outcome === 'completed' && approval.file === 'approved',
    `${combo.id}: approval run failed`,
  );
  assert(
    approval.prompts.some((prompt) => prompt.target.includes('compat/approved.txt')),
    `${combo.id}: approval prompt did not reach the guarded file`,
  );
  const cancel = result.cancel as { outcome: string };
  assert(cancel.outcome === 'cancelled', `${combo.id}: cancel did not settle as cancelled`);
  assert(result.historyClosed === true, `${combo.id}: history is not closed`);
  const reopened = result.reopened as { messages: number; historyClosed: boolean };
  assert(
    reopened.messages >= 1 && reopened.historyClosed === true,
    `${combo.id}: reopened history invalid`,
  );
  const events = result.events as { toolFinishes: number; texts: string[] };
  assert(events.toolFinishes >= 2, `${combo.id}: missing tool finish events`);
  assert(events.texts.includes('partial'), `${combo.id}: missing partial text before cancel`);
  assert(events.texts.includes('tool-done'), `${combo.id}: missing tool continuation text`);
  const hostExit = result.hostExit as { code?: number | null; signal?: string | null } | null;
  assert(hostExit?.code === 0, `${combo.id}: host did not exit cleanly`);
  assert(result.daemonStopped === true, `${combo.id}: daemon/runtime not released`);
  assert(String(result.stderr ?? '').trim() === '', `${combo.id}: host wrote to stderr`);
}

/** 显式 cursor 与未知能力按客户端版本分别断言；旧端缺陷不得被当成新端成功。 */
export function assertCursorResult(result: HarnessResult, combo: CompatCombo): void {
  assert(result.ok === true, `${combo.id}: cursor probe did not report success`);
  assert(
    result.unsupportedCapability === 'PROTOCOL_MISMATCH',
    `${combo.id}: unknown capability accepted`,
  );
  const longRun = result.longRun as { outcome: string; textLength: number };
  assert(
    longRun.outcome === 'completed' && longRun.textLength > 70_000,
    `${combo.id}: long run incomplete`,
  );
  const snapshot = result.snapshot as {
    messages: number;
    historyClosed: boolean;
    firstPageCursor: boolean;
    firstPageBytes: number;
  };
  assert(
    snapshot.historyClosed === true && snapshot.messages >= 2,
    `${combo.id}: long snapshot history invalid`,
  );
  assert(
    snapshot.firstPageCursor === true && snapshot.firstPageBytes > 0,
    `${combo.id}: snapshot did not paginate`,
  );
  const cursor = result.explicitCursor as Record<string, unknown>;
  if (combo.client === 'new') {
    assert(cursor.rejected === false, `${combo.id}: new client rejected a valid cursor page`);
    assert(
      cursor.chunk === true && cursor.hasHistory === false,
      `${combo.id}: cursor page shape changed`,
    );
    assert(cursor.cursor === true, `${combo.id}: cursor page did not return page metadata`);
    assert(cursor.aliveAfter === true, `${combo.id}: connection closed after a cursor page`);
  } else {
    assert(
      cursor.rejected === true,
      `${combo.id}: v0.0.9 client unexpectedly accepted cursor paging`,
    );
    assert(
      cursor.aliveAfter === false,
      `${combo.id}: v0.0.9 cursor defect did not invalidate the connection`,
    );
  }
  assert(result.daemonStopped === true, `${combo.id}: daemon/runtime not released`);
  assert(String(result.stderr ?? '').trim() === '', `${combo.id}: host wrote to stderr`);
}

function gitOutput(args: string[]): string | null {
  try {
    const result = spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

function candidateVersions(): Record<string, string> {
  return Object.fromEntries(
    ['core', 'mcp', 'cli'].map((name) => {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(repositoryRoot, `packages/${name}/package.json`), 'utf8'),
      ) as { name: string; version: string };
      return [manifest.name, manifest.version];
    }),
  );
}

async function main(): Promise<void> {
  const prepare = process.argv.includes('--prepare');
  const skipBuild = process.argv.includes('--skip-build');
  const keepTemp = process.argv.includes('--keep-temp');
  const transportIndex = process.argv.indexOf('--transport');
  const transportArg = transportIndex === -1 ? 'both' : process.argv[transportIndex + 1];
  if (!['both', 'stdio', 'socket'].includes(transportArg ?? ''))
    throw new Error('--transport must be one of both, stdio, socket');
  const transports: TransportKind[] =
    transportArg === 'both' ? ['stdio', 'socket'] : [transportArg as TransportKind];

  const cacheRoot = defaultCacheRoot;
  const runDir = path.join(cacheRoot, 'runs');
  fs.mkdirSync(runDir, { recursive: true });
  const entries = await ensureLegacy(cacheRoot, prepare);
  if (!skipBuild) await buildCandidate();
  const candidate = candidatePaths();
  const legacy = legacyPaths(cacheRoot);
  const matrix: unknown[] = [];
  const startedAt = new Date().toISOString();

  for (const combo of COMPAT_COMBOS) {
    const clientEntry = combo.client === 'old' ? legacy.client : candidate.client;
    const hostEntry = combo.host === 'old' ? legacy.host : candidate.host;
    for (const transport of transports) {
      const normal = await executeHarness({
        script: harnessPath,
        combo,
        transport,
        clientEntry,
        hostEntry,
        runDir,
        keepTemp,
      });
      assertNormalResult(normal, combo);
      const cursor = await executeHarness({
        script: cursorPath,
        combo,
        transport,
        clientEntry,
        hostEntry,
        runDir,
        keepTemp,
      });
      assertCursorResult(cursor, combo);
      matrix.push({ combo: combo.id, transport, normal, cursor });
      console.log(`✔ ${combo.id.padEnd(7)} ${transport.padEnd(6)} normal + cursor`);
    }
  }

  const commit = gitOutput(['rev-parse', 'HEAD']) ?? 'unknown';
  const dirty = (gitOutput(['status', '--porcelain']) ?? '').length > 0;
  const evidence = {
    schemaVersion: 1,
    generatedAt: startedAt,
    commit,
    worktreeDirty: dirty,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    candidate: candidateVersions(),
    legacy: entries.map((entry) => ({
      name: entry.name,
      version: entry.version,
      sha256: entry.sha256,
      integrity: entry.integrity,
      tarball: entry.tarball,
    })),
    transports,
    matrix,
  };
  const evidenceFile = path.join(
    cacheRoot,
    'evidence',
    `compat-${commit.slice(0, 12)}${dirty ? '-dirty' : ''}.json`,
  );
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  if (dirty)
    console.warn('Worktree is dirty; evidence is marked and cannot stand in for a clean commit.');
  console.log(
    `Compared v0.0.9 tarballs with the current build in ${matrix.length} runs at ${path.relative(repositoryRoot, evidenceFile)}.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
