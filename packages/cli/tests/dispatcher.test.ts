import { describe, expect, it, vi } from 'vitest';
import { clearCommand } from '../src/commands/clear.js';
import { type CommandContext, CommandDispatcher } from '../src/commands/dispatcher.js';
import { modelCommand } from '../src/commands/model.js';

describe('CommandDispatcher', () => {
  const dispatcher = new CommandDispatcher();
  dispatcher.register('clear', clearCommand);
  dispatcher.register('model', modelCommand);

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
});
