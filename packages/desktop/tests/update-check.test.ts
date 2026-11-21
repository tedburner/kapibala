import { describe, expect, it, vi } from 'vitest';
import {
  type ReleaseAsset,
  checkForDesktopUpdate,
  compareVersions,
  matchDesktopAssets,
  resolveDesktopTarget,
} from '../src/main/update-check.js';

const assets: ReleaseAsset[] = [
  {
    name: 'kiturone-kapibala-0.1.4.tgz',
    browser_download_url: 'https://example.test/corem.tgz',
    size: 10,
  },
  {
    name: 'Kapibala-0.1.4-mac-arm64-test.dmg',
    browser_download_url: 'https://example.test/mac-arm64.dmg',
    size: 100,
  },
  {
    name: 'Kapibala-0.1.4-mac-x64-test.dmg',
    browser_download_url: 'https://example.test/mac-x64.dmg',
    size: 101,
  },
  {
    name: 'Kapibala-0.1.4-win-x64-test.exe',
    browser_download_url: 'https://example.test/win-x64.exe',
    size: 102,
  },
  {
    name: 'Kapibala-0.1.4-linux-x64-test.AppImage',
    browser_download_url: 'https://example.test/linux-x64.AppImage',
    size: 103,
  },
  {
    name: 'SHA256SUMS-mac-arm64.txt',
    browser_download_url: 'https://example.test/SHA256SUMS-mac-arm64.txt',
    size: 1,
  },
  {
    name: 'SHA256SUMS-mac-x64.txt',
    browser_download_url: 'https://example.test/SHA256SUMS-mac-x64.txt',
    size: 1,
  },
  {
    name: 'SHA256SUMS-win-x64.txt',
    browser_download_url: 'https://example.test/SHA256SUMS-win-x64.txt',
    size: 1,
  },
  {
    name: 'SHA256SUMS-linux-x64.txt',
    browser_download_url: 'https://example.test/SHA256SUMS-linux-x64.txt',
    size: 1,
  },
];

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function releaseOf(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: 'v0.1.4',
    html_url: 'https://github.com/tedburner/kapibala/releases/tag/v0.1.4',
    assets,
    ...overrides,
  };
}

describe('版本比较与目标映射', () => {
  it('按 semver 比较，预发布低于同号正式版', () => {
    expect(compareVersions('0.1.3', 'v0.1.4')).toBe(-1);
    expect(compareVersions('v0.1.4', '0.1.4')).toBe(0);
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('0.1.4-beta.1', '0.1.4')).toBe(-1);
    expect(compareVersions('0.1.4', '0.1.4-beta.1')).toBe(1);
    expect(compareVersions('not-a-version', '0.1.4')).toBeUndefined();
  });

  it('只映射发布矩阵里的四个 target', () => {
    expect(resolveDesktopTarget('darwin', 'arm64')).toBe('darwin-arm64');
    expect(resolveDesktopTarget('darwin', 'x64')).toBe('darwin-x64');
    expect(resolveDesktopTarget('win32', 'x64')).toBe('win32-x64');
    expect(resolveDesktopTarget('linux', 'x64')).toBe('linux-x64');
    expect(resolveDesktopTarget('win32', 'arm64')).toBeUndefined();
    expect(resolveDesktopTarget('linux', 'arm64')).toBeUndefined();
  });
});

describe('资产匹配', () => {
  it('按平台挑安装包并配对同平台摘要清单', () => {
    const mac = matchDesktopAssets(assets, 'darwin-arm64');
    expect(mac?.installer.name).toBe('Kapibala-0.1.4-mac-arm64-test.dmg');
    expect(mac?.checksum.name).toBe('SHA256SUMS-mac-arm64.txt');
    expect(matchDesktopAssets(assets, 'win32-x64')?.installer.name).toBe(
      'Kapibala-0.1.4-win-x64-test.exe',
    );
    expect(matchDesktopAssets(assets, 'linux-x64')?.installer.name).toBe(
      'Kapibala-0.1.4-linux-x64-test.AppImage',
    );
  });

  it('缺安装包或缺摘要清单都返回 undefined，不做模糊猜测', () => {
    const onlySources = assets.filter(
      (asset) => asset.name.endsWith('.tgz') || asset.name === 'SHA256SUMS-mac-arm64.txt',
    );
    expect(matchDesktopAssets(onlySources, 'darwin-arm64')).toBeUndefined();
    const noChecksum = assets.filter((asset) => !asset.name.startsWith('SHA256SUMS'));
    expect(matchDesktopAssets(noChecksum, 'darwin-arm64')).toBeUndefined();
  });

  it('允许回退到单份通用 SHA256SUMS.txt', () => {
    const generic = [
      ...assets.filter((asset) => !asset.name.startsWith('SHA256SUMS-')),
      {
        name: 'SHA256SUMS.txt',
        browser_download_url: 'https://example.test/SHA256SUMS.txt',
        size: 1,
      },
    ];
    expect(matchDesktopAssets(generic, 'darwin-x64')?.checksum.name).toBe('SHA256SUMS.txt');
  });
});

describe('checkForDesktopUpdate 状态分支', () => {
  const base = { currentVersion: '0.1.3', platform: 'darwin' as const, arch: 'arm64' };

  it('有新版本且资产齐全时返回 update-available', async () => {
    const result = await checkForDesktopUpdate({
      ...base,
      fetch: async () => response(releaseOf()),
    });
    expect(result.status).toBe('update-available');
    expect(result.latestVersion).toBe('0.1.4');
    expect(result.installer?.name).toBe('Kapibala-0.1.4-mac-arm64-test.dmg');
    expect(result.checksum?.name).toBe('SHA256SUMS-mac-arm64.txt');
    expect(result.releaseUrl).toContain('/releases/tag/v0.1.4');
  });

  it('同版本或更高版本返回 up-to-date', async () => {
    const result = await checkForDesktopUpdate({
      ...base,
      currentVersion: '0.1.4',
      fetch: async () => response(releaseOf()),
    });
    expect(result.status).toBe('up-to-date');
  });

  it('只有源码包时返回 no-asset', async () => {
    const result = await checkForDesktopUpdate({
      ...base,
      fetch: async () =>
        response(
          releaseOf({
            assets: [
              {
                name: 'kiturone-kapibala-0.1.4.tgz',
                browser_download_url: 'https://example.test/corem.tgz',
                size: 10,
              },
            ],
          }),
        ),
    });
    expect(result.status).toBe('no-asset');
    expect(result.reason).toBe('NO_MATCHING_ASSET');
  });

  it('网络异常与 HTTP 失败都降级为 unknown，不抛出', async () => {
    const offline = await checkForDesktopUpdate({
      ...base,
      fetch: async () => {
        throw new Error('offline');
      },
    });
    expect(offline.status).toBe('unknown');
    expect(offline.reason).toBe('NETWORK');
    const failed = await checkForDesktopUpdate({
      ...base,
      fetch: async () => response({}, 500),
    });
    expect(failed.status).toBe('unknown');
    expect(failed.reason).toBe('HTTP_500');
  });

  it('tag 非法时返回 unknown，未支持平台不发起网络请求', async () => {
    const invalid = await checkForDesktopUpdate({
      ...base,
      fetch: async () => response(releaseOf({ tag_name: 'latest' })),
    });
    expect(invalid.status).toBe('unknown');
    expect(invalid.reason).toBe('INVALID_VERSION');
    const fetch = vi.fn();
    const unsupported = await checkForDesktopUpdate({
      currentVersion: '0.1.3',
      platform: 'linux',
      arch: 'arm64',
      fetch,
    });
    expect(unsupported.status).toBe('unknown');
    expect(unsupported.reason).toBe('UNSUPPORTED_PLATFORM');
    expect(fetch).not.toHaveBeenCalled();
  });
});
