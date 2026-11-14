import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidatePolicy } from './desktop-candidate.js';
import { readWorkspaceVersion } from './release.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const inside = (root: string, target: string) =>
  target === root || target.startsWith(root + path.sep);
const json = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
interface Package {
  directory: string;
  manifest: {
    name: string;
    version: string;
    license?: string;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
}
function resolveDependency(from: string, name: string, root: string): string | undefined {
  if (!/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(name))
    throw new Error('DEPENDENCY_NAME_INVALID');
  for (let directory = from; inside(root, directory); directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', name, 'package.json');
    if (fs.existsSync(candidate)) return fs.realpathSync.native(path.dirname(candidate));
    if (directory === root) break;
  }
}
function closure(root: string, allowWorkspace = false): Package[] {
  root = fs.realpathSync.native(root);
  const queue = [root];
  const found = new Map<string, Package>();
  for (let index = 0; index < queue.length; index++) {
    const directory = queue[index];
    if (found.has(directory)) continue;
    if (!inside(root, directory)) throw new Error('DEPENDENCY_ESCAPE');
    const manifest = json(path.join(directory, 'package.json')) as Package['manifest'];
    found.set(directory, { directory, manifest });
    for (const [name, range] of Object.entries({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    })) {
      const target = resolveDependency(directory, name, root);
      if (!target) {
        if (manifest.optionalDependencies?.[name]) continue;
        throw new Error(`DEPENDENCY_MISSING: ${manifest.name} -> ${name}`);
      }
      if (range.startsWith('link:') || (range.startsWith('workspace:') && !allowWorkspace))
        throw new Error('WORKSPACE_PROTOCOL_REMAINING');
      queue.push(target);
    }
  }
  return [...found.values()];
}
function writeManifest(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
/** legacy deploy 的辅助自链接不属于运行依赖；仅移除确实指向本次源桌面包的链接，其它外链仍拒绝。 */
export function removeDeploymentSelfLink(stage: string, source: string): void {
  const alias = path.join(stage, 'node_modules/.pnpm/node_modules/@kiturone/kapibala-desktop');
  if (!fs.existsSync(alias) || !fs.lstatSync(alias).isSymbolicLink()) return;
  if (fs.realpathSync.native(alias) !== fs.realpathSync.native(source))
    throw new Error('DEPENDENCY_ESCAPE');
  fs.unlinkSync(alias);
}
/**
 * 工作区成员名单的唯一真源：从 packages/ 下实际存在的清单推导，不手工维护包名。
 * 新增或拆分工作区包（如 host 层）自动跟随；任何手工白名单都会在下次拆包时过期。
 */
export function workspacePackageNames(repository: string): Set<string> {
  const packagesDirectory = path.join(repository, 'packages');
  const names = new Set<string>();
  for (const entry of fs.readdirSync(packagesDirectory, { withFileTypes: true })) {
    const manifest = path.join(packagesDirectory, entry.name, 'package.json');
    if (!entry.isDirectory() || !fs.existsSync(manifest)) continue;
    const name = json(manifest).name;
    if (typeof name === 'string' && name) names.add(name);
  }
  if (names.size === 0) throw new Error('WORKSPACE_PACKAGES_EMPTY');
  return names;
}
/** 仅将同版本 Kapibala 工作区依赖改为实际精确版本；原子替换部署清单，避免硬链接改写源仓库。 */
export function normalizeWorkspaceRanges(
  stage: string,
  version: string,
  known: ReadonlySet<string>,
): void {
  const root = fs.realpathSync.native(stage);
  for (const { directory, manifest } of closure(root, true)) {
    let changed = false;
    for (const [name, range] of Object.entries(manifest.dependencies ?? {}))
      if (range.startsWith('workspace:')) {
        const resolved = resolveDependency(directory, name, root)!;
        const dependency = json(path.join(resolved, 'package.json'));
        if (
          !known.has(manifest.name) ||
          !known.has(name) ||
          dependency.name !== name ||
          dependency.version !== version ||
          manifest.version !== version
        )
          throw new Error('WORKSPACE_VERSION_MISMATCH');
        manifest.dependencies![name] = dependency.version;
        changed = true;
      }
    if (changed) writeManifest(path.join(directory, 'package.json'), manifest);
  }
}
/** 部署树的每条链接必须留在自身目录，全部生产依赖可解析；不允许从开发机补缺或容忍缺失。 */
export function assertPortableTree(directory: string): void {
  const root = fs.realpathSync.native(directory);
  const queue = [root];
  for (let index = 0; index < queue.length; index++)
    for (const entry of fs.readdirSync(queue[index], { withFileTypes: true })) {
      const file = path.join(queue[index], entry.name);
      if (entry.isSymbolicLink()) {
        if (!inside(root, fs.realpathSync.native(file))) throw new Error('DEPENDENCY_ESCAPE');
      } else if (entry.isDirectory()) queue.push(file);
    }
  closure(root);
}
/** 正式候选要求签名凭证与受控 CI 来源，不能通过测试构建参数降级。 */
export function candidatePreflight(
  env: Record<string, string | undefined>,
  platform = process.platform,
) {
  return candidatePolicy(env, platform);
}
/** 只配置原生当前平台的测试安装器；显式禁用发布与依赖重建，不碰共享用户数据。 */
export function desktopPackageConfig(input: {
  stage: string;
  output: string;
  electronDist: string;
  electronVersion: string;
  candidate?: boolean;
  signingIdentity?: string;
}) {
  return {
    appId: input.candidate ? 'dev.kapibala.desktop' : 'dev.kapibala.desktop.test',
    productName: input.candidate ? 'Kapibala' : 'Kapibala Test',
    executableName: input.candidate ? 'Kapibala' : 'Kapibala Test',
    directories: { app: input.stage, output: input.output },
    electronDist: input.electronDist,
    electronVersion: input.electronVersion,
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    allowMissingDependencies: false,
    publish: null,
    forceCodeSigning: input.candidate && process.platform !== 'linux',
    files: [
      'out/**/*',
      'package.json',
      'LICENSE',
      'THIRD-PARTY-NOTICES.md',
      'dependency-licenses.json',
      'licenses/**/*',
    ],
    artifactName: input.candidate
      ? 'Kapibala-${version}-${os}-${arch}.${ext}'
      : 'Kapibala-${version}-${os}-${arch}-test.${ext}',
    mac: {
      icon: path.join(input.stage, 'out/main/icon.png'),
      target: ['dmg'],
      // builder 会拒绝证书类型前缀；这里只转换 selector，实际 Authority 校验仍使用完整 CSC_NAME。
      identity: input.candidate
        ? input.signingIdentity?.replace(/^Developer ID Application:\s*/, '')
        : '-',
      notarize: Boolean(input.candidate),
      hardenedRuntime: Boolean(input.candidate),
      ...(input.candidate
        ? {
            entitlements: path.join(repository, 'packages/desktop/build/entitlements.mac.plist'),
            entitlementsInherit: path.join(
              repository,
              'packages/desktop/build/entitlements.mac.plist',
            ),
          }
        : {}),
      minimumSystemVersion: '14.0',
      category: 'public.app-category.developer-tools',
    },
    dmg: { sign: Boolean(input.candidate) },
    win: {
      target: ['nsis', 'zip'],
      signAndEditExecutable: Boolean(input.candidate),
      icon: path.join(input.stage, 'out/main/icon.png'),
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      deleteAppDataOnUninstall: false,
    },
    linux: {
      target: ['AppImage'],
      category: 'Development',
      executableName: input.candidate ? 'kapibala' : 'kapibala-test',
      icon: path.join(input.stage, 'out/main/icon.png'),
    },
  };
}
/** 许可证来自部署后的实际依赖与随包全文；缺失明确标记，不能用推测的许可证填空。 */
export function writeNotices(stage: string, output: string) {
  const sections: string[] = ['# Kapibala test build — dependency notices\n'];
  const entries = closure(stage)
    .map(({ directory, manifest }) => {
      const files = fs
        .readdirSync(directory)
        .filter(
          (name) =>
            /^(licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(name) &&
            fs.statSync(path.join(directory, name)).isFile(),
        );
      const texts = files.map(
        (name) => `### ${name}\n\n${fs.readFileSync(path.join(directory, name), 'utf8')}`,
      );
      if (
        !files.length &&
        [
          '@kiturone/kapibala',
          '@kiturone/kapibala-cli',
          '@kiturone/kapibala-mcp',
          '@kiturone/kapibala-desktop',
        ].includes(manifest.name)
      )
        texts.push(
          `### Workspace LICENSE\n\n${fs.readFileSync(path.join(stage, 'LICENSE'), 'utf8')}`,
        );
      sections.push(
        `## ${manifest.name}@${manifest.version}\n\nLicense: ${manifest.license ?? 'UNKNOWN'}\n\n${texts.join('\n\n') || 'License text not supplied by installed package; review pending.'}`,
      );
      return {
        name: manifest.name,
        version: manifest.version,
        license: manifest.license ?? 'UNKNOWN',
        licenseTextMissing: texts.length === 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  // 生产依赖树不含已经内联的 Renderer/Preload 包；附件来自同次构建的实际模块清单。
  for (const part of ['preload', 'renderer']) {
    const file = path.join(stage, 'out', part, 'bundle-licenses.json');
    if (!fs.existsSync(file)) {
      if (fs.existsSync(path.join(stage, 'out', part))) throw new Error('BUNDLE_LICENSES_REQUIRED');
      continue;
    }
    const bundled = json(file) as {
      name: string;
      version: string;
      license: string;
      texts: string[];
    }[];
    if (!Array.isArray(bundled)) throw new Error('BUNDLE_LICENSES_INVALID');
    for (const item of bundled) {
      if (
        typeof item.name !== 'string' ||
        typeof item.version !== 'string' ||
        typeof item.license !== 'string' ||
        !Array.isArray(item.texts) ||
        item.texts.some((text) => typeof text !== 'string')
      )
        throw new Error('BUNDLE_LICENSES_INVALID');
      if (entries.some((entry) => entry.name === item.name && entry.version === item.version))
        continue;
      entries.push({
        name: item.name,
        version: item.version,
        license: item.license,
        licenseTextMissing: item.texts.length === 0,
      });
      sections.push(
        `## ${item.name}@${item.version} (bundled)\n\nLicense: ${item.license}\n\n${item.texts.join('\n\n') || 'License text not supplied; review pending.'}`,
      );
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'THIRD-PARTY-NOTICES.md'), sections.join('\n\n'));
  fs.writeFileSync(path.join(output, 'dependency-licenses.json'), JSON.stringify(entries, null, 2));
  return entries;
}
/** 测试打包不继承签名、发布、模型凭证或 Node 注入参数，只保留工具和系统必需环境。 */
export function packagingEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = { CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  for (const key of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'SystemRoot',
    'WINDIR',
    'PATHEXT',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'DISPLAY',
    'XAUTHORITY',
    'CI',
  ])
    if (env[key]) result[key] = env[key]!;
  return result;
}
function command(
  binary: string,
  args: string[],
  cwd: string,
  env = process.env,
  logFile?: string,
): string {
  const fd = logFile ? fs.openSync(logFile, 'w') : undefined;
  try {
    const result = spawnSync(binary, args, {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      ...(fd === undefined ? {} : { stdio: ['ignore', fd, fd] as const }),
    });
    const output = logFile
      ? fs.readFileSync(logFile, 'utf8')
      : `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.status !== 0)
      throw new Error(
        `${path.basename(binary)} ${args[0]} failed (${result.status}): ${result.error?.message ?? ''}\n${output.slice(-16_000)}`,
      );
    return logFile ? output : (result.stdout ?? '').trim();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function pnpm(args: string[], cwd = repository, env = process.env, logFile?: string): string {
  const executable = process.env.npm_execpath;
  if (!executable || !/pnpm/i.test(executable)) throw new Error('RUN_WITH_PNPM');
  // pnpm 12+ 的 npm_execpath 可能是 JS 入口（pnpm.cjs/pnpm.mjs，用 node 执行），也可能是
  // 原生启动器（如 npm 执行安装时指向 node_modules/.bin/pnpm 的 Mach-O/PE，直接执行）；
  // .cmd/.bat 垫片无法安全无 shell 派生，明确失败而不是静默交给 shell 解析。
  const scripted = /\.(?:[cm]?js)$/i.test(executable);
  const shim = /\.(?:cmd|bat)$/i.test(executable);
  if (shim)
    throw new Error(
      `RUN_WITH_PNPM: npm_execpath 指向 ${executable}（.cmd/.bat 垫片）；请改用 pnpm.mjs/pnpm.exe 入口运行打包。`,
    );
  return command(
    scripted ? process.execPath : executable,
    scripted ? [executable, ...args] : args,
    cwd,
    { ...env, pnpm_config_verify_deps_before_run: 'false' },
    logFile,
  );
}
/** 原生 DMG 只用于显式的 macOS 测试封装，记录与默认 builder 后端的区别；不自动改变候选策略。 */
export function packagingPlan(args: string[], platform = process.platform) {
  if (args.some((arg) => !['--dir', '--no-verify', '--native-dmg'].includes(arg)))
    throw new Error('UNKNOWN_PACK_OPTION');
  const nativeDmg = args.includes('--native-dmg');
  if (nativeDmg && platform !== 'darwin') throw new Error('NATIVE_DMG_MAC_ONLY');
  if (nativeDmg && args.includes('--dir')) throw new Error('PACK_OPTIONS_CONFLICT');
  return {
    builderDirectory: nativeDmg || args.includes('--dir'),
    nativeDmg,
    installer: !args.includes('--dir'),
  };
}
/** 先验证再隔离部署、原生打包；输出只落入本仓库忽略目录，不安装到系统、不上传或升版。 */
export async function packDesktop(args: string[]): Promise<void> {
  if (args.includes('--help')) {
    process.stdout.write(
      'pnpm pack:desktop [--dir | --native-dmg] [--no-verify]\n默认验证后生成本机测试安装包、安装副本验收、SHA256 与许可证清单。\n--dir 仅生成应用目录；--no-verify 为调试构建，不能作为发布证据。\n--candidate 仅接受受控签名 CI、干净冻结提交与完整签名身份；禁止 --dir、--no-verify、--native-dmg。\n',
    );
    return;
  }
  const candidate = args.includes('--candidate');
  const provenance = candidate ? candidatePreflight(process.env) : undefined;
  if (candidate && args.some((arg) => ['--dir', '--no-verify', '--native-dmg'].includes(arg)))
    throw new Error('CANDIDATE_OPTIONS_FORBIDDEN');
  const plan = packagingPlan(args.filter((arg) => arg !== '--candidate'));
  if (candidate && command('git', ['status', '--porcelain'], repository))
    throw new Error('CANDIDATE_WORKTREE_DIRTY');
  if (candidate && command('git', ['rev-parse', 'HEAD'], repository) !== provenance!.commit)
    throw new Error('CANDIDATE_SHA_MISMATCH');
  if (
    !['darwin', 'win32', 'linux'].includes(process.platform) ||
    !['x64', 'arm64'].includes(process.arch) ||
    (process.platform !== 'darwin' && process.arch !== 'x64')
  )
    throw new Error('UNSUPPORTED_NATIVE_TARGET');
  const desktop = path.join(repository, 'packages/desktop');
  if (!fs.existsSync(path.join(desktop, 'node_modules/electron/dist/version')))
    throw new Error(
      'ELECTRON_RUNTIME_REQUIRED: pnpm --filter @kiturone/kapibala-desktop exec install-electron',
    );
  const version = readWorkspaceVersion(repository);
  if (json(path.join(desktop, 'package.json')).version !== version)
    throw new Error('DESKTOP_VERSION_MISMATCH');
  const verified = !args.includes('--no-verify');
  process.stdout.write(verified ? '验证桌面构建…\n' : '调试构建：跳过校验，不能作为发布证据。\n');
  pnpm(verified ? ['verify:desktop'] : ['build:desktop']);
  const sourceSha = command('git', ['rev-parse', 'HEAD'], repository);
  const dirty = command('git', ['status', '--porcelain'], repository).length > 0;
  const build = {
    kind: candidate ? 'candidate' : 'test',
    sourceSha,
    dirty,
    platform: process.platform,
    arch: process.arch,
    verification: verified ? 'passed' : 'skipped',
    ...(provenance ? { runId: provenance.runId, runAttempt: provenance.runAttempt } : {}),
  };
  if (candidate && dirty) throw new Error('CANDIDATE_WORKTREE_DIRTY');
  const output = path.join(
    repository,
    '.workbuddy/desktop-pack',
    `${version}-${process.platform}-${process.arch}-${randomUUID()}`,
  );
  const stage = path.join(output, 'stage');
  const artifacts = path.join(output, 'artifacts');
  process.stdout.write('部署独立生产依赖…\n');
  // legacy deploy 按共享 lockfile 重放依赖树，仍需读取 registry 元数据；CI 的元数据缓存不完整，
  // --offline 会在任何干净机器上解析失败（本机能过只是缓存恰好齐全）。改为 prefer-offline：
  // 有缓存用缓存、缺失时联网补齐，并用 --frozen-lockfile 把解析钉死在共享 lockfile 上防版本漂移。
  pnpm([
    '--filter',
    '@kiturone/kapibala-desktop',
    'deploy',
    '--legacy',
    '--prod',
    '--prefer-offline',
    '--frozen-lockfile',
    '--ignore-scripts',
    stage,
  ]);
  fs.copyFileSync(path.join(repository, 'LICENSE'), path.join(stage, 'LICENSE'));
  const manifest = json(path.join(stage, 'package.json'));
  manifest.kapibalaBuild = build;
  manifest.devDependencies = undefined;
  manifest.scripts = undefined;
  writeManifest(path.join(stage, 'package.json'), manifest);
  removeDeploymentSelfLink(stage, desktop);
  normalizeWorkspaceRanges(stage, version, workspacePackageNames(repository));
  assertPortableTree(stage);
  const licenses = writeNotices(stage, stage);
  fs.mkdirSync(artifacts, { recursive: true });
  for (const file of ['THIRD-PARTY-NOTICES.md', 'dependency-licenses.json'])
    fs.copyFileSync(path.join(stage, file), path.join(artifacts, file));
  const electronDist = path.join(desktop, 'node_modules/electron/dist');
  const electronVersion = json(path.join(desktop, 'node_modules/electron/package.json')).version;
  for (const destination of [stage, artifacts]) {
    const notices = path.join(destination, 'licenses/electron');
    fs.mkdirSync(notices, { recursive: true });
    for (const file of ['LICENSE', 'LICENSES.chromium.html'])
      fs.copyFileSync(path.join(electronDist, file), path.join(notices, file));
    fs.appendFileSync(
      path.join(destination, 'THIRD-PARTY-NOTICES.md'),
      `\n\n## Electron ${electronVersion}\n\nElectron and bundled Chromium/Node notices: [LICENSE](licenses/electron/LICENSE), [LICENSES.chromium.html](licenses/electron/LICENSES.chromium.html).\n`,
    );
  }
  const config = desktopPackageConfig({
    stage,
    output: artifacts,
    electronDist,
    electronVersion,
    candidate,
    signingIdentity: process.env.CSC_NAME,
  });
  const buildEnvironment = packagingEnvironment(process.env);
  if (candidate) {
    buildEnvironment.CSC_IDENTITY_AUTO_DISCOVERY = 'true';
    for (const key of [
      'CSC_LINK',
      'CSC_KEY_PASSWORD',
      'CSC_NAME',
      'APPLE_TEAM_ID',
      'APPLE_API_KEY',
      'APPLE_API_KEY_ID',
      'APPLE_API_ISSUER',
    ])
      if (process.env[key]) buildEnvironment[key] = process.env[key]!;
  }
  const configFile = path.join(output, 'builder.json');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  process.stdout.write('生成原生测试包…\n');
  pnpm(
    [
      'exec',
      'electron-builder',
      '--projectDir',
      desktop,
      '--config',
      configFile,
      '--publish',
      'never',
      ...(plan.builderDirectory ? ['--dir'] : []),
    ],
    desktop,
    buildEnvironment,
    path.join(output, 'builder.log'),
  );
  if (plan.nativeDmg) {
    const appDirectory = path.join(artifacts, process.arch === 'arm64' ? 'mac-arm64' : 'mac');
    fs.symlinkSync('/Applications', path.join(appDirectory, 'Applications'));
    command(
      'hdiutil',
      [
        'create',
        '-volname',
        'Kapibala Test',
        '-srcfolder',
        appDirectory,
        '-format',
        'UDZO',
        path.join(artifacts, `Kapibala-${version}-mac-${process.arch}-test.dmg`),
      ],
      repository,
      packagingEnvironment(process.env),
      path.join(output, 'dmg.log'),
    );
  }
  let signing: { verified: boolean; identity: string; notarizationId?: string; teamId?: string } = {
    verified: false,
    identity: 'test-only',
  };
  if (candidate) {
    if (process.platform === 'darwin') {
      const application = path.join(
        artifacts,
        process.arch === 'arm64' ? 'mac-arm64' : 'mac',
        'Kapibala.app',
      );
      command('codesign', ['--verify', '--deep', '--strict', application], repository);
      // codesign 将签名身份写入 stderr；同时核对团队与完整主体，不能只看验签命令成功。
      const identity = spawnSync('codesign', ['--display', '--verbose=4', application], {
        encoding: 'utf8',
      }).stderr;
      if (
        !identity?.includes(`TeamIdentifier=${process.env.APPLE_TEAM_ID}`) ||
        !identity.includes(`Authority=${process.env.CSC_NAME}`)
      )
        throw new Error('SIGNING_IDENTITY_MISMATCH');
      command('xcrun', ['stapler', 'validate', application], repository);
      command('spctl', ['--assess', '--type', 'execute', '--verbose=4', application], repository);
      const dmg = fs.readdirSync(artifacts).find((name) => name.endsWith('.dmg'));
      if (!dmg) throw new Error('INSTALLER_MISSING');
      const disk = path.join(artifacts, dmg);
      command('codesign', ['--verify', '--strict', disk], repository);
      const notarized = JSON.parse(
        command(
          'xcrun',
          [
            'notarytool',
            'submit',
            disk,
            '--key',
            process.env.APPLE_API_KEY!,
            '--key-id',
            process.env.APPLE_API_KEY_ID!,
            '--issuer',
            process.env.APPLE_API_ISSUER!,
            '--wait',
            '--output-format',
            'json',
          ],
          repository,
          buildEnvironment,
        ),
      );
      if (notarized.status !== 'Accepted') throw new Error('NOTARIZATION_REJECTED');
      command('xcrun', ['stapler', 'staple', disk], repository);
      command('xcrun', ['stapler', 'validate', disk], repository);
      signing = {
        verified: true,
        identity: process.env.CSC_NAME!,
        notarizationId: notarized.id,
        teamId: process.env.APPLE_TEAM_ID!,
      };
    } else if (process.platform === 'win32') {
      const application = path.join(artifacts, 'win-unpacked', 'Kapibala.exe');
      const installers = fs
        .readdirSync(artifacts)
        .filter((name) => name.endsWith('.exe'))
        .map((name) => path.join(artifacts, name));
      for (const file of [application, ...installers]) {
        const signature = JSON.parse(
          command(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              'Get-AuthenticodeSignature -LiteralPath $env:KPBL_SIGN_FILE | Select-Object Status,@{Name="Thumbprint";Expression={$_.SignerCertificate.Thumbprint}} | ConvertTo-Json -Compress',
            ],
            repository,
            { ...packagingEnvironment(process.env), KPBL_SIGN_FILE: file },
          ),
        );
        if (
          signature.Status !== 0 ||
          String(signature.Thumbprint).toUpperCase() !==
            process.env.KPBL_WINDOWS_SIGNER_THUMBPRINT!.toUpperCase()
        )
          throw new Error('SIGNING_IDENTITY_MISMATCH');
      }
      signing = {
        verified: true,
        identity: process.env.KPBL_WINDOWS_SIGNER_THUMBPRINT!.toUpperCase(),
      };
    } else signing = { verified: true, identity: 'not-required' };
  }
  // 真正启动安装包复制后的二进制；不能用源码 Electron 测试替代依赖闭包验证。
  const smokeResult = path.join(artifacts, 'packaged-smoke.json');
  let source: string;
  let mount: string | undefined;
  if (process.platform === 'darwin') {
    if (plan.installer) {
      const dmg = fs.readdirSync(artifacts).find((name) => name.endsWith('.dmg'));
      if (!dmg) throw new Error('INSTALLER_MISSING');
      mount = path.join(output, 'mounted');
      fs.mkdirSync(mount);
      command(
        'hdiutil',
        ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, path.join(artifacts, dmg)],
        repository,
      );
    }
    source = path.join(
      mount ?? path.join(artifacts, 'mac-arm64'),
      candidate ? 'Kapibala.app' : 'Kapibala Test.app',
    );
    if (!fs.existsSync(source) && !mount)
      source = path.join(artifacts, 'mac', candidate ? 'Kapibala.app' : 'Kapibala Test.app');
  } else
    source = path.join(artifacts, process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked');
  try {
    if (!fs.existsSync(source)) throw new Error('PACKAGED_APPLICATION_MISSING');
    pnpm(
      ['exec', 'playwright', 'test', '--config', 'playwright.packaged.config.ts'],
      desktop,
      {
        ...packagingEnvironment(process.env),
        KPBL_PACKAGED_SOURCE: source,
        KPBL_PACKAGED_SMOKE_RESULT: smokeResult,
        KPBL_PACKAGED_KIND: candidate ? 'candidate' : 'test',
      },
      path.join(output, 'smoke.log'),
    );
  } finally {
    if (mount) command('hdiutil', ['detach', mount], repository);
  }
  const assets = [
    ...fs.readdirSync(artifacts),
    'licenses/electron/LICENSE',
    'licenses/electron/LICENSES.chromium.html',
  ]
    .filter(
      (name) =>
        (/\.(?:dmg|exe|zip|AppImage|json|md|html|blockmap)$/.test(name) ||
          name.endsWith('/LICENSE')) &&
        fs.statSync(path.join(artifacts, name)).isFile(),
    )
    .map((name) => ({
      name,
      sha256: createHash('sha256')
        .update(fs.readFileSync(path.join(artifacts, name)))
        .digest('hex'),
    }));
  fs.writeFileSync(
    path.join(artifacts, 'SHA256SUMS.txt'),
    `${assets.map((asset) => `${asset.sha256}  ${asset.name}`).join('\n')}\n`,
  );
  fs.writeFileSync(
    path.join(artifacts, candidate ? 'candidate-build.json' : 'test-build.json'),
    JSON.stringify(
      {
        ...build,
        version,
        electronVersion,
        signedCandidate: candidate && signing.verified,
        signing,
        installer: plan.installer,
        containerBackend: plan.nativeDmg ? 'hdiutil' : 'electron-builder',
        licenseReviewPending: true,
        missingLicenseData: licenses.some(
          (item) => item.license === 'UNKNOWN' || item.licenseTextMissing,
        ),
        assets,
      },
      null,
      2,
    ),
  );
  if (candidate && licenses.some((item) => item.license === 'UNKNOWN' || item.licenseTextMissing))
    throw new Error('LICENSE_INVENTORY_INCOMPLETE');
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `artifacts=${artifacts}\n`);
  process.stdout.write(`${candidate ? '候选' : '测试'}产物：${artifacts}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void packDesktop(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
