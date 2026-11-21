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
});
