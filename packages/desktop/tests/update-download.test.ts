import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type DownloadFetch,
  type DownloadResponse,
  downloadUpdate,
  isTrustedReleaseUrl,
  parseChecksumEntries,
  safeInstallerName,
} from '../src/main/update-download.js';

const directories: string[] = [];

function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-update-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 构造最小响应；不需要完整 Response，只要 text / body / content-length 三项。 */
function response(
  body: Uint8Array | string,
  init: { status?: number; contentLength?: number } = {},
): DownloadResponse {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) =>
        name.toLowerCase() === 'content-length' && init.contentLength !== undefined
          ? String(init.contentLength)
          : null,
    },
    text: async () => new TextDecoder().decode(bytes),
    // Response 的 BodyInit 要求 ArrayBuffer 背书的视图，复制一份再交给构造器。
    body: new Response(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    ).body,
  };
}

const checksumUrl =
  'https://github.com/tedburner/kapibala/releases/download/v0.1.4/SHA256SUMS-mac-arm64.txt';
const installerUrl =
  'https://github.com/tedburner/kapibala/releases/download/v0.1.4/Kapibala-0.1.4-mac-arm64-test.dmg';

function serveFiles(files: Record<string, () => DownloadResponse>): DownloadFetch {
  return async (url) => {
    const handler = files[url];
    if (!handler) throw new Error(`unexpected url ${url}`);
    return handler();
  };
}

describe('摘要清单与文件名清洗', () => {
  it('解析 GNU 两种格式，跳过非法行并保留首条', () => {
    const digest = 'a'.repeat(64);
    const entries = parseChecksumEntries(
      [
        `${digest}  Kapibala.dmg`,
        `${'B'.repeat(64)} *Kapibala.exe`,
        '# 注释行',
        'not-a-digest  file',
        `${'c'.repeat(64)}  Kapibala.dmg`,
        '',
      ].join('\r\n'),
    );
    expect(entries.get('Kapibala.dmg')).toBe(digest);
    expect(entries.get('Kapibala.exe')).toBe('b'.repeat(64));
    expect(entries.size).toBe(2);
  });

  it('只接受纯文件名，拒绝路径与控制字符', () => {
    expect(safeInstallerName('Kapibala-0.1.4-mac-arm64-test.dmg')).toBe(
      'Kapibala-0.1.4-mac-arm64-test.dmg',
    );
    expect(safeInstallerName('../evil.exe')).toBeUndefined();
    expect(safeInstallerName('dir/evil.exe')).toBeUndefined();
    expect(safeInstallerName('dir\\evil.exe')).toBeUndefined();
    expect(safeInstallerName('..')).toBeUndefined();
    expect(safeInstallerName('')).toBeUndefined();
    expect(safeInstallerName('bad\u0000name.exe')).toBeUndefined();
  });

  it('只信任 GitHub 发布域名', () => {
    expect(isTrustedReleaseUrl(installerUrl)).toBe(true);
    expect(isTrustedReleaseUrl('http://github.com/x')).toBe(false);
    expect(isTrustedReleaseUrl('https://example.test/x')).toBe(false);
    expect(isTrustedReleaseUrl('not a url')).toBe(false);
  });
});

describe('downloadUpdate', () => {
  const content = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const name = 'Kapibala-0.1.4-mac-arm64-test.dmg';
  const checksumList = `${sha256(content)}  ${name}\n`;

  it('校验一致才落到下载目录，进度以总大小收尾', async () => {
    const directory = tempDirectory();
    const progress: Array<{ downloaded: number; total: number }> = [];
    const result = await downloadUpdate({
      installer: { name, url: installerUrl, size: content.byteLength },
      checksum: { url: checksumUrl },
      directory,
      fetch: serveFiles({
        [checksumUrl]: () => response(checksumList),
        [installerUrl]: () => response(content, { contentLength: content.byteLength }),
      }),
      onProgress: (downloaded, total) => progress.push({ downloaded, total }),
    });
    expect(result).toEqual({
      status: 'downloaded',
      filePath: path.join(directory, name),
    });
    expect(fs.readFileSync(path.join(directory, name))).toEqual(Buffer.from(content));
    expect(fs.readdirSync(directory)).toEqual([name]);
    expect(progress.at(-1)).toEqual({ downloaded: content.byteLength, total: content.byteLength });
  });

  it('摘要不一致时删除临时文件并拒绝打开', async () => {
    const directory = tempDirectory();
    const result = await downloadUpdate({
      installer: { name, url: installerUrl },
      checksum: { url: checksumUrl },
      directory,
      fetch: serveFiles({
        [checksumUrl]: () => response(`${'0'.repeat(64)}  ${name}\n`),
        [installerUrl]: () => response(content),
      }),
    });
    expect(result).toEqual({ status: 'failed', reason: 'CHECKSUM_MISMATCH' });
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('清单里没有目标条目时拒绝下载，不请求正文', async () => {
    const directory = tempDirectory();
    let installerFetched = false;
    const result = await downloadUpdate({
      installer: { name, url: installerUrl },
      checksum: { url: checksumUrl },
      directory,
      fetch: async (url) => {
        if (url === checksumUrl) return response(`${sha256(content)}  other.dmg\n`);
        installerFetched = true;
        return response(content);
      },
    });
    expect(result).toEqual({ status: 'failed', reason: 'CHECKSUM_MISSING', detail: name });
    expect(installerFetched).toBe(false);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('摘要清单请求失败与正文 HTTP 错误都给出稳定原因', async () => {
    const directory = tempDirectory();
    const checksumFailed = await downloadUpdate({
      installer: { name, url: installerUrl },
      checksum: { url: checksumUrl },
      directory,
      fetch: serveFiles({ [checksumUrl]: () => response('', { status: 404 }) }),
    });
    expect(checksumFailed).toEqual({
      status: 'failed',
      reason: 'CHECKSUM_FETCH_FAILED',
      detail: 'HTTP_404',
    });
    const downloadFailed = await downloadUpdate({
      installer: { name, url: installerUrl },
      checksum: { url: checksumUrl },
      directory,
      fetch: serveFiles({
        [checksumUrl]: () => response(checksumList),
        [installerUrl]: () => response('', { status: 500 }),
      }),
    });
    expect(downloadFailed).toEqual({
      status: 'failed',
      reason: 'DOWNLOAD_FAILED',
      detail: 'HTTP_500',
    });
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('摘要声明超过上限时读取前就拒绝，不消费正文', async () => {
    const directory = tempDirectory();
    const result = await downloadUpdate({
      installer: { name, url: installerUrl },
      checksum: { url: checksumUrl },
      directory,
      fetch: serveFiles({
        [checksumUrl]: () => ({
          ok: true,
          status: 200,
          headers: {
            get: (header) =>
              header.toLowerCase() === 'content-length' ? String(1024 * 1024 + 1) : null,
          },
          // 实现若退化成先整读，text()/read() 会带着标记错误失败，断言能立即识破。
          text: async () => {
            throw new Error('should-not-text');
          },
          body: new ReadableStream<Uint8Array>({
            pull(stream) {
              stream.error(new Error('should-not-read'));
            },
          }),
        }),
      }),
    });
    expect(result).toEqual({
      status: 'failed',
      reason: 'CHECKSUM_FETCH_FAILED',
      detail: 'CHECKSUM_TOO_LARGE',
    });
  });

  it('摘要无 content-length 时流式累计，超过上限即中断', async () => {
    const directory = tempDirectory();
    const oversized = new Uint8Array(1024 * 1024 + 1);
    const result = await downloadUpdate({
      installer: { name, url: installerUrl },
      checksum: { url: checksumUrl },
      directory,
      fetch: serveFiles({
        // 不声明 content-length，逼迫实现走流式读取分支。
        [checksumUrl]: () => response(oversized),
      }),
    });
    expect(result).toEqual({
      status: 'failed',
      reason: 'CHECKSUM_FETCH_FAILED',
      detail: 'CHECKSUM_TOO_LARGE',
    });
  });

  it('正文超过登记的声明大小时中断下载并清理临时文件', async () => {
    const directory = tempDirectory();
    const doubled = new Uint8Array(content.byteLength * 2);
    doubled.set(content);
    doubled.set(content, content.byteLength);
    const result = await downloadUpdate({
      installer: { name, url: installerUrl, size: content.byteLength },
      checksum: { url: checksumUrl },
      directory,
      fetch: serveFiles({
        [checksumUrl]: () => response(checksumList),
        // 响应体是声明大小的两倍：哈希即便一致也不允许，超限必须在写入途中被截停。
        [installerUrl]: () => response(doubled),
      }),
    });
    expect(result).toEqual({
      status: 'failed',
      reason: 'DOWNLOAD_FAILED',
      detail: 'INSTALLER_TOO_LARGE',
    });
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('正文长时间无新字节时按空闲超时中断并清理临时文件', async () => {
    const directory = tempDirectory();
    const result = await downloadUpdate({
      installer: { name, url: installerUrl },
      checksum: { url: checksumUrl },
      directory,
      // 注入极短空闲超时：不必等待真实 60 秒即可验证挂起判定。
      idleTimeoutMs: 30,
      fetch: async (url, init) => {
        if (url === checksumUrl) return response(checksumList);
        // 受控正文流：永不产出数据，模拟连接挂起；abort 时以信号原因失败（对齐真实 fetch）。
        const body = new ReadableStream<Uint8Array>({
          start(stream) {
            init.signal.addEventListener('abort', () => stream.error(init.signal.reason));
          },
          pull: () => new Promise<void>(() => {}),
        });
        return { ok: true, status: 200, text: async () => '', body };
      },
    });
    expect(result).toEqual({
      status: 'failed',
      reason: 'DOWNLOAD_FAILED',
      detail: 'IDLE_TIMEOUT',
    });
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('目标同名文件已存在时自动去重命名，绝不覆盖用户文件', async () => {
    const directory = tempDirectory();
    const userFile = path.join(directory, name);
    fs.writeFileSync(userFile, 'user-file');
    const first = await downloadUpdate({
      installer: { name, url: installerUrl, size: content.byteLength },
      checksum: { url: checksumUrl },
      directory,
      fetch: serveFiles({
        [checksumUrl]: () => response(checksumList),
        [installerUrl]: () => response(content, { contentLength: content.byteLength }),
      }),
    });
    expect(first).toEqual({
      status: 'downloaded',
      filePath: path.join(directory, `${name.slice(0, -'.dmg'.length)} (1).dmg`),
    });
    expect(fs.readFileSync(userFile)).toEqual(Buffer.from('user-file'));
    // 再次下载继续递增，已占用的去重名不会被复用或覆盖。
    const second = await downloadUpdate({
      installer: { name, url: installerUrl, size: content.byteLength },
      checksum: { url: checksumUrl },
      directory,
      fetch: serveFiles({
        [checksumUrl]: () => response(checksumList),
        [installerUrl]: () => response(content, { contentLength: content.byteLength }),
      }),
    });
    expect(second).toEqual({
      status: 'downloaded',
      filePath: path.join(directory, `${name.slice(0, -'.dmg'.length)} (2).dmg`),
    });
    expect(fs.readFileSync(userFile)).toEqual(Buffer.from('user-file'));
  });

  it('摘要与正文的最终响应 URL 降级为 http 时拒绝下载', async () => {
    const directory = tempDirectory();
    // 302 到对象存储是功能前提，但协议不允许降级：最终 URL 必须复验仍是 https。
    const checksumRejected = await downloadUpdate({
      installer: { name, url: installerUrl },
      checksum: { url: checksumUrl },
      directory,
      fetch: serveFiles({
        [checksumUrl]: () => ({
          ...response(checksumList),
          url: 'http://objects.github.test/sums',
        }),
      }),
    });
    expect(checksumRejected).toEqual({
      status: 'failed',
      reason: 'CHECKSUM_FETCH_FAILED',
      detail: 'INSECURE_REDIRECT',
    });
    const installerRejected = await downloadUpdate({
      installer: { name, url: installerUrl },
      checksum: { url: checksumUrl },
      directory,
      fetch: serveFiles({
        [checksumUrl]: () => response(checksumList),
        [installerUrl]: () => ({
          ...response(content),
          url: 'http://objects.github.test/installer',
        }),
      }),
    });
    expect(installerRejected).toEqual({
      status: 'failed',
      reason: 'DOWNLOAD_FAILED',
      detail: 'INSECURE_REDIRECT',
    });
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('非法文件名在联网前就被拒绝', async () => {
    const directory = tempDirectory();
    let fetched = false;
    const result = await downloadUpdate({
      installer: { name: '../escape.dmg', url: installerUrl },
      checksum: { url: checksumUrl },
      directory,
      fetch: async () => {
        fetched = true;
        return response('');
      },
    });
    expect(result).toEqual({ status: 'failed', reason: 'INVALID_ASSET_NAME' });
    expect(fetched).toBe(false);
  });

  it('取消会中断正文流并删除临时文件', async () => {
    const directory = tempDirectory();
    const controller = new AbortController();
    const result = await downloadUpdate({
      installer: { name, url: installerUrl },
      checksum: { url: checksumUrl },
      directory,
      signal: controller.signal,
      // 首块写入后立即取消：正文流此后不再产数据，只有取消能让读取结束。
      onProgress: () => controller.abort(),
      fetch: async (url, init) => {
        if (url === checksumUrl) return response(checksumList);
        const body = new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(content);
            init.signal.addEventListener('abort', () => stream.error(new Error('aborted')));
          },
          pull: () => new Promise<void>(() => {}),
        });
        return { ok: true, status: 200, text: async () => '', body };
      },
    });
    expect(result).toEqual({ status: 'cancelled' });
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('写流打开失败时返回失败并清理，不抛未捕获异常击穿进程', async () => {
    // Windows 的目录写权限走 ACL，chmod 拦不住；root 不受 chmod 限制，两种环境都无法注入失败。
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const directory = tempDirectory();
    fs.chmodSync(directory, 0o500);
    let result: Awaited<ReturnType<typeof downloadUpdate>>;
    try {
      result = await downloadUpdate({
        installer: { name, url: installerUrl },
        checksum: { url: checksumUrl },
        directory,
        fetch: serveFiles({
          [checksumUrl]: () => response(checksumList),
          [installerUrl]: () => response(content),
        }),
      });
    } finally {
      // 恢复权限让 afterEach 能清掉整个临时目录。
      fs.chmodSync(directory, 0o700);
    }
    // detail 是操作系统错误文本，按存在性断言；status 与 reason 必须稳定。
    expect(result).toEqual({
      status: 'failed',
      reason: 'DOWNLOAD_FAILED',
      detail: expect.any(String),
    });
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});
