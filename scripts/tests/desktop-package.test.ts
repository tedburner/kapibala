import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  assertPortableTree,
  candidatePreflight,
  desktopPackageConfig,
  writeNotices,
} from '../desktop-package.js';

const roots: string[] = [];
const temporary = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-pack-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('测试包固定来源、架构与隔离身份，不自动发布或冒充签名候选', () => {
  const root = temporary();
  const config = desktopPackageConfig({
    stage: root,
    output: path.join(root, 'output'),
    electronDist: path.join(root, 'electron'),
    electronVersion: '45.0.0',
  });
  expect(config).toMatchObject({
    appId: 'dev.kapibala.desktop.test',
    productName: 'Kapibala Test',
    asar: true,
    npmRebuild: false,
    allowMissingDependencies: false,
    publish: null,
    mac: { identity: '-', notarize: false },
    nsis: { deleteAppDataOnUninstall: false },
    directories: { app: root },
  });
  expect(() => candidatePreflight({}, 'darwin')).toThrow('SIGNING_REQUIRED');
  expect(() =>
    candidatePreflight(
      {
        CSC_LINK: 'not-a-real-certificate',
        APPLE_API_KEY: 'not-a-real-key',
        APPLE_API_KEY_ID: 'fixture',
        APPLE_API_ISSUER: 'fixture',
        APPLE_TEAM_ID: 'fixture',
        CSC_NAME: 'fixture',
        CSC_KEY_PASSWORD: 'fixture',
      },
      'darwin',
    ),
  ).toThrow('CANDIDATE_CI_REQUIRED');
});
it('依赖闭包拒绝逃逸链接、缺失依赖与工作区协议，不将开发目录混进安装包', () => {
  const root = temporary();
  const external = temporary();
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { required: '1.0.0' } }),
  );
  expect(() => assertPortableTree(root)).toThrow('DEPENDENCY_MISSING');
  fs.mkdirSync(path.join(root, 'node_modules/required'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'node_modules/required/package.json'),
    JSON.stringify({ name: 'required', version: '1.0.0' }),
  );
  assertPortableTree(root);
  fs.symlinkSync(
    external,
    path.join(root, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  expect(() => assertPortableTree(root)).toThrow('DEPENDENCY_ESCAPE');
});
it('许可清单保留实际包身份、全文与缺失状态，不把未知许可证补成 MIT', () => {
  const root = temporary();
  const output = temporary();
  fs.mkdirSync(path.join(root, 'node_modules/dep'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'app',
      version: '1.0.0',
      license: 'MIT',
      dependencies: { dep: '2.0.0' },
    }),
  );
  fs.writeFileSync(path.join(root, 'LICENSE'), 'app license');
  fs.writeFileSync(
    path.join(root, 'node_modules/dep/package.json'),
    JSON.stringify({ name: 'dep', version: '2.0.0', license: 'Apache-2.0' }),
  );
  fs.writeFileSync(path.join(root, 'node_modules/dep/LICENSE'), 'actual dependency license');
  const result = writeNotices(root, output);
  expect(result.find((item) => item.name === 'dep')).toMatchObject({
    version: '2.0.0',
    license: 'Apache-2.0',
    licenseTextMissing: false,
  });
  expect(fs.readFileSync(path.join(output, 'THIRD-PARTY-NOTICES.md'), 'utf8')).toContain(
    'actual dependency license',
  );
});
it('打包子进程只继承必需环境，签名、发布与模型凭证不能流入测试包工具', async () => {
  const { packagingEnvironment } = await import('../desktop-package.js');
  const env = packagingEnvironment({
    PATH: '/fixture/bin',
    TMPDIR: '/tmp',
    GH_TOKEN: 'fake-publish-token',
    CSC_LINK: 'fake-signing-link',
    OPENAI_API_KEY: 'fake-provider-credential',
    NODE_OPTIONS: '--require malicious',
  });
  expect(env).toEqual({
    PATH: '/fixture/bin',
    TMPDIR: '/tmp',
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  });
});
it('只移除 legacy deploy 指向原桌面包的辅助自链接，不放行其它外部依赖', async () => {
  const { removeDeploymentSelfLink } = await import('../desktop-package.js');
  const root = temporary();
  const source = temporary();
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: '@kiturone/kapibala-desktop', version: '1.0.0' }),
  );
  const alias = path.join(root, 'node_modules/.pnpm/node_modules/@kiturone/kapibala-desktop');
  fs.mkdirSync(path.dirname(alias), { recursive: true });
  fs.symlinkSync(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => assertPortableTree(root)).toThrow('DEPENDENCY_ESCAPE');
  removeDeploymentSelfLink(root, source);
  assertPortableTree(root);
  expect(fs.existsSync(alias)).toBe(false);
});
it('工作区协议只绑定实际同版本产物，清单改写不穿过硬链接污染原源码', async () => {
  const { normalizeWorkspaceRanges } = await import('../desktop-package.js');
  const root = temporary();
  const original = path.join(temporary(), 'source.json');
  const metadata = {
    name: '@kiturone/kapibala-desktop',
    version: '1.0.0',
    dependencies: { '@kiturone/kapibala': 'workspace:*' },
  };
  fs.writeFileSync(original, JSON.stringify(metadata));
  fs.linkSync(original, path.join(root, 'package.json'));
  const core = path.join(root, 'node_modules/@kiturone/kapibala');
  fs.mkdirSync(core, { recursive: true });
  fs.writeFileSync(
    path.join(core, 'package.json'),
    JSON.stringify({ name: '@kiturone/kapibala', version: '1.0.0' }),
  );
  expect(() => assertPortableTree(root)).toThrow('WORKSPACE_PROTOCOL_REMAINING');
  normalizeWorkspaceRanges(root, '1.0.0');
  assertPortableTree(root);
  expect(
    JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies[
      '@kiturone/kapibala'
    ],
  ).toBe('1.0.0');
  expect(JSON.parse(fs.readFileSync(original, 'utf8'))).toEqual(metadata);
});
it('原生 DMG 是显式的 macOS 测试选项，不能冒充目录包或在其它平台降级', async () => {
  const { packagingPlan } = await import('../desktop-package.js');
  expect(packagingPlan(['--native-dmg'], 'darwin')).toEqual({
    builderDirectory: true,
    nativeDmg: true,
    installer: true,
  });
  expect(packagingPlan(['--dir'], 'darwin')).toEqual({
    builderDirectory: true,
    nativeDmg: false,
    installer: false,
  });
  expect(() => packagingPlan(['--native-dmg', '--dir'], 'darwin')).toThrow('PACK_OPTIONS_CONFLICT');
  expect(() => packagingPlan(['--native-dmg'], 'linux')).toThrow('NATIVE_DMG_MAC_ONLY');
});

it('许可证附件包含内联到 Renderer 的依赖全文，即使它不在生产 node_modules 中', () => {
  const root = temporary();
  const output = temporary();
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'app', version: '1.0.0', license: 'MIT' }),
  );
  fs.writeFileSync(path.join(root, 'LICENSE'), 'application license');
  for (const part of ['renderer', 'preload']) {
    fs.mkdirSync(path.join(root, 'out', part), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'out', part, 'bundle-licenses.json'),
      JSON.stringify(
        part === 'renderer'
          ? [
              {
                name: 'bundled-ui',
                version: '2.0.0',
                license: 'MIT',
                texts: ['UI copyright and license'],
              },
            ]
          : [],
      ),
    );
  }
  const entries = writeNotices(root, output);
  expect(entries.find((item) => item.name === 'bundled-ui')).toMatchObject({
    version: '2.0.0',
    licenseTextMissing: false,
  });
  expect(fs.readFileSync(path.join(output, 'THIRD-PARTY-NOTICES.md'), 'utf8')).toContain(
    'UI copyright and license',
  );
});
it('上游预打包来源按自身版本登记，不能拿宿主包或其它版本许可冒充完整', async () => {
  const { collectBundledLicenses } = await import(
    '../../packages/desktop/scripts/bundle-notices.js'
  );
  const root = temporary();
  const owner = path.join(root, 'node_modules/ui');
  fs.mkdirSync(owner, { recursive: true });
  fs.writeFileSync(
    path.join(owner, 'package.json'),
    JSON.stringify({ name: 'ui', version: '2.0.0', license: 'MIT' }),
  );
  fs.writeFileSync(path.join(owner, 'LICENSE'), 'UI owner license');
  const file = path.join(owner, 'index.js');
  fs.writeFileSync(
    file,
    '//#region ../../node_modules/.pnpm/@vendor+base@1.0.0_react@19/node_modules/@vendor/base/index.js\nexport const value = 1;',
  );
  const unresolved = collectBundledLicenses([file]);
  expect(unresolved.find((item) => item.name === '@vendor/base')).toMatchObject({
    version: '1.0.0',
    license: 'UNKNOWN',
    texts: [],
  });
  const wrongVersion = collectBundledLicenses(
    [file],
    [{ name: '@vendor/base', version: '1.1.0', license: 'MIT', texts: ['wrong version license'] }],
  );
  expect(
    wrongVersion.find((item) => item.name === '@vendor/base' && item.version === '1.0.0')?.license,
  ).toBe('UNKNOWN');
  const exact = collectBundledLicenses(
    [file],
    [{ name: '@vendor/base', version: '1.0.0', license: 'MIT', texts: ['exact vendor license'] }],
  );
  expect(exact.find((item) => item.name === '@vendor/base')).toMatchObject({
    version: '1.0.0',
    texts: ['exact vendor license'],
  });
});
it('macOS 候选的完整审核主体与 builder selector 分离，不能将证书类型前缀传给 builder', () => {
  const root = temporary();
  const authority = 'Developer ID Application: Fixture Owner (ABCDE12345)';
  const config = desktopPackageConfig({
    stage: root,
    output: root,
    electronDist: root,
    electronVersion: '45.0.0',
    candidate: true,
    signingIdentity: authority,
  });
  expect(config.mac.identity).toBe('Fixture Owner (ABCDE12345)');
  expect(config.mac.notarize).toBe(true);
  expect(config.mac.hardenedRuntime).toBe(true);
});
