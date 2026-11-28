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

  it('clears readline edit buffer on question() entry when user navigated history or typed ahead', async () => {
    const { input, coordinator } = create(true, true);
    coordinator.onLine(() => {});
    input.write('previous prompt\n');
    // 运行中用户按了 ↑ 召回历史，缓冲里留着 previous prompt
    input.emit('keypress', '', { name: 'up' });
    expect(coordinator.getLine()).toBe('previous prompt');
    const approval = coordinator.approve(
      {
        toolName: 'run_command',
        capabilities: ['exec'],
        input: { command: 'ls' },
        rootDir: '/repo',
        sessionAllowed: false,
      },
      new AbortController().signal,
    );
    input.write('1\n');
    expect(await approval).toBe('allow_once');
    // 审批结束后恢复用户在空闲提示符上尚未提交的草稿文本
    expect(coordinator.getLine()).toBe('previous prompt');
    coordinator.close();
  });

  it('restores unfinished idle draft and cursor after background approve() and protects multi-step withCommandSession()', async () => {
    const { input, coordinator } = create(true, true);
    coordinator.onLine(() => {});
    input.write('draft before approval');
    expect(coordinator.getLine()).toBe('draft before approval');

    const bgApproval = coordinator.approve({
      toolName: 'write_file',
      capabilities: ['fs:write'],
      input: { path: 'x.ts' },
      rootDir: '/repo',
      sessionAllowed: true,
    });
    input.write('2\n');
    expect(await bgApproval).toBe('allow_session');
    expect(coordinator.getLine()).toBe('draft before approval');

    // 在多步命令（select -> readSecret）期间到达的后台审批必须等整个 withCommandSession 结束后才接管输入
    const events: string[] = [];
    let queuedApproval!: Promise<string>;
    const sessionFlow = coordinator.withCommandSession(async () => {
      const firstPromise = coordinator.select({
        message: 'step 1',
        options: [{ label: 'provider-a', value: 'a' }],
      });
      queuedApproval = coordinator
        .approve({
          toolName: 'write_file',
          capabilities: ['fs:write'],
          input: { path: 'y.ts' },
          rootDir: '/repo',
          sessionAllowed: true,
        })
        .then((choice) => {
          events.push(`approval:${choice}`);
          return choice;
        });
      input.write('1\n');
      const selected = await firstPromise;
      events.push(`select:${selected}`);
      const keyPromise = coordinator.readSecret('API Key: ');
      input.write('sk-multi-step\n');
      const key = await keyPromise;
      events.push(`secret:${key}`);
    });

    await sessionFlow;
    input.write('1\n');
    await queuedApproval;
    expect(events).toEqual(['select:a', 'secret:sk-multi-step', 'approval:allow_once']);
    coordinator.close();
  });
});
