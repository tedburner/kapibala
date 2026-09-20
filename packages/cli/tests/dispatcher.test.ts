import { describe, expect, it, vi } from 'vitest';
import { clearCommand } from '../src/commands/clear.js';
import { type CommandContext, CommandDispatcher } from '../src/commands/dispatcher.js';
import { modelCommand } from '../src/commands/model.js';

describe('CommandDispatcher', () => {
  const dispatcher = new CommandDispatcher();
  dispatcher.register('clear', clearCommand);
  dispatcher.register('model', modelCommand);
  dispatcher.register('exit', (_args, ctx) => ctx.onExit());
  dispatcher.register('quit', (_args, ctx) => ctx.onExit());
  const mockSession = {
    reset: vi.fn().mockResolvedValue(undefined),
    getActiveProfile: vi.fn().mockReturnValue({
      id: 'mock-1',
      name: 'Mock Model',
      modelName: 'mock-v1',
      baseURL: 'http://localhost',
    }),
  } as any;

  const mockSettings = {
    defaultModel: 'mock-1',
    profiles: [
      {
        id: 'mock-1',
        name: 'Mock Model',
        modelName: 'mock-v1',
        baseURL: 'http://localhost',
        apiKeyEnv: 'NONE',
      },
      {
        id: 'mock-2',
        name: 'DeepSeek V4 Pro',
        modelName: 'deepseek-v4-pro',
        baseURL: 'https://api.deepseek.com',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        apiKey: 'fixture-key',
      },
    ],
  } as any;

  const createCtx = (overrides?: Partial<CommandContext>): CommandContext => ({
    session: mockSession,
    settings: mockSettings,
    onModelSwitched: vi.fn(),
    onExit: vi.fn(),
    ...overrides,
  });

  it('should return false for regular messages', async () => {
    const ctx = createCtx();
    const handled = await dispatcher.dispatch('hello world', ctx);
    expect(handled).toBe(false);
  });

  it('should dispatch /clear and reset session', async () => {
    const ctx = createCtx();
    const handled = await dispatcher.dispatch('/clear', ctx);
    expect(handled).toBe(true);
    expect(mockSession.reset).toHaveBeenCalledTimes(1);
  });

  it('should switch model when /model <id> is supplied', async () => {
    const onModelSwitched = vi.fn();
    const ctx = createCtx({ onModelSwitched });

    const handled = await dispatcher.dispatch('/model mock-2', ctx);
    expect(handled).toBe(true);
    expect(onModelSwitched).toHaveBeenCalledWith('mock-2');
  });

  it('should handle unknown slash commands gracefully', async () => {
    const ctx = createCtx();
    const handled = await dispatcher.dispatch('/unknown-cmd', ctx);
    expect(handled).toBe(true);
  });

  // 裸 exit / quit 必须被识别：若落到模型会把「想退出」变成一次真实的 API 调用。
  it('should treat bare "exit" as the exit command', async () => {
    const onExit = vi.fn();
    const handled = await dispatcher.dispatch('exit', createCtx({ onExit }));
    expect(handled).toBe(true);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('should treat bare "quit" as the exit command', async () => {
    const onExit = vi.fn();
    const handled = await dispatcher.dispatch('QUIT', createCtx({ onExit }));
    expect(handled).toBe(true);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  // 白名单必须限定为单个词，否则会误伤自然语言提问。
  it('should not treat a sentence starting with "exit" as a command', async () => {
    const onExit = vi.fn();
    const handled = await dispatcher.dispatch('exit the current directory', createCtx({ onExit }));
    expect(handled).toBe(false);
    expect(onExit).not.toHaveBeenCalled();
  });

  // 其余命令仍需斜杠，避免把 help / status 等普通词汇误判为命令。
  // dispatch 返回 false 即代表「未当命令处理」，不会落到任何 handler。
  it('should still require a slash for non-alias commands', async () => {
    const ctx = createCtx();
    expect(await dispatcher.dispatch('help', ctx)).toBe(false);
    expect(await dispatcher.dispatch('clear', ctx)).toBe(false);
  });
});
