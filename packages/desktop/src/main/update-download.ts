import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { finished } from 'node:stream/promises';

/** 摘要清单大小上限：正常 SHA256SUMS 只有几 KB，超过即视为异常响应而不是慢慢读完。 */
const CHECKSUM_LIMIT = 1024 * 1024;

/**
 * 下载空闲超时：60 秒没有任何新进展（响应迟迟不来、字节迟迟不到）即判定连接挂起。
 * 判定的是「空闲」而不是总时长——只要字节持续到达，下载可以任意久。
 */
const IDLE_TIMEOUT_MS = 60_000;

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
  /** 跟随重定向后的最终 URL；真实 Response 恒有值，缺省仅出现在旧 mock，此时跳过复验。 */
  url?: string;
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

/**
 * 复验响应的最终 URL 是否仍是 https。
 *
 * 初始 URL 已由调用方限定 https + github.com，但 GitHub 资产会 302 到对象存储域名——
 * 域名允许变化，协议不允许降级；任何 http 落点或无法解析的最终 URL 都视为不可信。
 */
function isInsecureResponseUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    return new URL(url).protocol !== 'https:';
  } catch {
    return true;
  }
}

/** 合并流式读取的分块；只用于不超过 CHECKSUM_LIMIT 的小响应，不承担大缓冲。 */
function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** 摘要响应的有界读取结果；`tooLarge` 为真表示超出上限，此时不保留任何内容。 */
type BoundedChecksum = { tooLarge: false; text: string } | { tooLarge: true };

/**
 * 有界读取摘要响应。
 *
 * 先看 content-length，超限直接拒绝；声明缺失时流式累计字节，一旦超过上限立即取消读取。
 * 任何路径都不把超大响应整读进内存——「读完后比对长度」防不住 OOM。
 * 无 body 可读的调用面（仅旧 mock 会出现）退化为整读后校验长度，作为最后兜底。
 * 每次读取都经过空闲看门狗，连接中途挂起同样能被截停。
 */
async function readBoundedChecksum(
  response: DownloadResponse,
  withIdle: IdleGuard,
): Promise<BoundedChecksum> {
  const declared = Number(response.headers?.get('content-length') ?? 0);
  if (declared > CHECKSUM_LIMIT) return { tooLarge: true };
  if (!response.body) {
    const text = await withIdle(response.text());
    return text.length > CHECKSUM_LIMIT ? { tooLarge: true } : { tooLarge: false, text };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await withIdle(reader.read());
    if (done) return { tooLarge: false, text: new TextDecoder().decode(concatChunks(chunks)) };
    bytes += value.byteLength;
    if (bytes > CHECKSUM_LIMIT) {
      // 超限即中断：取消读取释放连接，不再消费后续块。
      void reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(value);
  }
}

/** 流式计算文件 SHA256，避免把安装包整读进内存。 */
async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * 生成不覆盖既有文件的目标路径：同名时按 `name (1).ext` 递增直到空闲。
 *
 * POSIX 的 rename 会静默替换同名文件，直接落名会把用户自己的同名文件覆盖掉；
 * 先探测再落名。探测与改名之间仍有极小竞态窗口（并发落名场景），可接受。
 * 尝试超过上限仍无空闲名时返回 undefined，调用方按失败处理而不是冒险覆盖。
 */
async function resolveUniqueTarget(directory: string, name: string): Promise<string | undefined> {
  const target = path.join(directory, name);
  if (!fs.existsSync(target)) return target;
  const extension = path.extname(name);
  const stem = extension ? name.slice(0, name.length - extension.length) : name;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(directory, `${stem} (${index})${extension}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** 记录下载进度；total 未知时为 0，调用方自行降级展示。 */
export interface DownloadUpdateOptions {
  installer: { name: string; url: string; size?: number };
  checksum: { url: string };
  /** 目标目录，通常是 `app.getPath('downloads')`。 */
  directory: string;
  fetch: DownloadFetch;
  signal?: AbortSignal;
  /** 空闲超时毫秒数；缺省 60 秒。测试注入小值模拟挂起连接，不必等待真实时长。 */
  idleTimeoutMs?: number;
  onProgress?(downloaded: number, total: number, final?: boolean): void;
}

/** 空闲看门狗的注入面：包装任意一次网络等待，超时即中止连接并拒绝。 */
type IdleGuard = <T>(task: Promise<T>) => Promise<T>;

/**
 * 下载安装包并按 `SHA256SUMS` 严格校验，成功后才改名落到目标目录。
 *
 * 顺序不可交换：先取摘要、确认清单里有该安装包条目，再下正文，最后比对哈希；
 * 任一步失败都删除临时文件并返回原因，不提供「跳过校验」。摘要只证明文件完整，
 * 不证明来源——本版未签名，调用方须如实表述。
 * 摘要与正文的所有网络等待都挂空闲看门狗：连接挂起 60 秒（或注入值）即中止并失败，
 * 不让界面永远停在「下载中」；用户取消仍按 cancelled 返回。
 */
export async function downloadUpdate(options: DownloadUpdateOptions): Promise<DownloadResult> {
  const name = safeInstallerName(options.installer.name);
  if (!name) return { status: 'failed', reason: 'INVALID_ASSET_NAME' };
  // 取消只看用户信号：空闲超时属于失败而不是用户动作，内部中止不能伪装成 cancelled。
  const cancelled = (): boolean => options.signal?.aborted ?? false;
  // 空闲看门狗需要能主动断开连接：内部信号与用户取消合并后传入 fetch；
  // 用户取消经合并信号照常生效，空闲超时中止内部信号，两者互不串扰。
  const internal = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, internal.signal])
    : internal.signal;
  const headers = { 'User-Agent': 'Kapibala-Desktop-Update', Accept: '*/*' };
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const clearIdle = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };
  /**
   * 给一次网络等待挂空闲看门狗。
   *
   * 进入前重新计时；超时内未完成就中止内部信号断开底层连接，并以稳定的 IDLE_TIMEOUT
   * 原因拒绝——不依赖各运行时把 abort 原因透传给读 promise 的行为差异。每个新字节到达
   * 都会重走一遍「撤表 → 计时 → 完成后撤表」，等价于「有 progress 就续期」。
   */
  const withIdle: IdleGuard = (task) => {
    clearIdle();
    return new Promise((resolve, reject) => {
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        internal.abort(new Error('IDLE_TIMEOUT'));
        reject(new Error('IDLE_TIMEOUT'));
      }, idleTimeoutMs);
      task.then(
        (value) => {
          clearIdle();
          resolve(value);
        },
        (error) => {
          clearIdle();
          reject(error);
        },
      );
    });
  };

  // 1. 摘要先行：拿不到清单或清单里没有目标条目就拒绝下载；超大响应在读取前/读取中就被截停。
  let checksumText: string;
  try {
    const response = await withIdle(options.fetch(options.checksum.url, { headers, signal }));
    if (!response.ok)
      return {
        status: 'failed',
        reason: 'CHECKSUM_FETCH_FAILED',
        detail: `HTTP_${response.status}`,
      };
    // 重定向后的最终落点必须仍是 https：协议降级说明链路被劫持或配置异常，拒绝消费。
    if (isInsecureResponseUrl(response.url))
      return {
        status: 'failed',
        reason: 'CHECKSUM_FETCH_FAILED',
        detail: 'INSECURE_REDIRECT',
      };
    const read = await readBoundedChecksum(response, withIdle);
    if (read.tooLarge)
      return { status: 'failed', reason: 'CHECKSUM_FETCH_FAILED', detail: 'CHECKSUM_TOO_LARGE' };
    checksumText = read.text;
  } catch (error) {
    return cancelled()
      ? { status: 'cancelled' }
      : { status: 'failed', reason: 'CHECKSUM_FETCH_FAILED', detail: (error as Error).message };
  }
  const expected = parseChecksumEntries(checksumText).get(name);
  if (!expected) return { status: 'failed', reason: 'CHECKSUM_MISSING', detail: name };

  // 2. 正文流式写入临时文件；临时名以点开头，失败时不会伪装成可用安装包。
  const temp = path.join(options.directory, `.${name}.part`);
  const removeTemp = () => fs.promises.rm(temp, { force: true }).catch(() => {});
  let written = 0;
  try {
    await fs.promises.mkdir(options.directory, { recursive: true });
    const response = await withIdle(options.fetch(options.installer.url, { headers, signal }));
    if (!response.ok) {
      await removeTemp();
      return {
        status: 'failed',
        reason: 'DOWNLOAD_FAILED',
        detail: `HTTP_${response.status}`,
      };
    }
    // 正文同摘要：最终落点协议降级即拒绝，安装包内容不接受任何明文链路。
    if (isInsecureResponseUrl(response.url)) {
      await removeTemp();
      return { status: 'failed', reason: 'DOWNLOAD_FAILED', detail: 'INSECURE_REDIRECT' };
    }
    if (!response.body) {
      await removeTemp();
      return { status: 'failed', reason: 'DOWNLOAD_FAILED', detail: 'NO_BODY' };
    }
    const total =
      Number(response.headers?.get('content-length') ?? 0) || (options.installer.size ?? 0);
    const out = fs.createWriteStream(temp);
    // 写流的 'error' 事件（磁盘满、目录权限被撤销等）若无人监听会以未捕获异常击穿主进程，
    // 且先于外层 catch：必须在创建后立即挂监听吞掉事件、保留错误对象，统一并入失败路径。
    let streamError: Error | undefined;
    out.on('error', (error) => {
      streamError ??= error;
    });
    // 'close' 无论成功收尾还是 open/写失败都恰好触发一次；创建后立刻挂上等待，
    // 失败路径先等它再清理临时文件——createWriteStream 的 open 是异步的，
    // 立即 rm 可能跑在 open 前面（ENOENT 被 force 吞掉），把刚创建的文件留在磁盘上。
    const closed = new Promise<void>((resolve) => out.once('close', resolve));
    try {
      const reader = response.body.getReader();
      for (;;) {
        // 读取经过空闲看门狗：字节持续到达就不断续期，挂起 60 秒即中止连接并失败。
        const { done, value } = await withIdle(reader.read());
        if (done) break;
        written += value.byteLength;
        // 声明大小是检查结果登记的可信上界：正文超过它说明响应与资产不符，
        // 立即中断并清理，不把失控响应继续写进磁盘。
        if (options.installer.size && written > options.installer.size) {
          void reader.cancel().catch(() => {});
          throw new Error('INSTALLER_TOO_LARGE');
        }
        await new Promise<void>((resolve, reject) => {
          out.write(value, (error) => (error ? reject(error) : resolve()));
        });
        options.onProgress?.(written, total);
      }
      out.end();
      await finished(out);
    } catch (error) {
      out.destroy();
      await closed;
      throw error;
    }
    if (streamError) throw streamError;
    options.onProgress?.(written, total || written, true);
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
  // 摘要比较用常量时间等价：先比长度（不等长直接不等），避免逐字节比较的时序侧信道。
  // 两边都是 64 位十六进制摘要，正常恒等长；长度守卫是 timingSafeEqual 的前置要求。
  const actualDigest = Buffer.from(actual, 'hex');
  const expectedDigest = Buffer.from(expected, 'hex');
  if (
    actualDigest.length !== expectedDigest.length ||
    !timingSafeEqual(actualDigest, expectedDigest)
  ) {
    await removeTemp();
    return { status: 'failed', reason: 'CHECKSUM_MISMATCH' };
  }
  if (cancelled()) {
    await removeTemp();
    return { status: 'cancelled' };
  }
  // 4. 落名：目标已存在时自动去重命名，绝不静默覆盖用户自己的同名文件；
  // Windows 上目标被占用导致的 rename 失败按原样透传为失败原因。
  const filePath = await resolveUniqueTarget(options.directory, name);
  if (!filePath) {
    await removeTemp();
    return { status: 'failed', reason: 'DOWNLOAD_FAILED', detail: 'TARGET_NAME_UNAVAILABLE' };
  }
  try {
    await fs.promises.rename(temp, filePath);
  } catch (error) {
    await removeTemp();
    return { status: 'failed', reason: 'DOWNLOAD_FAILED', detail: (error as Error).message };
  }
  return { status: 'downloaded', filePath };
}
