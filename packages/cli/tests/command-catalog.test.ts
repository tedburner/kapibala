import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_CATALOG } from '../src/commands/catalog.js';
import { type CommandContext, CommandDispatcher } from '../src/commands/dispatcher.js';

const context = (busy = false) =>
  ({
    session: { isBusy: () => busy },
    settings: {},
    onExit: () => {},
    onModelSwitched: () => {},
  }) as unknown as CommandContext;
describe('unified slash command contract', () => {
  beforeEach(() => {
    // 预期的命令拒绝提示由测试捕获并断言，不混入本地启动校验输出。
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects duplicate command names and aliases', () => {
    const dispatcher = new CommandDispatcher();
    dispatcher.registerDefinition(
      {
        name: 'new',
        aliases: ['clear'],
        usage: '/new',
        description: 'new',
        group: 'session',
        mutates: () => true,
        validate: () => undefined,
      },
      () => {},
    );
    expect(() => dispatcher.register('clear', () => {})).toThrow(/duplicate/i);
    expect(dispatcher.getDefinition('clear')?.name).toBe('new');
  });
  it('validates extra arguments, bounds and subcommands before invoking handlers', async () => {
    const dispatcher = new CommandDispatcher();
    const handlers = new Map<string, ReturnType<typeof vi.fn>>();
    for (const definition of COMMAND_CATALOG) {
      const handler = vi.fn();
      handlers.set(definition.name, handler);
      dispatcher.registerDefinition(definition, handler);
    }
    const invalidInputs = [
      ['/compact unexpected', '不接受参数。用法: /compact'],
      ['/history 0', '参数必须为范围内的正整数。用法: /history [page]'],
      ['/logs 101', '参数必须为范围内的正整数。用法: /logs [count]'],
      [
        '/settings unexpected',
        '使用 setup 或 default <id>。用法: /settings [setup | default <id>]',
      ],
      [
        '/model key a b',
        `模型参数或子命令不正确。用法: ${COMMAND_CATALOG.find((command) => command.name === 'model')!.usage}`,
      ],
      ['/permissions strange', '未知权限模式。用法: /permissions [approval|plan|auto|full-access]'],
      ['/new extra', '不接受参数。用法: /new'],
    ];
    for (const [input, error] of invalidInputs) {
      expect(await dispatcher.dispatch(input, context())).toBe(true);
      expect(console.log).toHaveBeenLastCalledWith(`命令执行失败: ${error}`);
    }
    expect(console.log).toHaveBeenCalledTimes(invalidInputs.length);
    expect([...handlers.values()].every((handler) => handler.mock.calls.length === 0)).toBe(true);
    await dispatcher.dispatch('/RENAME 修复  登录 问题', context());
    expect(handlers.get('rename')).toHaveBeenCalledWith(['修复  登录 问题'], expect.anything());
    await dispatcher.dispatch('/clear', context());
    expect(handlers.get('new')).toHaveBeenCalledOnce();
  });
  it('rejects busy mutations but lets snapshot reads proceed and ordinary words stay chat', async () => {
    const dispatcher = new CommandDispatcher();
    const mutation = vi.fn();
    const read = vi.fn();
    dispatcher.registerDefinition(COMMAND_CATALOG.find((d) => d.name === 'new')!, mutation);
    dispatcher.registerDefinition(COMMAND_CATALOG.find((d) => d.name === 'status')!, read);
    await dispatcher.dispatch('/new', context(true));
    expect(mutation).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('命令执行失败: 会话忙，请等待执行和清理完成后重试');
    await dispatcher.dispatch('/status', context(true));
    expect(read).toHaveBeenCalledOnce();
    expect(await dispatcher.dispatch('status please', context())).toBe(false);
    expect(await dispatcher.dispatch('/future-command', context())).toBe(true);
    expect(console.log).toHaveBeenLastCalledWith(
      '未知命令: /future-command。输入 /help 查看支持的命令。',
    );
    expect(console.log).toHaveBeenCalledTimes(2);
  });
});
