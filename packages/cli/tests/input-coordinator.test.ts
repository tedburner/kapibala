import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CliInputCoordinator } from '../src/input-coordinator.js';

function create(interactive = true) {
  const input = new PassThrough();
  let text = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  const coordinator = new CliInputCoordinator({ input, output, interactive, terminal: false });
  return { input, coordinator, output: () => text };
}
describe('shared CLI input ownership', () => {
  it('keeps terminal secret edits out of output and refuses noninteractive approvals', async () => {
    const input = new PassThrough();
    let text = '';
    const output = new Writable({
      write(chunk, _encoding, callback) {
        text += chunk.toString();
        callback();
      },
    });
    const coordinator = new CliInputCoordinator({
      input,
      output,
      interactive: true,
      terminal: true,
    });
    try {
      const secret = coordinator.readSecret('key: ');
      input.write('hidden-value\n');
      expect(await secret).toBe('hidden-value');
      expect(text).not.toContain('hidden-value');
    } finally {
      coordinator.close();
    }
    const pipe = create(false);
    try {
      expect(
        await pipe.coordinator.approve({
          toolName: 'write_file',
          capabilities: ['fs:write'],
          input: {},
          rootDir: '.',
          sessionAllowed: true,
        }),
      ).toBe('deny_once');
    } finally {
      pipe.coordinator.close();
    }
  });
  it('consumes modal answers exactly once and returns later chat to the host', async () => {
    const { input, coordinator } = create();
    const chat: string[] = [];
    coordinator.onLine((line) => chat.push(line));
    const choice = coordinator.select({
      message: 'choose',
      options: [
        { label: 'one', value: 'one' },
        { label: 'two', value: 'two' },
      ],
    });
    input.write('2\n');
    expect(await choice).toBe('two');
    const secret = coordinator.readSecret('key: ');
    input.write('test-secret\n');
    expect(await secret).toBe('test-secret');
    input.write('question\n');
    expect(chat).toEqual(['question']);
    coordinator.close();
  });

  it('cancels menus and EOF without passing cancelled input to another flow', async () => {
    const { input, coordinator } = create();
    const menu = coordinator.select({ message: 'choose', options: [{ label: 'one', value: 1 }] });
    input.emit('keypress', '\u001b', { name: 'escape' });
    expect(await menu).toBe(null);
    const interrupted = coordinator.select({
      message: 'choose',
      options: [{ label: 'one', value: 1 }],
    });
    process.emit('SIGINT');
    expect(await interrupted).toBe(null);
    const secret = coordinator.readSecret('key: ');
    input.end();
    await expect(secret).rejects.toThrow(/cancel|closed|取消/i);
    expect(coordinator.isBusy()).toBe(false);
  });

  it('never waits for noninteractive questions or menus and prevents simultaneous readers', async () => {
    const pipe = create(false);
    await expect(pipe.coordinator.question('prompt')).rejects.toThrow(/交互|interactive/i);
    expect(
      await pipe.coordinator.select({ message: 'choose', options: [{ label: 'one', value: 1 }] }),
    ).toBe(null);
    pipe.coordinator.close();
    const tty = create();
    const first = tty.coordinator.question('first');
    await expect(tty.coordinator.readSecret('second')).rejects.toThrow(/busy|占用/i);
    tty.input.write('answer\n');
    expect(await first).toBe('answer');
    tty.coordinator.close();
  });
});
