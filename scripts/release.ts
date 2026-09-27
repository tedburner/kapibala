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
  const manifests = ['package.json', 'packages/core/package.json', 'packages/cli/package.json'].map(
    (file) => readJson(path.join(root, file)),
  );
  const cliSource = fs.readFileSync(path.join(root, 'packages/cli/src/version.ts'), 'utf8');
  const cliVersion = /CLI_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(cliSource)?.[1] ?? '';
  const version = validateRelease(tag, manifests, cliVersion);
  if (!fs.existsSync(path.join(root, `docs/releases/${tag}.md`)))
    throw new Error('Release notes are missing');
  return version;
}

function run(command: string, args: string[], capture = false): string {
  if (process.platform === 'win32' && command === 'npm') {
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    if (!fs.existsSync(npmCli)) throw new Error('Cannot locate the npm CLI bundled with Node.js');
    command = process.execPath;
    args = [npmCli, ...args];
  }
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
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

async function main(): Promise<void> {
  const [command, tag, destination] = process.argv.slice(2);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const version = checkWorkspace(root, tag ?? '');
  validateNpmVersion(run('npm', ['--version'], true).trim());
  if (command === 'check') {
    console.log(`Release version verified: ${version}`);
  } else if (command === 'publish' && destination) {
    await publish(root, tag, path.resolve(destination));
  } else if (command === 'notes' && destination) {
    const markdown = fs.readFileSync(path.join(root, `docs/releases/${tag}.md`), 'utf8');
    fs.writeFileSync(destination, createReleaseNotes(markdown, tag));
  } else {
    throw new Error('Usage: node scripts/release.ts check|publish|notes <tag> [destination]');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
