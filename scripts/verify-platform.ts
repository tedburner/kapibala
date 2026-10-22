import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const probePath = path.join(repositoryRoot, 'scripts/platform-probe.mjs');
const mcpProbePath = path.join(repositoryRoot, 'scripts/platform-mcp.mjs');
const evidenceRoot = path.join(repositoryRoot, '.workbuddy/v0.0.10-platform/evidence');

type SectionStatus = 'passed' | 'failed' | 'pending' | 'not-applicable';

interface SectionRecord {
  status: SectionStatus;
  details?: unknown;
  blockers?: string[];
  error?: string;
}

/** 默认拒绝任何 pending；日常 CI 可显式延期独立人工/运行时通道，但不得跳过自动化产物验收。 */
export function platformGateVerdict(
  sections: Readonly<Record<string, Pick<SectionRecord, 'status'>>>,
  allowPending = false,
): { status: 'passed' | 'failed' | 'pending'; exitCode: 0 | 1 } {
  const failed = Object.values(sections).some((record) => record.status === 'failed');
  const pending = Object.entries(sections).filter(([, record]) => record.status === 'pending');
  const independent = new Set(['node20-channel', 'windows-acl', 'windows-conpty', 'posix-pty']);
  return {
    status: failed ? 'failed' : pending.length ? 'pending' : 'passed',
    exitCode: failed || pending.some(([id]) => !allowPending || !independent.has(id)) ? 1 : 0,
  };
}

interface HostExit {
  code: number | null;
  signal: string | null;
  timedOut?: boolean;
}

interface StdioProbe {
  ping: { alive: boolean; serverInstanceId: string };
  host: HostExit;
  stderr: string;
}

interface DaemonProbe {
  first: { running: boolean; serverInstanceId: string };
  second: { running: boolean; serverInstanceId: string };
  metadata: {
    serverInstanceId: string;
    endpointType: string;
    tokenShape: boolean;
    mode: number | null;
    runtimeMode: number | null;
  };
  statusRunning: { running: boolean };
  connected: boolean;
  auth: {
    missing: { ok: boolean; error?: string };
    wrong: { ok: boolean; error?: string };
    correct: { ok: boolean; ping?: { alive: boolean } };
  };
  statusStopped: { running: boolean };
  lockRemoved: boolean;
}

interface TreeProbe {
  shellPid: number;
  childPid: number;
  aliveBefore: { shell: boolean; child: boolean };
  aliveAfter: { shell: boolean; child: boolean };
  outcome: string;
  host: HostExit;
  stderr: string;
}

/** 当前 OS 探针的原始结果；只包含事实，不包含通过/失败结论。 */
export interface PlatformProbeResult {
  ok: boolean;
  error?: string;
  stack?: string;
  platform?: string;
  node?: string;
  stdio?: StdioProbe;
  daemon?: DaemonProbe;
  tree?: TreeProbe;
}

export interface McpProbeResult {
  ok: boolean;
  error?: string;
  stack?: string;
  startupAuthorization?: {
    authorizations: { server: string; type: string }[];
    readyServers: string[];
    failedServers: Record<string, string>;
  };
  tools?: {
    stdio: { name?: string; dangerous?: boolean };
    http: { name?: string; dangerous?: boolean };
  };
  calls?: { stdio: string; http: string };
  cancel?: { dispatchedError: boolean; elapsedMs: number; stillReady: boolean };
  revoke?: { status?: { connectionState?: string }; error: string };
  reenable?: { status?: { connectionState?: string }; call: string };
  denied?: { readyServers: string[]; failedServers: Record<string, string> };
  retry?: {
    firstFailedServers: Record<string, string>;
    status?: { connectionState?: string };
    call: string;
  };
  close?: {
    stdioPid: number;
    stdioAlive: boolean;
    managerTornDown: boolean;
    sessionState: string;
    sessionReady: boolean;
    httpCalls: { initialized: number; listTools: number; callTool: number };
  };
}

interface RunResult {
  stdout: string;
  stderr: string;
}

/** 执行平台门禁子命令并收集有界诊断；Windows 包管理器 shim 必须经 shell 启动。 */
export function run(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && (command === 'npm' || command === 'pnpm.cmd'),
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

function ok(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function tsupBinary(packageDir: string): string {
  const manifestFile = path.join(packageDir, 'node_modules/tsup/package.json');
  if (!fs.existsSync(manifestFile))
    throw new Error(
      `Missing tsup in ${path.relative(repositoryRoot, packageDir)}; run pnpm install`,
    );
  const manifest = readJson<{ bin?: string | Record<string, string> }>(manifestFile);
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.tsup;
  if (!bin) throw new Error('tsup package does not expose a bin entry');
  return path.join(path.dirname(manifestFile), bin);
}

/** 平台门禁先按当前源码重建候选产物，避免用陈旧 dist 生成“通过”证据。 */
export async function buildCandidate(): Promise<void> {
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

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function shortTemp(prefix: string): string {
  return fs.mkdtempSync(
    path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', `kpbl-${prefix}-`),
  );
}

/** Node 最低版本与 Node 20 实机通道分开：当前进程版本满足 >=20 不等于已取得 Node 20 证据。 */
export function evaluateNodeSupport(version: string): {
  major: number;
  satisfiesMinimum: boolean;
  actualNode20: boolean;
} {
  const major = Number(version.replace(/^v/, '').split('.')[0]);
  return {
    major,
    satisfiesMinimum: Number.isSafeInteger(major) && major >= 20,
    actualNode20: major === 20,
  };
}

/** 把 workspace 协议依赖改写为发布版本；仅 npm fallback 打包使用，pnpm 打包仍以真实发布流程为准。 */
export function rewriteWorkspaceDependencies(
  manifest: Record<string, unknown>,
  version: string,
): Record<string, unknown> {
  const dependencies = manifest.dependencies;
  if (!dependencies || typeof dependencies !== 'object') return manifest;
  const rewritten = Object.fromEntries(
    Object.entries(dependencies as Record<string, string>).map(([name, value]) => [
      name,
      value.startsWith('workspace:') ? version : value,
    ]),
  );
  return { ...manifest, dependencies: rewritten };
}

/** 浏览器子路径不得引用 node: 内置模块或 CommonJS require；平台门禁在隔离安装后静态复核。 */
export function browserBundleViolations(source: string): string[] {
  const violations = new Set<string>();
  for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)['"](node:[^'"]+)['"]/g))
    violations.add(match[1]);
  if (/\brequire\s*\(/.test(source)) violations.add('require()');
  return [...violations].sort();
}

interface PackedPackage {
  name: string;
  version: string;
  tarball: string;
  entries: string[];
}

function packageDirectories(): { name: string; directory: string }[] {
  return [
    { name: '@kiturone/kapibala', directory: path.join(repositoryRoot, 'packages/core') },
    { name: '@kiturone/kapibala-mcp', directory: path.join(repositoryRoot, 'packages/mcp') },
    { name: '@kiturone/kapibala-cli', directory: path.join(repositoryRoot, 'packages/cli') },
  ];
}

function listTarball(tarball: string): string[] {
  const result = spawnSync('tar', ['-tzf', path.basename(tarball)], {
    cwd: path.dirname(tarball),
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(`Unable to list tarball ${path.basename(tarball)}: ${result.stderr}`);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function stageForNpmPack(directory: string, stage: string, version: string): void {
  fs.mkdirSync(stage, { recursive: true });
  fs.cpSync(path.join(directory, 'dist'), path.join(stage, 'dist'), { recursive: true });
  for (const file of ['README.md', 'LICENSE']) {
    const source = path.join(directory, file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(stage, file));
    else if (fs.existsSync(path.join(repositoryRoot, file)))
      fs.copyFileSync(path.join(repositoryRoot, file), path.join(stage, file));
  }
  const manifest = rewriteWorkspaceDependencies(
    readJson<Record<string, unknown>>(path.join(directory, 'package.json')),
    version,
  );
  fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function packPackages(
  packDir: string,
  tempRoot: string,
): Promise<{
  packaging: 'pnpm' | 'npm-fallback';
  packages: PackedPackage[];
}> {
  fs.mkdirSync(packDir, { recursive: true });
  const directories = packageDirectories();
  const version = readJson<{ version: string }>(
    path.join(directories[0].directory, 'package.json'),
  ).version;
  const pnpm = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const usePnpm = pnpm.status === 0;
  const packages: PackedPackage[] = [];
  for (const entry of directories) {
    const before = new Set(fs.readdirSync(packDir));
    if (usePnpm) {
      await run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [
        '-C',
        entry.directory,
        'pack',
        '--pack-destination',
        packDir,
      ]);
    } else {
      const stage = path.join(tempRoot, `stage-${entry.name.replace(/[^a-z0-9-]/gi, '-')}`);
      stageForNpmPack(entry.directory, stage, version);
      await run('npm', ['pack', '--pack-destination', packDir, '--ignore-scripts'], {
        cwd: stage,
      });
    }
    const created = fs.readdirSync(packDir).filter((file) => !before.has(file));
    ok(created.length === 1, `Expected one tarball for ${entry.name}, got: ${created.join(', ')}`);
    const tarball = path.join(packDir, created[0]);
    const entries = listTarball(tarball);
    for (const member of entries) {
      ok(
        /^package\/(dist\/[^\r\n]+|LICENSE|README\.md|package\.json)$/.test(member),
        `Unexpected tarball entry in ${created[0]}: ${member}`,
      );
    }
    ok(entries.includes('package/package.json'), `${created[0]} is missing package/package.json`);
    ok(
      entries.some((member) => member.startsWith('package/dist/')),
      `${created[0]} is missing dist output`,
    );
    packages.push({ name: entry.name, version, tarball, entries });
  }
  return { packaging: usePnpm ? 'pnpm' : 'npm-fallback', packages };
}

function installedPackageJson(installDir: string, name: string): Record<string, unknown> {
  return readJson<Record<string, unknown>>(
    path.join(installDir, 'node_modules', ...name.split('/'), 'package.json'),
  );
}

async function importIn(installDir: string, code: string): Promise<void> {
  await run(process.execPath, ['--input-type=module', '-e', code], { cwd: installDir });
}

async function requireIn(installDir: string, code: string): Promise<void> {
  await run(process.execPath, ['-e', code], { cwd: installDir });
}

async function executeArtifactChecks(tempRoot: string): Promise<Record<string, unknown>> {
  const packDir = path.join(tempRoot, 'pack');
  const installDir = path.join(tempRoot, 'install');
  const { packaging, packages } = await packPackages(packDir, tempRoot);
  const version = packages[0].version;
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(
    path.join(installDir, 'package.json'),
    `${JSON.stringify({ name: 'kpbl-platform-consumer', private: true, type: 'module' }, null, 2)}\n`,
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
      '--prefer-offline',
      ...packages.map((entry) => entry.tarball),
    ],
    { cwd: installDir, timeoutMs: 300_000 },
  );

  const core = installedPackageJson(installDir, '@kiturone/kapibala');
  const mcp = installedPackageJson(installDir, '@kiturone/kapibala-mcp');
  const cli = installedPackageJson(installDir, '@kiturone/kapibala-cli');
  const dependencies = (manifest: Record<string, unknown>) =>
    (manifest.dependencies as Record<string, string> | undefined) ?? {};
  ok(Object.keys(dependencies(core)).length === 0, 'Core must have zero runtime dependencies');
  ok(
    dependencies(mcp)['@kiturone/kapibala'] === version,
    'MCP must depend on the exact Core version',
  );
  ok(
    dependencies(cli)['@kiturone/kapibala'] === version &&
      dependencies(cli)['@kiturone/kapibala-mcp'] === version,
    'CLI must depend on exact Core and MCP versions',
  );
  const packageRoots = ['@kiturone/kapibala', '@kiturone/kapibala-mcp', '@kiturone/kapibala-cli'];
  for (const name of packageRoots) {
    const target = path.join(installDir, 'node_modules', ...name.split('/'));
    ok(!fs.lstatSync(target).isSymbolicLink(), `${name} must be installed as a real directory`);
  }
  const requiredFiles = [
    '@kiturone/kapibala/dist/index.js',
    '@kiturone/kapibala/dist/index.cjs',
    '@kiturone/kapibala/dist/index.d.ts',
    '@kiturone/kapibala-mcp/dist/index.js',
    '@kiturone/kapibala-mcp/dist/index.cjs',
    '@kiturone/kapibala-mcp/dist/index.d.ts',
    '@kiturone/kapibala-cli/dist/bin.js',
    '@kiturone/kapibala-cli/dist/protocol/index.js',
    '@kiturone/kapibala-cli/dist/protocol/index.d.ts',
    '@kiturone/kapibala-cli/dist/client/index.js',
    '@kiturone/kapibala-cli/dist/client/index.d.ts',
    '@kiturone/kapibala-cli/dist/view-model/index.js',
    '@kiturone/kapibala-cli/dist/view-model/index.d.ts',
  ];
  for (const relative of requiredFiles)
    ok(
      fs.existsSync(path.join(installDir, 'node_modules', relative)),
      `Installed artifact is missing ${relative}`,
    );

  await importIn(
    installDir,
    'import assert from "node:assert/strict"; import * as core from "@kiturone/kapibala"; assert.equal(typeof core.AgentSession, "function"); assert.equal(typeof core.SessionManager, "function");',
  );
  await requireIn(
    installDir,
    'const assert = require("node:assert/strict"); const core = require("@kiturone/kapibala"); assert.equal(typeof core.AgentSession, "function"); assert.equal(typeof core.SessionManager, "function");',
  );
  await importIn(
    installDir,
    'import assert from "node:assert/strict"; import * as mcp from "@kiturone/kapibala-mcp"; assert.equal(typeof mcp.McpServerManager, "function"); assert.equal(typeof mcp.createMcpPlugin, "function");',
  );
  await requireIn(
    installDir,
    'const assert = require("node:assert/strict"); const mcp = require("@kiturone/kapibala-mcp"); assert.equal(typeof mcp.McpServerManager, "function"); assert.equal(typeof mcp.createMcpPlugin, "function");',
  );
  await importIn(
    installDir,
    'import assert from "node:assert/strict"; const protocol = await import("@kiturone/kapibala-cli/protocol"); const client = await import("@kiturone/kapibala-cli/client"); const view = await import("@kiturone/kapibala-cli/view-model"); assert.equal(typeof protocol.DEFAULT_LIMITS, "object"); assert.equal(typeof client.LocalClient, "function"); assert.equal(typeof view.createPresentation, "function");',
  );
  const cliBin = path.join(
    installDir,
    'node_modules',
    '@kiturone',
    'kapibala-cli',
    'dist',
    'bin.js',
  );
  const versionOutput = (await run(process.execPath, [cliBin, '--version'], { cwd: installDir }))
    .stdout;
  ok(
    versionOutput.trim() === `kpbl v${version}`,
    `Unexpected CLI version output: ${versionOutput}`,
  );
  const helpOutput = (await run(process.execPath, [cliBin, '--help'], { cwd: installDir })).stdout;
  for (const flag of ['daemon', 'connect', 'serve', '--no-mcp'])
    ok(helpOutput.includes(flag), `CLI help is missing ${flag}`);

  const browserBoundaries: Record<string, string[]> = {};
  for (const subpath of ['protocol', 'view-model']) {
    const file = path.join(
      installDir,
      'node_modules/@kiturone/kapibala-cli/dist',
      subpath,
      'index.js',
    );
    const violations = browserBundleViolations(fs.readFileSync(file, 'utf8'));
    browserBoundaries[subpath] = violations;
    ok(violations.length === 0, `${subpath} browser bundle references Node-only modules`);
  }
  return {
    packaging,
    version,
    tarballs: packages.map((entry) => ({
      name: entry.name,
      files: entry.entries.length,
    })),
    isolatedInstall: true,
    coreRuntimeDependencies: 0,
    browserBoundaries,
    cliVersion: versionOutput.trim(),
  };
}

async function executePlatformProbe(tempRoot: string): Promise<PlatformProbeResult> {
  const root = path.join(tempRoot, 'root');
  const home = path.join(tempRoot, 'home');
  const runtime = path.join(tempRoot, 'runtime');
  for (const directory of [root, home, runtime]) fs.mkdirSync(directory, { recursive: true });
  fs.chmodSync(runtime, 0o700);
  const resultPath = path.join(tempRoot, 'platform-probe.json');
  await run(
    process.execPath,
    [
      probePath,
      '--client',
      path.join(repositoryRoot, 'packages/cli/dist/client/index.js'),
      '--host',
      path.join(repositoryRoot, 'packages/cli/dist/bin.js'),
      '--root',
      root,
      '--home',
      home,
      '--runtime',
      runtime,
      '--result',
      resultPath,
    ],
    { timeoutMs: 180_000 },
  );
  return readJson<PlatformProbeResult>(resultPath);
}

async function executeMcpProbe(tempRoot: string): Promise<McpProbeResult> {
  const root = path.join(tempRoot, 'mcp');
  fs.mkdirSync(root, { recursive: true });
  const resultPath = path.join(tempRoot, 'mcp-probe.json');
  await run(
    process.execPath,
    [
      mcpProbePath,
      '--mcp',
      path.join(repositoryRoot, 'packages/mcp/dist/index.js'),
      '--core',
      path.join(repositoryRoot, 'packages/core/dist/index.js'),
      '--mcp-package-dir',
      path.join(repositoryRoot, 'packages/mcp'),
      '--root',
      root,
      '--result',
      resultPath,
    ],
    { timeoutMs: 180_000 },
  );
  return readJson<McpProbeResult>(resultPath);
}

function assertHostExit(exit: HostExit, label: string): void {
  ok(
    exit.code === 0 && !exit.timedOut,
    `${label} host did not exit cleanly: ${JSON.stringify(exit)}`,
  );
}

/** stdio 宿主必须完成握手、ping 与干净退出；stderr 不得出现未处理异常。 */
export function assertStdioProbe(result: PlatformProbeResult): void {
  ok(result.ok, `Platform probe failed: ${result.error ?? 'unknown error'}`);
  ok(result.stdio, 'stdio section is missing');
  ok(result.stdio.ping.alive === true, 'stdio ping did not report alive');
  assertHostExit(result.stdio.host, 'stdio');
  ok(result.stdio.stderr.trim() === '', `stdio host wrote stderr: ${result.stdio.stderr}`);
}

/** daemon 复用、token 拒绝、POSIX 私有权限与停止清理必须同时成立。 */
export function assertDaemonProbe(result: PlatformProbeResult): void {
  ok(result.daemon, 'daemon section is missing');
  const daemon = result.daemon;
  ok(daemon.first.running && daemon.second.running, 'daemon start did not report running');
  ok(
    daemon.first.serverInstanceId === daemon.second.serverInstanceId,
    'repeated daemon start created a second instance',
  );
  ok(daemon.metadata.tokenShape, 'daemon token does not match the fixed 64-hex shape');
  ok(daemon.metadata.serverInstanceId.length > 0, 'daemon metadata is missing serverInstanceId');
  ok(daemon.auth.missing.ok === false, 'socket accepted initialize without a token');
  ok(
    /UNAUTHORIZED/.test(daemon.auth.missing.error ?? ''),
    `missing-token rejection is not UNAUTHORIZED: ${daemon.auth.missing.error}`,
  );
  ok(daemon.auth.wrong.ok === false, 'socket accepted an incorrect token');
  ok(
    /UNAUTHORIZED/.test(daemon.auth.wrong.error ?? ''),
    `wrong-token rejection is not UNAUTHORIZED: ${daemon.auth.wrong.error}`,
  );
  ok(daemon.auth.correct.ok === true, 'socket rejected the correct token');
  ok(daemon.auth.correct.ping?.alive === true, 'authenticated ping did not report alive');
  ok(daemon.connected, 'connect -p did not produce the deterministic smoke output');
  ok(daemon.statusRunning.running === true, 'daemon status did not report running');
  ok(daemon.statusStopped.running === false, 'daemon status still reports running after stop');
  ok(daemon.lockRemoved, 'daemon lock was not removed after stop');
  if (process.platform !== 'win32') {
    ok(
      daemon.metadata.runtimeMode === 0o700,
      `runtime directory mode is ${daemon.metadata.runtimeMode}, expected 0700`,
    );
    ok(
      daemon.metadata.mode === 0o600,
      `daemon metadata mode is ${daemon.metadata.mode}, expected 0600`,
    );
  }
}

/** 取消后父进程与后代都必须退出；仅返回 cancel 响应不算进程树回收。 */
export function assertTreeProbe(result: PlatformProbeResult): void {
  ok(result.tree, 'tree section is missing');
  const tree = result.tree;
  ok(tree.aliveBefore.shell && tree.aliveBefore.child, 'tree fixture did not start both processes');
  ok(tree.outcome === 'cancelled', `tree run settled as ${tree.outcome}`);
  ok(!tree.aliveAfter.shell, 'shell process survived cancellation');
  ok(!tree.aliveAfter.child, 'descendant process survived cancellation');
  assertHostExit(tree.host, 'tree');
  ok(tree.stderr.trim() === '', `tree host wrote stderr: ${tree.stderr}`);
}

/** MCP 覆盖启动授权、调用、撤销、取消、重启与 teardown；任何一项缺失都不得判绿。 */
export function assertMcpProbe(result: McpProbeResult): void {
  ok(result.ok, `MCP probe failed: ${result.error ?? 'unknown error'}`);
  const startup = result.startupAuthorization;
  ok(startup, 'MCP startup authorization result is missing');
  for (const server of ['stdio', 'http'])
    ok(startup.readyServers.includes(server), `MCP ${server} server did not become ready`);
  ok(
    startup.authorizations.some((entry) => entry.server === 'stdio' && entry.type === 'stdio') &&
      startup.authorizations.some((entry) => entry.server === 'http' && entry.type === 'http'),
    'MCP startup authorization did not observe both transports',
  );
  ok(result.tools?.stdio.dangerous === true, 'stdio MCP tool must be marked dangerous');
  ok(result.tools?.http.dangerous === true, 'http MCP tool must be marked dangerous');
  ok(
    result.calls?.stdio === 'stdio:echo:hello',
    `Unexpected stdio call result: ${result.calls?.stdio}`,
  );
  ok(
    result.calls?.http === 'http:echo:hello',
    `Unexpected http call result: ${result.calls?.http}`,
  );
  ok(
    result.cancel?.dispatchedError === true,
    'cancelled MCP call did not report a dispatched error',
  );
  ok(result.cancel?.stillReady === true, 'MCP server was not ready after cancelling a call');
  ok(
    result.revoke?.status?.connectionState === 'disabled',
    'disableServer did not mark the server disabled',
  );
  ok(
    (result.revoke?.error ?? '').includes('MCP_SERVER_UNAVAILABLE'),
    `call after revoke was not rejected: ${result.revoke?.error}`,
  );
  ok(result.reenable?.call === 'http:echo:restored', 're-enabled MCP server did not serve calls');
  ok(
    result.denied?.failedServers.stdio !== undefined,
    'denied startup was not recorded as a failed server',
  );
  ok(
    result.denied?.readyServers.includes('http') === true,
    'approved server did not start after a denial',
  );
  ok(
    result.retry?.firstFailedServers.flaky !== undefined,
    'first flaky startup was not recorded as failed',
  );
  ok(
    result.retry?.status?.connectionState === 'ready',
    'reconnect did not bring the flaky server up',
  );
  ok(
    result.retry?.call === 'flaky:echo:retried',
    `Unexpected retry call result: ${result.retry?.call}`,
  );
  ok(result.close?.stdioAlive === false, 'stdio MCP server process survived teardown');
  ok(result.close?.managerTornDown === true, 'MCP manager was not marked torn down');
  ok(
    result.close?.sessionReady === false,
    `MCP session still reports ready after teardown (state: ${result.close?.sessionState})`,
  );
  ok((result.close?.httpCalls.initialized ?? 0) >= 1, 'HTTP MCP server was never initialized');
  ok((result.close?.httpCalls.callTool ?? 0) >= 1, 'HTTP MCP server never received a tool call');
}

function section(sections: Record<string, SectionRecord>, id: string, record: SectionRecord): void {
  sections[id] = record;
  const symbol =
    record.status === 'passed'
      ? '✔'
      : record.status === 'failed'
        ? '✘'
        : record.status === 'pending'
          ? '…'
          : '-';
  console.log(`${symbol} ${id}: ${record.status}${record.error ? ` — ${record.error}` : ''}`);
}

function writeEvidence(
  sections: Record<string, SectionRecord>,
  metadata: Record<string, unknown>,
): string {
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const commit = String(metadata.commit ?? 'unknown');
  const dirty = Boolean(metadata.worktreeDirty);
  const file = path.join(
    evidenceRoot,
    `platform-${commit.slice(0, 12)}${dirty ? '-dirty' : ''}.json`,
  );
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        ...metadata,
        sections,
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

async function main(): Promise<void> {
  const noBuild = process.argv.includes('--no-build');
  const skipArtifacts = process.argv.includes('--skip-artifacts');
  const keepTemp = process.argv.includes('--keep-temp');
  const allowPending = process.argv.includes('--allow-pending');
  const tempRoot = shortTemp('p');
  const sections: Record<string, SectionRecord> = {};
  const nodeSupport = evaluateNodeSupport(process.versions.node);
  const commit = git(['rev-parse', 'HEAD']);
  const worktreeDirty = git(['status', '--porcelain']).length > 0;
  const metadata = {
    node: process.versions.node,
    nodeMajor: nodeSupport.major,
    platform: process.platform,
    arch: process.arch,
    commit,
    worktreeDirty,
    allowPending,
  };

  if (nodeSupport.satisfiesMinimum)
    section(sections, 'environment', {
      status: 'passed',
      details: { node: process.versions.node, platform: process.platform, arch: process.arch },
    });
  else
    section(sections, 'environment', {
      status: 'failed',
      error: `Node ${process.versions.node} is below the supported >=20 baseline`,
    });

  let buildFailed = false;
  try {
    try {
      if (noBuild) {
        for (const relative of [
          'packages/core/dist/index.js',
          'packages/mcp/dist/index.js',
          'packages/cli/dist/bin.js',
        ])
          ok(
            fs.existsSync(path.join(repositoryRoot, relative)),
            `Missing build output ${relative}; run pnpm build first`,
          );
        section(sections, 'build', { status: 'passed', details: { skipped: true } });
      } else {
        await buildCandidate();
        section(sections, 'build', { status: 'passed', details: { skipped: false } });
      }
    } catch (error) {
      buildFailed = true;
      section(sections, 'build', {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (buildFailed) {
      for (const id of ['artifacts', 'stdio', 'daemon', 'tree', 'mcp'])
        section(sections, id, {
          status: 'pending',
          blockers: ['Candidate build failed; this section was not executed.'],
        });
    } else {
      if (skipArtifacts) {
        section(sections, 'artifacts', {
          status: 'pending',
          blockers: ['Skipped by --skip-artifacts'],
        });
      } else {
        try {
          const details = await executeArtifactChecks(path.join(tempRoot, 'artifacts'));
          section(sections, 'artifacts', { status: 'passed', details });
        } catch (error) {
          section(sections, 'artifacts', {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      let probe: PlatformProbeResult | undefined;
      try {
        probe = await executePlatformProbe(path.join(tempRoot, 'platform'));
        ok(probe.ok, `Platform probe failed: ${probe.error ?? 'unknown error'}`);
      } catch (error) {
        probe = undefined;
        for (const id of ['stdio', 'daemon', 'tree'])
          section(sections, id, {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
      }
      if (probe) {
        for (const [id, assertion] of [
          ['stdio', assertStdioProbe],
          ['daemon', assertDaemonProbe],
          ['tree', assertTreeProbe],
        ] as const) {
          try {
            assertion(probe);
            section(sections, id, { status: 'passed', details: probe[id] });
          } catch (error) {
            section(sections, id, {
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
              details: probe[id],
            });
          }
        }
        sections.daemon.details = {
          ...(sections.daemon.details as object),
          windowsShellCoverage:
            process.platform === 'win32'
              ? 'pending: run the process-tree check under both Git Bash and PowerShell'
              : 'not-applicable',
        };
      }

      try {
        const mcpProbe = await executeMcpProbe(path.join(tempRoot, 'mcp'));
        assertMcpProbe(mcpProbe);
        section(sections, 'mcp', { status: 'passed', details: mcpProbe });
      } catch (error) {
        section(sections, 'mcp', {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    if (!keepTemp) fs.rmSync(tempRoot, { recursive: true, force: true });
    else console.log(`Platform evidence scratch retained at ${tempRoot}`);
  }

  const node20Record: SectionRecord = nodeSupport.actualNode20
    ? { status: 'passed', details: { node: process.versions.node } }
    : {
        status: 'pending',
        blockers: [
          `Actual Node 20 install/run channel is required before release; this run used ${process.versions.node}.`,
        ],
      };
  section(sections, 'node20-channel', node20Record);
  const windowsOnly = process.platform === 'win32';
  section(sections, 'windows-acl', {
    status: windowsOnly ? 'pending' : 'not-applicable',
    blockers: windowsOnly
      ? [
          'Requires a second Windows user or isolated VM to prove cross-user credential/pipe denial.',
        ]
      : [],
  });
  section(sections, 'windows-conpty', {
    status: windowsOnly ? 'pending' : 'not-applicable',
    blockers: windowsOnly
      ? [
          'Requires the dedicated ConPTY terminal environment for paste, approval input and recovery.',
        ]
      : [],
  });
  section(sections, 'posix-pty', {
    status: windowsOnly ? 'not-applicable' : 'pending',
    blockers: windowsOnly
      ? []
      : [
          'Interactive PTY paste/approval/recovery acceptance is a separate terminal evidence item.',
        ],
  });

  const verdict = platformGateVerdict(sections, allowPending);
  const evidence = writeEvidence(sections, { ...metadata, verdict });
  const pending = Object.values(sections).filter((record) => record.status === 'pending').length;
  if (worktreeDirty)
    console.log('Worktree is dirty; evidence is marked and cannot stand in for a clean commit.');
  console.log(
    `Platform gate ${verdict.status}; ${pending} pending independent blocker(s)${allowPending ? ' (explicit --allow-pending for automated checks only)' : ''}. Evidence: ${path.relative(repositoryRoot, evidence)}`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\nPlatform evidence: **${verdict.status}**. Deferred independent acceptance: ${
        Object.entries(sections)
          .filter(([, record]) => record.status === 'pending')
          .map(([id]) => id)
          .join(', ') || 'none'
      }.\n`,
    );
  }
  process.exitCode = verdict.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
