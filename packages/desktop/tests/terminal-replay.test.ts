import { describe, expect, it, vi } from 'vitest';
import {
  MAX_TERMINAL_REPLAY_CHUNKS,
  appendTerminalReplay,
  clearTerminalReplay,
  createTerminalDataBatcher,
  createTerminalReplayBuffer,
  readTerminalReplayText,
  sliceReplayTailByJsonBytes,
} from '../src/agent-host/terminal-replay.js';

describe('TerminalReplayBuffer & TerminalDataBatcher', () => {
  it('preserves ordered chunks and evicts oldest chunks once exceeding maxChars', () => {
    const buffer = createTerminalReplayBuffer();
    appendTerminalReplay(buffer, 'chunk-1\n', 16);
    appendTerminalReplay(buffer, 'chunk-2\n', 16);
    appendTerminalReplay(buffer, 'chunk-3\n', 16);

    const text = readTerminalReplayText(buffer);
    expect(text).toBe('chunk-2\nchunk-3\n');
    expect(buffer.length).toBe(16);
  });

  it('slices oversized single chunk without leaving orphaned UTF-16 low surrogate', () => {
    const buffer = createTerminalReplayBuffer();
    // '🚀' 占 2 个 UTF-16 码元（高代理 + 低代理）
    appendTerminalReplay(buffer, 'abc🚀xyz', 4);
    const text = readTerminalReplayText(buffer);
    expect(text).toBe('xyz');
    expect(buffer.length).toBe(3);

    clearTerminalReplay(buffer);
    expect(readTerminalReplayText(buffer)).toBe('');
    expect(buffer.length).toBe(0);
  });

  it('compacts chunk array when interactive single-key appends exceed chunk threshold', () => {
    const buffer = createTerminalReplayBuffer();
    for (let i = 0; i < MAX_TERMINAL_REPLAY_CHUNKS + 20; i++) {
      appendTerminalReplay(buffer, 'x', 200_000);
    }
    expect(buffer.chunks.length).toBeLessThanOrEqual(MAX_TERMINAL_REPLAY_CHUNKS);
    expect(readTerminalReplayText(buffer).length).toBe(MAX_TERMINAL_REPLAY_CHUNKS + 20);
  });

  it('coalesces rapid chunks within frame interval and flushes deterministically before exit', () => {
    vi.useFakeTimers();
    try {
      const batches: string[] = [];
      const batcher = createTerminalDataBatcher((data) => batches.push(data), 16, 32);

      batcher.push('prompt$ ');
      batcher.push('ls -la\r\n');
      expect(batches).toEqual([]);

      vi.advanceTimersByTime(16);
      expect(batches).toEqual(['prompt$ ls -la\r\n']);

      // 超过 maxBatchChars 立即同步冲刷
      batcher.push('a'.repeat(40));
      expect(batches).toHaveLength(2);
      expect(batches[1]).toBe('a'.repeat(40));

      // 进程退出前显式 flush 保序
      batcher.push('[exited]');
      batcher.flush();
      expect(batches[2]).toBe('[exited]');
      batcher.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps JSON-escaped UTF-8 byte length on code-point boundaries without splitting surrogate pairs', () => {
    // 含 ANSI 控制符（JSON 转义为 \u001b 占 6 字节）、中文（3 字节）与 Emoji 代理对（4 字节）
    const noisy = `${'\x1b[38;2;255;100;0m中文🚀\r\n'.repeat(500)}TAIL_MARKER`;
    const budget = 1024;
    const sliced = sliceReplayTailByJsonBytes(noisy, budget);
    const jsonBytes = Buffer.byteLength(JSON.stringify(sliced), 'utf8') - 2;
    expect(jsonBytes).toBeLessThanOrEqual(budget);
    expect(sliced.endsWith('TAIL_MARKER')).toBe(true);
    // 首字符绝不能是孤立的 UTF-16 低代理项
    const firstCode = sliced.charCodeAt(0);
    expect(firstCode < 0xdc00 || firstCode > 0xdfff).toBe(true);
  });
});
