import { PassThrough } from 'node:stream';
import { setTimeout as pause } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { TerminalInputStream } from '../src/tui/input-stream.js';

class Source extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean) {
    this.isRaw = value;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

describe('Ink single-owner input stream', () => {
  it('preserves key frames and routes paste outside the Ink keyboard path', async () => {
    const source = new Source();
    const pastes: string[] = [];
    const input = new TerminalInputStream(source, { onPaste: (text) => pastes.push(text) });
    const keys: string[] = [];
    input.on('readable', () => {
      for (;;) {
        const next: string | null = input.read();
        if (next === null) break;
        keys.push(next);
      }
    });
    input.setRawMode(true);
    expect(source.listenerCount('readable')).toBe(1);
    source.write('\x1b');
    await pause(10);
    source.write('[13;2u');
    source.write('\x1b[200~\r1\x03\x1b[201~');
    source.write('\r');
    await pause(10);
    expect(keys).toEqual(['\x1b[13;2u', '\r']);
    expect(pastes).toEqual(['\r1\x03']);
    input.setRawMode(false);
    expect(source.isRaw).toBe(false);
    expect(source.listenerCount('readable')).toBe(0);
    expect(source.listenerCount('end')).toBe(0);
    source.write('late');
    await pause(5);
    expect(keys).toHaveLength(2);
    input.destroy();
  });

  it('closes pending input on EOF without dispatching incomplete Escape', async () => {
    const source = new Source();
    const input = new TerminalInputStream(source, {
      onPaste: () => {
        throw new Error('partial paste');
      },
    });
    const keys: string[] = [];
    input.on('data', (key: string) => keys.push(key));
    input.setRawMode(true);
    source.end('\x1b[200~unfinished');
    await pause(60);
    expect(keys).toEqual([]);
    expect(input.readableEnded).toBe(true);
    expect(source.listenerCount('readable')).toBe(0);
    expect(source.isRaw).toBe(false);
  });

  it('does not replay buffered keys when raw input is transferred to another consumer', async () => {
    const source = new Source();
    const input = new TerminalInputStream(source, { onPaste: () => {} });
    input.setRawMode(true);
    source.write('1\r');
    await pause(5);
    input.setRawMode(false);
    input.setRawMode(true);
    expect(input.read()).toBeNull();
    input.destroy();
  });
});
