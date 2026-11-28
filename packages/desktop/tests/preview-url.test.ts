import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Preferences } from '../src/main/preferences.js';
import {
  isAllowedLocalPreviewPath,
  isVerifiedManagedWorktreeOfAllowedWorkspace,
  readImageDataUrl,
  resolveLocalImagePath,
} from '../src/main/preview-file.js';
import { DARK_WINDOW_BACKGROUND, titleBarOverlayOptions } from '../src/main/window-chrome.js';
import { NotificationSchema } from '../src/shared/contracts.js';
import { classifyPreviewUrl, isAllowedLoopbackSubframeUrl } from '../src/shared/preview-url.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync.native(dir);
}

function gitCleanTestEnv(): NodeJS.ProcessEnv {
  const allowedKeys = [
    'PATH',
    'Path',
    'SYSTEMROOT',
    'SystemRoot',
    'COMSPEC',
    'ComSpec',
    'PATHEXT',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
  ];
  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const key of allowedKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

describe('classifyPreviewUrl & isAllowedLoopbackSubframeUrl security policy', () => {
  it('allows explicit loopback HTTP development server ports and shorthand inputs', () => {
    expect(classifyPreviewUrl('http://localhost:5173/app?tab=1')).toEqual({
      kind: 'embed_loopback',
      normalizedUrl: 'http://localhost:5173/app?tab=1',
      port: 5173,
    });
    expect(classifyPreviewUrl('localhost:3000')).toEqual({
      kind: 'embed_loopback',
      normalizedUrl: 'http://localhost:3000/',
      port: 3000,
    });
    expect(classifyPreviewUrl(':8080/health')).toEqual({
      kind: 'embed_loopback',
      normalizedUrl: 'http://localhost:8080/health',
      port: 8080,
    });
    expect(classifyPreviewUrl('http://127.0.0.1:4173/')).toEqual({
      kind: 'embed_loopback',
      normalizedUrl: 'http://127.0.0.1:4173/',
      port: 4173,
    });
    expect(classifyPreviewUrl('http://[::1]:5173/')).toEqual({
      kind: 'embed_loopback',
      normalizedUrl: 'http://[::1]:5173/',
      port: 5173,
    });
  });

  it('routes public HTTPS URLs (including global unicast IPv6) to external browser instead of embedding', () => {
    const res = classifyPreviewUrl('https://github.com/tedburner/kapibala');
    expect(res.kind).toBe('open_external');
    if (res.kind === 'open_external') {
      expect(res.normalizedUrl).toBe('https://github.com/tedburner/kapibala');
    }
    expect(classifyPreviewUrl('https://[2606:4700:4700::1111]/dns-query').kind).toBe(
      'open_external',
    );
  });

  it('blocks HTTPS on loopback with explicit HTTP guidance instead of embedding or misclassifying', () => {
    for (const httpsLoopback of [
      'https://localhost:5174',
      'https://127.0.0.1:8443',
      'https://[::1]:5174',
      'https://localhost.:8443',
    ]) {
      expect(classifyPreviewUrl(httpsLoopback)).toEqual({
        kind: 'blocked',
        reason:
          '本地内嵌预览仅支持 HTTP 开发服务（如 http://localhost:5173），HTTPS 本地端口请在系统浏览器中打开',
      });
    }
  });

  it('blocks adversarial URL obfuscations: trailing dots, shorthand IPv4, octal/hex octets, and reserved IPv6', () => {
    const adversarialUrls = [
      'file:///C:/Windows/System32/drivers/etc/hosts',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'kpbl-preview://preview/123',
      'http://localhost', // 缺显式端口
      'http://localhost:22', // SSH 高危端口
      'http://user:pass@localhost:5173', // 内嵌凭据
      'http://192.168.1.10:3000', // RFC1918
      'https://10.0.0.5:8443', // RFC1918
      'http://172.16.0.1:8080', // RFC1918
      'http://169.254.169.254/latest/meta-data/', // 云元数据
      'http://0.0.0.0:5173', // 未指定通配地址
      'http://127.0.0.2:5173', // 非标准 127 段变体
      'http://2130706433:5173', // 十进制单整数 IP 混淆
      'http://0x7f000001:5173', // 十六进制单整数 IP 混淆
      'http://127.1:3000', // 缩写两段 IPv4
      'http://127.0.1:3000', // 缩写三段 IPv4
      'https://10.1:8443', // 缩写私网 IPv4
      'http://127.0.0.01:3000', // 末段八进制前导零
      'http://0177.0.0.1:3000', // 首段八进制前导零
      'http://127.0.0.0x1:3000', // 末段十六进制
      'http://0x7f.0.0.1:3000', // 首段十六进制
      'http://localhost.:3000', // 尾随点号回环
      'https://metadata.google.internal.', // 尾随点号云元数据域名
      'https://api.localhost.', // 尾随点号 .localhost
      'https://printer.local.', // 尾随点号 mDNS
      'https://[fe80::1]:8443/', // 链路本地 IPv6
      'https://[fe9a::1234]:8443/', // fe80::/10 非 fe80 起始子网
      'https://[febf:ffff::1]:8443/', // fe80::/10 上界
      'https://[fc00::1]/', // ULA
      'https://[fd12:3456:789a::1]/', // ULA
      'https://[::ffff:127.0.0.1]/', // IPv4-mapped 回环
      'https://[::ffff:169.254.169.254]/', // IPv4-mapped 元数据
      'https://[::127.0.0.1]/', // IPv4-compatible 回环
      'https://[::169.254.169.254]/', // IPv4-compatible 元数据
      'https://[::7f00:1]/', // IPv4-compatible 十六进制
      'https://[64:ff9b::169.254.169.254]/', // NAT64 元数据映射
      'https://[64:ff9b:1::10.0.0.1]/', // NAT64 本地转换前缀
      'http://example.com', // 公网明文 HTTP
    ];

    for (const unsafe of adversarialUrls) {
      expect(classifyPreviewUrl(unsafe).kind, `expected blocked for ${unsafe}`).toBe('blocked');
    }

    // 阻止内嵌当前桌面渲染进程自身的开发端口（无论写法为 localhost / 127.0.0.1 / [::1]）
    expect(
      classifyPreviewUrl('http://localhost:5173', { hostOrigin: 'http://127.0.0.1:5173' }).kind,
    ).toBe('blocked');
    expect(classifyPreviewUrl(':5173', { hostOrigin: 'http://localhost:5173' }).kind).toBe(
      'blocked',
    );
    expect(
      classifyPreviewUrl('http://[::1]:5173', { hostOrigin: 'http://127.0.0.1:5173' }).kind,
    ).toBe('blocked');
    expect(
      classifyPreviewUrl('http://localhost:3000', { hostOrigin: 'http://127.0.0.1:5173' }).kind,
    ).toBe('embed_loopback');
    expect(classifyPreviewUrl('http://localhost:5173', { hostOrigin: 'file://' }).kind).toBe(
      'embed_loopback',
    );
  });

  it('enforces hostOrigin port exclusion and obfuscation checks in isAllowedLoopbackSubframeUrl', () => {
    const devHost = { hostOrigin: 'http://127.0.0.1:5173/' };
    expect(isAllowedLoopbackSubframeUrl('http://localhost:3000/app', devHost)).toBe(true);
    expect(isAllowedLoopbackSubframeUrl('ws://127.0.0.1:3000/@vite/hmr', devHost)).toBe(true);
    expect(isAllowedLoopbackSubframeUrl('http://[::1]:4173/', devHost)).toBe(true);

    // 严禁子帧加载或 302 重定向至主渲染开发端口（阻断同源继承 window.kapibala 特权桥）
    expect(isAllowedLoopbackSubframeUrl('http://127.0.0.1:5173/', devHost)).toBe(false);
    expect(isAllowedLoopbackSubframeUrl('http://localhost:5173/index.html', devHost)).toBe(false);
    expect(isAllowedLoopbackSubframeUrl('http://[::1]:5173/', devHost)).toBe(false);
    expect(isAllowedLoopbackSubframeUrl('ws://localhost:5173/', devHost)).toBe(false);

    // 严禁混淆 IP、HTTPS 回环、尾随点号与高危端口
    expect(isAllowedLoopbackSubframeUrl('http://127.1:3000/', devHost)).toBe(false);
    expect(isAllowedLoopbackSubframeUrl('http://127.0.0.01:3000/', devHost)).toBe(false);
    expect(isAllowedLoopbackSubframeUrl('http://127.0.0.0x1:3000/', devHost)).toBe(false);
    expect(isAllowedLoopbackSubframeUrl('http://localhost.:3000/', devHost)).toBe(false);
    expect(isAllowedLoopbackSubframeUrl('https://localhost:3000/', devHost)).toBe(false);
    expect(isAllowedLoopbackSubframeUrl('http://localhost:22/', devHost)).toBe(false);
  });
});

describe('Managed Git Worktree local image preview boundary (H-1)', () => {
  it('allows PNG/SVG inside verified managed worktree of registered workspace and rejects spoofed .git or nested .kapibala', async () => {
    const base = makeTempDir('kpbl-wt-preview-');
    const home = path.join(base, 'home');
    const repo = path.join(base, 'repo');
    const unregisteredRepo = path.join(base, 'unregistered-repo');
    const temp = path.join(base, 'tmp');
    for (const d of [home, repo, unregisteredRepo, temp]) fs.mkdirSync(d, { recursive: true });

    const env = gitCleanTestEnv();
    for (const r of [repo, unregisteredRepo]) {
      execFileSync('git', ['init', '-b', 'main'], { cwd: r, env, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: r, env, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.email', 'test@kapibala.local'], {
        cwd: r,
        env,
        stdio: 'pipe',
      });
      fs.writeFileSync(path.join(r, 'README.md'), '# demo\n', 'utf8');
      execFileSync('git', ['add', '.'], { cwd: r, env, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: r, env, stdio: 'pipe' });
    }

    const wtRoot = path.join(home, '.kapibala', 'worktrees', 'a1b2', 'repo');
    fs.mkdirSync(path.dirname(wtRoot), { recursive: true });
    execFileSync('git', ['worktree', 'add', '-b', 'kpbl/wt-img', wtRoot, 'HEAD'], {
      cwd: repo,
      env,
      stdio: 'pipe',
    });

    const unregWtRoot = path.join(home, '.kapibala', 'worktrees', 'c3d4', 'unregistered-repo');
    fs.mkdirSync(path.dirname(unregWtRoot), { recursive: true });
    execFileSync('git', ['worktree', 'add', '-b', 'kpbl/unreg', unregWtRoot, 'HEAD'], {
      cwd: unregisteredRepo,
      env,
      stdio: 'pipe',
    });

    // 真实写入 PNG 与 SVG 产物到已验真受管工作树
    const outDir = path.join(wtRoot, 'artifacts');
    fs.mkdirSync(outDir, { recursive: true });
    const pngPath = path.join(outDir, 'chart.png');
    const svgPath = path.join(outDir, 'diagram.svg');
    fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');

    const boundary = { workspaceRoots: [repo], homeDirectory: home, tempRoot: temp };

    // 1. 允许受管工作树根、子目录与相对/绝对 PNG & SVG 读取
    expect(isAllowedLocalPreviewPath(wtRoot, boundary)).toBe(true);
    expect(isAllowedLocalPreviewPath(outDir, boundary)).toBe(true);
    const resolvedPng = resolveLocalImagePath('artifacts/chart.png', wtRoot)!;
    const resolvedSvg = resolveLocalImagePath(svgPath, wtRoot)!;
    expect(isAllowedLocalPreviewPath(resolvedPng, boundary)).toBe(true);
    expect(isAllowedLocalPreviewPath(resolvedSvg, boundary)).toBe(true);
    expect(await readImageDataUrl(resolvedPng)).toMatch(/^data:image\/png;base64,/);
    expect(await readImageDataUrl(resolvedSvg)).toMatch(/^data:image\/svg\+xml;base64,/);

    // 2. 拒绝工作树内嵌套的 .kapibala 与 .git 子路径，以及 ~/.kapibala 其他区域
    fs.mkdirSync(path.join(wtRoot, '.kapibala'), { recursive: true });
    fs.writeFileSync(path.join(wtRoot, '.kapibala', 'secret.svg'), '<svg/>', 'utf8');
    expect(isAllowedLocalPreviewPath(path.join(wtRoot, '.kapibala', 'secret.svg'), boundary)).toBe(
      false,
    );
    expect(isAllowedLocalPreviewPath(path.join(wtRoot, '.git', 'fake.png'), boundary)).toBe(false);
    expect(
      isAllowedLocalPreviewPath(
        path.join(home, '.kapibala', 'worktrees', 'registry.png'),
        boundary,
      ),
    ).toBe(false);
    expect(isAllowedLocalPreviewPath(path.join(home, '.kapibala', 'settings.svg'), boundary)).toBe(
      false,
    );

    // 3. 拒绝主仓库未登记在 workspaceRoots 中的工作树
    expect(isAllowedLocalPreviewPath(path.join(unregWtRoot, 'a.png'), boundary)).toBe(false);

    // 4. 拒绝单向伪造 .git 指针（指向已登记主仓 .git/worktrees/<entry>，但主仓反向 gitdir 不指向伪造目录）
    const realDotGitContent = fs.readFileSync(path.join(wtRoot, '.git'), 'utf8');
    const spoofRoot = path.join(home, '.kapibala', 'worktrees', 'ffff', 'spoof-repo');
    fs.mkdirSync(spoofRoot, { recursive: true });
    fs.writeFileSync(path.join(spoofRoot, '.git'), realDotGitContent, 'utf8');
    fs.writeFileSync(path.join(spoofRoot, 'spoof.png'), Buffer.from('fake'));
    expect(
      isVerifiedManagedWorktreeOfAllowedWorkspace(path.join(spoofRoot, 'spoof.png'), [repo], home),
    ).toBe(false);
    expect(isAllowedLocalPreviewPath(path.join(spoofRoot, 'spoof.png'), boundary)).toBe(false);
  });
});

describe('Preferences locale default, preferences.changed schema, and dark window chrome', () => {
  it('defaults locale to system, validates preferences.changed notification, and aligns dark canvas to #15171a', () => {
    const userData = makeTempDir('kpbl-prefs-sys-');
    const prefs = new Preferences(userData);
    expect(prefs.read().locale).toBe('system');
    prefs.patch({ locale: 'en' });
    expect(prefs.read().locale).toBe('en');
    prefs.resetGeneral();
    expect(prefs.read().locale).toBe('system');

    expect(DARK_WINDOW_BACKGROUND).toBe('#15171a');
    expect(titleBarOverlayOptions('dark').color).toBe('#15171a');

    const parsed = NotificationSchema.parse({
      type: 'preferences.changed',
      preferences: {
        theme: 'dark',
        mode: 'dark',
        locale: 'system',
        resolvedLocale: 'zh-CN',
        typography: prefs.read().typography,
        general: prefs.read().general,
        confirmations: prefs.read().confirmations,
        recent: [],
      },
    });
    expect(parsed.type).toBe('preferences.changed');
  });
});
