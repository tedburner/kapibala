import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
}

interface PublishedPackage extends Manifest {
  dist: { integrity: string };
}

interface RegistryMetadata {
  versions: Record<string, PublishedPackage | undefined>;
  'dist-tags'?: { latest?: string };
}

interface ExpectedPackage {
  name: string;
  version: string;
  integrity: string;
}

const registry = 'https://registry.npmjs.org';
const packageNames = ['@kiturone/kapibala', '@kiturone/kapibala-cli'];
const versionManifestFiles = [
  'package.json',
  'packages/core/package.json',
  'packages/cli/package.json',
];

/** 与发布标签同构的稳定版本号：major 可多位，minor/patch 只允许 0–9（十进制位进位）。 */
export const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.[0-9]\.[0-9]$/;

/** OIDC 发布要求 npm 11.5.1 或更新版本；版本不明时拒绝继续发布。 */
export function validateNpmVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid npm version');
  const [major, minor, patch] = version.split('.').map(Number);
  if (major < 11 || (major === 11 && (minor < 5 || (minor === 5 && patch < 1)))) {
    throw new Error('npm >=11.5.1 is required for trusted publishing');
  }
}

/** 发布标签、三个清单与 CLI 展示版本必须一致；只接受十进制位进位的稳定版本。 */
export function validateRelease(tag: string, manifests: Manifest[], cliVersion: string): string {
  if (!/^v(0|[1-9]\d*)\.[0-9]\.[0-9]$/.test(tag)) throw new Error(`Invalid release tag: ${tag}`);
  const version = tag.slice(1);
  if (manifests.length !== 3 || manifests.some((manifest) => manifest.version !== version)) {
    throw new Error('Release tag and package versions must match');
  }
  if (cliVersion !== version) throw new Error('CLI display version must match the release tag');
  if (manifests[1].name !== packageNames[0] || manifests[2].name !== packageNames[1]) {
    throw new Error('Unexpected release package names');
  }
  return version;
}

/** 十进制位进位推演下一版本：0.0.9 → 0.1.0，0.9.9 → 1.0.0。 */
export function nextVersion(current: string): string {
  if (!STABLE_VERSION_PATTERN.test(current)) throw new Error(`Invalid current version: ${current}`);
  const [major, minor, patch] = current.split('.').map(Number);
  if (patch < 9) return `${major}.${minor}.${patch + 1}`;
  if (minor < 9) return `${major}.${minor + 1}.0`;
  return `${major + 1}.0.0`;
}

/** 工作区版本唯一真源：三个清单与 CLI 展示版本必须完全一致，否则拒绝继续。 */
export function readWorkspaceVersion(root: string): string {
  const versions = new Set<string>();
  for (const file of versionManifestFiles) {
    versions.add(readJson(path.join(root, file)).version);
  }
  const cliSource = fs.readFileSync(path.join(root, 'packages/cli/src/version.ts'), 'utf8');
  versions.add(/CLI_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(cliSource)?.[1] ?? '');
  if (versions.size !== 1) throw new Error('Workspace versions are inconsistent across manifests');
  const version = [...versions][0];
  if (!version) throw new Error('Workspace versions are missing');
  return version;
}

/** 拒绝未补全的发布说明骨架，供本地流程与 CI 发布检查共用。 */
export function validateReleaseNotes(markdown: string): void {
  if (
    !markdown.trim() ||
    /<发布主题，发布前替换>|<发布前补全：一段话概述>|<发布日期>|<!-- 交付要点：能力、边界、已知限制，逐条列出 -->/.test(
      markdown,
    )
  ) {
    throw new Error('发布说明仍含占位内容，请补全后再发布');
  }
}

/** 已发布的版本不可覆盖；重试只允许跳过内容一致且 latest 正确的包，不允许回退 latest。 */
export function planPublication(
  expected: ExpectedPackage,
  metadata: RegistryMetadata,
): 'publish' | 'skip' {
  const latest = metadata['dist-tags']?.latest;
  if (latest) {
    if (!/^\d+\.\d+\.\d+$/.test(latest)) throw new Error(`Unexpected latest version: ${latest}`);
    const wanted = expected.version.split('.').map(Number);
    const current = latest.split('.').map(Number);
    const differentAt = wanted.findIndex((number, i) => number !== current[i]);
    if (differentAt >= 0 && current[differentAt] > wanted[differentAt]) {
      throw new Error(`Registry latest ${latest} is newer than ${expected.version}`);
    }
  }
  const existing = metadata.versions[expected.version];
  if (!existing) return 'publish';
  if (
    existing.name !== expected.name ||
    existing.version !== expected.version ||
    existing.dist?.integrity !== expected.integrity
  ) {
    throw new Error(
      `Existing ${expected.name}@${expected.version} integrity mismatch; cannot overwrite`,
    );
  }
  if (latest !== expected.version)
    throw new Error('Existing version has an inconsistent latest tag');
  return 'skip';
}

/** 匿名读取公开 registry，避免缓存误判；只有 404 表示不存在，鉴权、服务和格式错误均中止。 */
export async function readRegistry(
  name: string,
  fetcher: typeof fetch = fetch,
): Promise<RegistryMetadata> {
  const response = await fetcher(
    `${registry}/${encodeURIComponent(name)}?release-check=${Date.now()}`,
    {
      headers: { 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (response.status === 404) return { versions: {} };
  if (!response.ok) throw new Error(`Registry lookup failed for ${name}: HTTP ${response.status}`);
  const metadata = (await response.json()) as RegistryMetadata;
  if (
    !metadata ||
    !metadata.versions ||
    typeof metadata.versions !== 'object' ||
    Array.isArray(metadata.versions)
  ) {
    throw new Error(`Invalid registry metadata for ${name}`);
  }
  return metadata;
}

/** GitHub Release 中的文档链接固定到发布标签，避免相对链接或后续 main 变更改变含义。 */
export function createReleaseNotes(markdown: string, tag: string): string {
  const base = `https://github.com/tedburner/kapibala/blob/${tag}/docs/releases/`;
  return markdown.replace(
    /\]\((\.\.?\/[^\s)]+)\)/g,
    (_match, target: string) => `](${new URL(target, base).href})`,
  );
}

function readJson(file: string): Manifest {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
}

function checkWorkspace(root: string, tag: string): string {
  const manifests = versionManifestFiles.map((file) => readJson(path.join(root, file)));
  const cliSource = fs.readFileSync(path.join(root, 'packages/cli/src/version.ts'), 'utf8');
  const cliVersion = /CLI_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(cliSource)?.[1] ?? '';
  const version = validateRelease(tag, manifests, cliVersion);
  const notesFile = path.join(root, `docs/releases/${tag}.md`);
  if (!fs.existsSync(notesFile)) throw new Error('Release notes are missing');
  validateReleaseNotes(fs.readFileSync(notesFile, 'utf8'));
  return version;
}

function run(command: string, args: string[], capture = false, cwd?: string): string {
  if (process.platform === 'win32' && command === 'npm') {
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    if (!fs.existsSync(npmCli)) throw new Error('Cannot locate the npm CLI bundled with Node.js');
    command = process.execPath;
    args = [npmCli, ...args];
  }
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    cwd,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr ?? result.status}`);
  return result.stdout ?? '';
}

async function waitForPublication(expected: ExpectedPackage): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const metadata = await readRegistry(expected.name);
    if (metadata.versions[expected.version] && metadata['dist-tags']?.latest === expected.version) {
      planPublication(expected, metadata);
      console.log(`Verified ${expected.name}@${expected.version} in the public registry`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(`Registry propagation timed out for ${expected.name}; retry this workflow`);
}

async function publish(root: string, tag: string, directory: string): Promise<void> {
  const version = checkWorkspace(root, tag);
  const packages = packageNames.map((name) => {
    const filename = `${name.slice(1).replace('/', '-')}-${version}.tgz`;
    const file = path.join(directory, filename);
    const manifest = JSON.parse(
      run('tar', ['-xOf', file, 'package/package.json'], true),
    ) as Manifest;
    if (manifest.name !== name || manifest.version !== version)
      throw new Error(`Invalid packed manifest: ${filename}`);
    if (name === packageNames[0] && Object.keys(manifest.dependencies ?? {}).length)
      throw new Error('Core must have zero runtime dependencies');
    if (name === packageNames[1] && manifest.dependencies?.[packageNames[0]] !== version)
      throw new Error('Packed CLI must depend on the exact Core version; use pnpm pack');
    const entries = run('tar', ['-tzf', file], true).trim().split(/\r?\n/);
    if (
      entries.some(
        (entry) => !/^package\/(dist\/[^\r\n]+|LICENSE|README\.md|package\.json)$/.test(entry),
      )
    )
      throw new Error(`Unexpected package contents: ${filename}`);
    const content = fs.readFileSync(file);
    return {
      name,
      version,
      filename,
      file,
      integrity: `sha512-${createHash('sha512').update(content).digest('base64')}`,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  });
  // 两个包均通过预检后才写入 registry；顺序固定为 Core → CLI。
  const plans = await Promise.all(
    packages.map(async (entry) => planPublication(entry, await readRegistry(entry.name))),
  );
  for (const [i, entry] of packages.entries()) {
    if (plans[i] === 'publish')
      run('npm', [
        'publish',
        entry.file,
        '--access',
        'public',
        '--tag',
        'latest',
        '--registry',
        registry,
      ]);
    else console.log(`Already published, identical package: ${entry.name}@${version}`);
    await waitForPublication(entry);
  }
  fs.writeFileSync(
    path.join(directory, 'SHA256SUMS.txt'),
    packages.map((entry) => `${entry.sha256}  ${entry.filename}\n`).join(''),
  );
}

/** 判定安装失败是否为 registry CDN 传播延迟（新版本尚不可见）；其余失败不属于可重试范围。 */
export function isPropagationLag(message: string): boolean {
  return /ETARGET|notarget/i.test(message);
}

const SMOKE_INSTALL_ATTEMPTS = 10;
const SMOKE_INSTALL_DELAY_MS = 30_000;

/**
 * 在隔离目录从公共 registry 安装双包并验收 CLI 版本、帮助输出与 SDK ESM/CJS 导出。
 * registry API 确认可见后，CDN 边缘对 packument 的缓存仍可能落后数分钟；安装报
 * ETARGET/notarget 视为传播延迟并按有限次退避重试，其余错误立即中止，不掩盖真实故障。
 */
async function smokeInstall(root: string, tag: string, directory: string): Promise<void> {
  const version = checkWorkspace(root, tag);
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  // 显式 package.json 阻止 npm 沿目录树向上合并外层的依赖状态。
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: 'kapibala-registry-smoke', private: true }),
  );
  const install = [
    'install',
    '--prefix',
    directory,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--registry',
    registry,
    ...packageNames.map((name) => `${name}@${version}`),
  ];
  for (let attempt = 1; ; attempt += 1) {
    try {
      run('npm', install, true);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= SMOKE_INSTALL_ATTEMPTS || !isPropagationLag(message)) throw error;
      console.log(
        `Registry CDN has not served ${version} yet (attempt ${attempt}/${SMOKE_INSTALL_ATTEMPTS}); retrying in ${SMOKE_INSTALL_DELAY_MS / 1000}s`,
      );
      await new Promise((resolve) => setTimeout(resolve, SMOKE_INSTALL_DELAY_MS));
    }
  }
  const cliBin = path.join(directory, 'node_modules', packageNames[1], 'dist', 'bin.js');
  if (run('node', [cliBin, '--version'], true).trim() !== `kpbl v${version}`)
    throw new Error(`Registry-installed CLI version mismatch: expected kpbl v${version}`);
  run('node', [cliBin, '--help'], true);
  run(
    'node',
    [
      '--input-type=module',
      '-e',
      'import assert from "node:assert/strict"; import * as sdk from "@kiturone/kapibala"; assert.equal(typeof sdk.AgentSession, "function"); assert.equal(typeof sdk.SessionManager, "function")',
    ],
    true,
    directory,
  );
  run(
    'node',
    [
      '-e',
      'const assert = require("node:assert/strict"); assert.equal(typeof require("@kiturone/kapibala").AgentSession, "function")',
    ],
    true,
    directory,
  );
  console.log(`Registry smoke install verified ${version}`);
}

async function main(): Promise<void> {
  const [command, tag, destination] = process.argv.slice(2);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const version = checkWorkspace(root, tag ?? '');
  validateNpmVersion(run('npm', ['--version'], true).trim());
  if (command === 'check') {
    console.log(`Release version verified: ${version}`);
  } else if (command === 'publish' && destination) {
    await publish(root, tag, path.resolve(destination));
  } else if (command === 'smoke' && destination) {
    await smokeInstall(root, tag, path.resolve(destination));
  } else if (command === 'notes' && destination) {
    const markdown = fs.readFileSync(path.join(root, `docs/releases/${tag}.md`), 'utf8');
    fs.writeFileSync(destination, createReleaseNotes(markdown, tag));
  } else {
    throw new Error('Usage: node scripts/release.ts check|publish|smoke|notes <tag> [destination]');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
