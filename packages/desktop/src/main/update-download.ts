import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { finished } from 'node:stream/promises';

/** 摘要清单大小上限：正常 SHA256SUMS 只有几 KB，超过即视为异常响应而不是慢慢读完。 */
const CHECKSUM_LIMIT = 1024 * 1024;

/** 下载失败原因；渲染层按稳定原因码给用户可执行提示，不透传底层异常文本为唯一信息。 */
export type DownloadFailureReason =
  | 'INVALID_ASSET_NAME'
  | 'CHECKSUM_FETCH_FAILED'
  | 'CHECKSUM_MISSING'
  | 'DOWNLOAD_FAILED'
  | 'CHECKSUM_MISMATCH';

/** 一次下载的最终结果；`cancelled` 与失败分开，取消是用户动作而不是错误。 */
export type DownloadResult =
  | { status: 'downloaded'; filePath: string }
  | { status: 'cancelled' }
  | { status: 'failed'; reason: DownloadFailureReason; detail?: string };

/** 下载只需响应结构的最小面；单测用普通对象即可，不构造完整 Response。 */
export interface DownloadResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
}

/** 只注入实际用到的 fetch 能力；主进程传入 Electron 的 net.fetch。 */
export type DownloadFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<DownloadResponse>;

/**
 * 解析 `SHA256SUMS` 文本为「文件名 → 小写十六进制摘要」。
 *
 * 兼容 GNU coreutils 的两种行格式（`hash  name` 与 `hash *name`）；空行、注释和
 * 非法行直接跳过而不是抛错——清单里混入无关行不应阻断下载。同一文件名重复出现时
 * 保留首条，避免后面的行覆盖可信条目。
 */
export function parseChecksumEntries(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (!match) continue;
    const name = match[2];
    if (!name || entries.has(name)) continue;
    entries.set(name, match[1].toLowerCase());
  }
  return entries;
}

/**
 * 清洗安装包文件名：只接受纯文件名。
 *
 * 拒绝路径分隔符、控制字符与 `.`/`..`，确保落盘只发生在系统下载目录内；
 * 名称来自 Release 元数据，但校验之前不信任任何一段输入。
 */
export function safeInstallerName(name: string): string | undefined {
  if (!name || name.length > 200) return undefined;
  if (name === '.' || name === '..') return undefined;
  if (name !== path.basename(name)) return undefined;
  // 显式检查分隔符与控制字符：不依赖平台 basename 语义（POSIX 上反斜杠不是分隔符）。
  if (/[\\/]/.test(name) || Array.from(name).some((character) => character.charCodeAt(0) < 32))
    return undefined;
  return name;
}

/** 只允许从 GitHub 发布域名下载；渲染层无法传 URL，这里再兜一次协议与主机。 */
export function isTrustedReleaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com';
  } catch {
    return false;
  }
}

/** 流式计算文件 SHA256，避免把安装包整读进内存。 */
async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** 记录下载进度；total 未知时为 0，调用方自行降级展示。 */
export interface DownloadUpdateOptions {
  installer: { name: string; url: string; size?: number };
  checksum: { url: string };
  /** 目标目录，通常是 `app.getPath('downloads')`。 */
  directory: string;
  fetch: DownloadFetch;
  signal?: AbortSignal;
  onProgress?(downloaded: number, total: number): void;
}

/**
 * 下载安装包并按 `SHA256SUMS` 严格校验，成功后才改名落到目标目录。
 *
 * 顺序不可交换：先取摘要、确认清单里有该安装包条目，再下正文，最后比对哈希；
 * 任一步失败都删除临时文件并返回原因，不提供「跳过校验」。摘要只证明文件完整，
 * 不证明来源——本版未签名，调用方须如实表述。
 */
export async function downloadUpdate(options: DownloadUpdateOptions): Promise<DownloadResult> {
  const name = safeInstallerName(options.installer.name);
  if (!name) return { status: 'failed', reason: 'INVALID_ASSET_NAME' };
  const signal = options.signal ?? new AbortController().signal;
  const cancelled = (): boolean => signal.aborted;
  const headers = { 'User-Agent': 'Kapibala-Desktop-Update', Accept: '*/*' };

  // 1. 摘要先行：拿不到清单或清单里没有目标条目就拒绝下载。
  let checksumText: string;
  try {
    const response = await options.fetch(options.checksum.url, { headers, signal });
    if (!response.ok)
      return {
        status: 'failed',
        reason: 'CHECKSUM_FETCH_FAILED',
        detail: `HTTP_${response.status}`,
      };
    checksumText = await response.text();
  } catch (error) {
    return cancelled()
      ? { status: 'cancelled' }
      : { status: 'failed', reason: 'CHECKSUM_FETCH_FAILED', detail: (error as Error).message };
  }
  if (checksumText.length > CHECKSUM_LIMIT)
    return { status: 'failed', reason: 'CHECKSUM_FETCH_FAILED', detail: 'CHECKSUM_TOO_LARGE' };
  const expected = parseChecksumEntries(checksumText).get(name);
  if (!expected) return { status: 'failed', reason: 'CHECKSUM_MISSING', detail: name };

  // 2. 正文流式写入临时文件；临时名以点开头，失败时不会伪装成可用安装包。
  const temp = path.join(options.directory, `.${name}.part`);
  const removeTemp = () => fs.promises.rm(temp, { force: true }).catch(() => {});
  let written = 0;
  try {
    await fs.promises.mkdir(options.directory, { recursive: true });
    const response = await options.fetch(options.installer.url, { headers, signal });
    if (!response.ok) {
      await removeTemp();
      return {
        status: 'failed',
        reason: 'DOWNLOAD_FAILED',
        detail: `HTTP_${response.status}`,
      };
    }
    if (!response.body) {
      await removeTemp();
      return { status: 'failed', reason: 'DOWNLOAD_FAILED', detail: 'NO_BODY' };
    }
    const total =
      Number(response.headers?.get('content-length') ?? 0) || (options.installer.size ?? 0);
    const out = fs.createWriteStream(temp);
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        written += value.byteLength;
        await new Promise<void>((resolve, reject) => {
          out.write(value, (error) => (error ? reject(error) : resolve()));
        });
        options.onProgress?.(written, total);
      }
      out.end();
      await finished(out);
    } catch (error) {
      out.destroy();
      throw error;
    }
    options.onProgress?.(written, total || written);
  } catch (error) {
    await removeTemp();
    return cancelled()
      ? { status: 'cancelled' }
      : { status: 'failed', reason: 'DOWNLOAD_FAILED', detail: (error as Error).message };
  }
  if (cancelled()) {
    await removeTemp();
    return { status: 'cancelled' };
  }

  // 3. 摘要严格一致才允许改名；不一致一律删除，不留下「已下载」的假象。
  let actual: string;
  try {
    actual = await hashFile(temp);
  } catch (error) {
    await removeTemp();
    return { status: 'failed', reason: 'DOWNLOAD_FAILED', detail: (error as Error).message };
  }
  if (actual !== expected) {
    await removeTemp();
    return { status: 'failed', reason: 'CHECKSUM_MISMATCH' };
  }
  if (cancelled()) {
    await removeTemp();
    return { status: 'cancelled' };
  }
  const filePath = path.join(options.directory, name);
  try {
    await fs.promises.rename(temp, filePath);
  } catch (error) {
    await removeTemp();
    return { status: 'failed', reason: 'DOWNLOAD_FAILED', detail: (error as Error).message };
  }
  return { status: 'downloaded', filePath };
}
