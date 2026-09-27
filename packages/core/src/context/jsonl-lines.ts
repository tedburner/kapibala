import fs from 'node:fs';

/** 按 UTF-8 行扫描，缓存只保留一个记录和 64 KiB 分块，offset 表示行首字节位置。 */
export function* readJsonlLines(
  file: string,
): Generator<{ text: string; offset: number; terminated: boolean }> {
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let pending = Buffer.alloc(0);
  let offset = 0;
  try {
    while (true) {
      const length = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!length) break;
      pending = Buffer.concat([pending, buffer.subarray(0, length)]);
      let start = 0;
      let end = pending.indexOf(10, start);
      while (end >= 0) {
        const text = pending.subarray(start, end).toString('utf8');
        yield { text, offset, terminated: true };
        offset += end - start + 1;
        start = end + 1;
        end = pending.indexOf(10, start);
      }
      pending = Buffer.from(pending.subarray(start));
    }
    if (pending.length) yield { text: pending.toString('utf8'), offset, terminated: false };
  } finally {
    fs.closeSync(fd);
  }
}

/** POSIX 上持久化目录项安装；Windows 不支持目录 fsync，正文 fsync 仍严格执行。 */
export function syncSessionDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
