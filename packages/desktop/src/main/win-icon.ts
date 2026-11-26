import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Windows 标准多分辨率 ICO 尺寸序列（覆盖标题栏 16/20/24、任务栏 32/48 与高分屏 64/128/256）。 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;

/** 最小化的图像缩放接口（对齐 Electron `NativeImage` 子集），便于脱离 Electron 主进程做纯单测。 */
export interface ResizableImage {
  isEmpty(): boolean;
  resize(options: { width: number; height: number; quality?: 'good' | 'better' | 'best' }): {
    toPNG(): Buffer;
  };
}

/**
 * 解析 Windows 应用用户模型标识（AppUserModelID）。
 *
 * 设计约束：
 * - Windows 10/11 任务栏按 AUMID 归组并缓存图标；未显式设置时会落回 `electron.exe` 默认身份，
 *   导致任务栏始终显示原生 Electron 黑色原子图标而非窗口图标；
 * - 正式包、E2E 隔离与本地 `dev:desktop` 使用各自独立后缀，防止任务栏图标缓存互相污染。
 */
export function resolveWindowsAppId(options: {
  isPackaged: boolean;
  isTestIsolation: boolean;
}): string {
  if (options.isPackaged) return 'dev.kapibala.desktop';
  if (options.isTestIsolation) return 'dev.kapibala.desktop.test';
  return 'dev.kapibala.desktop.dev';
}

/**
 * 将多尺寸 PNG 帧封装为符合 Windows Vista+ 规范的 `.ico` 二进制容器。
 *
 * 前置约束与边界：
 * - 单帧尺寸必须在 `1..256` 像素之间（ICO 目录项以 1 字节编码宽高，`256` 按规范写 `0`）；
 * - 帧列表为空或超出范围时抛出错误，避免写出损坏的图标头。
 */
export function encodePngFramesToIco(
  frames: readonly { readonly size: number; readonly png: Buffer }[],
): Buffer {
  if (frames.length === 0) throw new Error('ICO_FRAMES_EMPTY');
  const headerSize = 6;
  const dirEntrySize = 16;
  let dataOffset = headerSize + frames.length * dirEntrySize;
  const header = Buffer.alloc(dataOffset);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);

  const payloads: Buffer[] = [header];
  frames.forEach((frame, index) => {
    if (!Number.isInteger(frame.size) || frame.size < 1 || frame.size > 256) {
      throw new Error(`ICO_FRAME_SIZE_INVALID:${frame.size}`);
    }
    const entryOffset = headerSize + index * dirEntrySize;
    header.writeUInt8(frame.size === 256 ? 0 : frame.size, entryOffset);
    header.writeUInt8(frame.size === 256 ? 0 : frame.size, entryOffset + 1);
    header.writeUInt8(0, entryOffset + 2);
    header.writeUInt8(0, entryOffset + 3);
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(frame.png.byteLength, entryOffset + 8);
    header.writeUInt32LE(dataOffset, entryOffset + 12);
    dataOffset += frame.png.byteLength;
    payloads.push(frame.png);
  });

  return Buffer.concat(payloads);
}

/**
 * 在 `cacheDir` 下按源 `icon.png` 内容摘要生成并缓存多尺寸 `.ico` 文件，供 Windows `BrowserWindow` 与任务栏 `setAppDetails` 使用。
 *
 * 失败边界：源 PNG 不存在、解码为空或磁盘不可写时静默返回 `undefined`，调用方回退原 PNG，绝不阻断窗口启动。
 */
export function ensureWindowsBrandIco(
  sourcePngPath: string,
  cacheDir: string,
  createImage: (filePath: string) => ResizableImage,
): string | undefined {
  try {
    if (!fs.existsSync(sourcePngPath)) return undefined;
    const digest = createHash('sha256')
      .update(fs.readFileSync(sourcePngPath))
      .digest('hex')
      .slice(0, 12);
    const targetPath = path.join(cacheDir, `kapibala-brand-${digest}.ico`);
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 64) return targetPath;

    const base = createImage(sourcePngPath);
    if (base.isEmpty()) return undefined;
    const frames = ICO_SIZES.map((size) => ({
      size,
      png: base.resize({ width: size, height: size, quality: 'best' }).toPNG(),
    }));
    const icoBuffer = encodePngFramesToIco(frames);

    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const tempPath = `${targetPath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, icoBuffer, { mode: 0o600, flag: 'wx' });
      fs.renameSync(tempPath, targetPath);
    } finally {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    }
    return targetPath;
  } catch {
    return undefined;
  }
}
