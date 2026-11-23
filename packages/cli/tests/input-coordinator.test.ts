import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CliInputCoordinator } from '../src/input-coordinator.js';

function create(interactive = true, terminal = false) {
  const input = new PassThrough();
  let text = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  const coordinator = new CliInputCoordinator({ input, output, interactive, terminal });
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

  it('recalls only chat lines with arrows and restores the unfinished draft', async () => {
    const { input, coordinator } = create(true, true);
    const chat: string[] = [];
    coordinator.onLine((line) => chat.push(line));
    input.write('first question\n');
    input.write('second question\n');
    expect(chat).toEqual(['first question', 'second question']);
    // 上翻到最近一次问句，再上翻到更早；到顶后保持不动。
    input.emit('keypress', '', { name: 'up' });
    expect(coordinator.getLine()).toBe('second question');
    input.emit('keypress', '', { name: 'up' });
    expect(coordinator.getLine()).toBe('first question');
    input.emit('keypress', '', { name: 'up' });
    expect(coordinator.getLine()).toBe('first question');
    // 下翻回到最新问句，再下翻恢复空草稿并停住。
    input.emit('keypress', '', { name: 'down' });
    expect(coordinator.getLine()).toBe('second question');
    input.emit('keypress', '', { name: 'down' });
    expect(coordinator.getLine()).toBe('');
    // 未提交草稿在首次上翻时被保存，回到最新项必须原样恢复而不是丢弃。
    input.write('未提交草稿');
    expect(coordinator.getLine()).toBe('未提交草稿');
    input.emit('keypress', '', { name: 'up' });
    expect(coordinator.getLine()).toBe('second question');
    input.emit('keypress', '', { name: 'down' });
    expect(coordinator.getLine()).toBe('未提交草稿');
    coordinator.close();
  });

  it('keeps modal answers, secrets and blank lines out of the arrow history', async () => {
    const { input, coordinator } = create();
    const chat: string[] = [];
    coordinator.onLine((line) => chat.push(line));
    input.write('real question\n');
    input.write('\n');
    const choice = coordinator.select({ message: 'choose', options: [{ label: 'one', value: 1 }] });
    input.write('1\n');
    expect(await choice).toBe(1);
    const secret = coordinator.readSecret('key: ');
    input.write('sk-secret\n');
    expect(await secret).toBe('sk-secret');
    input.emit('keypress', '', { name: 'up' });
    expect(coordinator.getLine()).toBe('real question');
    input.emit('keypress', '', { name: 'up' });
    expect(coordinator.getLine()).toBe('real question');
    coordinator.close();
  });
});
