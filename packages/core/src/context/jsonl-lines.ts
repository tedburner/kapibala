import fs from 'node:fs';
import { KapibalaError } from '../errors/index.js';

/** 可选单文件读取预算；省略保持旧行为，超限不得被当成 JSON 尾损坏恢复。 */
export interface HistoryReadOptions {
  /** 编码字节总量上限，必须为正安全整数；不限制已打开事务的追加落盘。 */
  maxReadBytes?: number;
}

/** 统一校验字节预算；配置错误与实际文件超限使用不同错误码。 */
export function assertHistoryReadBudget(bytes: number, options: HistoryReadOptions): void {
  const limit = options.maxReadBytes;
  if (limit === undefined) return;
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new KapibalaError('Invalid history read budget', { code: 'CONFIG_INVALID' });
  if (bytes > limit)
    throw new KapibalaError('History exceeds the configured read budget', {
      code: 'HISTORY_READ_LIMIT',
      retryPolicy: 'after_user_action',
      safeMessage: '历史文件超过读取预算，原文件保持不变',
    });
}

/** 复制和升级前有界读取原始字节；使用同一打开描述符复核大小与增长，不先无界分配。 */
export function readHistoryBytes(file: string, options: HistoryReadOptions = {}): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    assertHistoryReadBudget(fs.fstatSync(fd).size, options);
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const length = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!length) break;
      total += length;
      assertHistoryReadBudget(total, options);
      chunks.push(Buffer.from(buffer.subarray(0, length)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    fs.closeSync(fd);
  }
}

/** 按 UTF-8 行扫描，缓存只保留一个记录和 64 KiB 分块，offset 表示行首字节位置。 */
export function* readJsonlLines(
  file: string,
  options: HistoryReadOptions = {},
): Generator<{ text: string; offset: number; terminated: boolean }> {
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let pending = Buffer.alloc(0);
  let offset = 0;
  let total = 0;
  try {
    assertHistoryReadBudget(fs.fstatSync(fd).size, options);
    while (true) {
      const length = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!length) break;
      total += length;
      assertHistoryReadBudget(total, options);
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
