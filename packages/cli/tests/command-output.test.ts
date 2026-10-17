import type { AgentSession, ModelProfile } from '@kiturone/kapibala';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentsCommand } from '../src/commands/agents.js';
import { clearCommand } from '../src/commands/clear.js';
import { type CommandContext, CommandDispatcher } from '../src/commands/dispatcher.js';
import { helpCommand } from '../src/commands/help.js';
import { modelCommand, updateModelApiKey } from '../src/commands/model.js';
import { type CommandOutput, resolveCommandOutput } from '../src/host/command-output.js';

const profile: ModelProfile = {
  id: 'local',
  name: '本地模型',
  modelName: 'local',
  baseURL: 'http://localhost',
  apiKeyEnv: 'NONE',
  provider: 'openai-compatible',
};

function context(output?: CommandOutput): CommandContext {
  return {
    session: {
      reset: vi.fn().mockResolvedValue(undefined),
      getActiveProfile: () => profile,
    } as unknown as AgentSession,
    settings: { defaultModel: profile.id, profiles: [{ ...profile }] },
    onModelSwitched: vi.fn(),
    onExit: vi.fn(),
    output,
  };
}

function capture() {
  const messages: { channel: 'stdout' | 'stderr'; text: string }[] = [];
  const output: CommandOutput = {
    log: (text) => messages.push({ channel: 'stdout', text }),
    error: (text) => messages.push({ channel: 'stderr', text }),
    write: (text, channel = 'stdout') => messages.push({ channel, text }),
  };
  return { output, messages };
}

afterEach(() => vi.restoreAllMocks());

describe('injected command output', () => {
  it('captures command results, help and dispatcher diagnostics without writing to the console', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { output, messages } = capture();
    const ctx = context(output);
    const dispatcher = new CommandDispatcher();
    dispatcher.register('clear', clearCommand);
    dispatcher.register('help', helpCommand);
    dispatcher.register('broken', () => {
      throw new Error('受控失败');
    });
    ctx.dispatcher = dispatcher;

    await dispatcher.dispatch('/clear', ctx);
    await dispatcher.dispatch('/help clear', ctx);
    await dispatcher.dispatch('/missing', ctx);
    await dispatcher.dispatch('/broken', ctx);

    expect(messages.some((message) => message.text.includes('会话上下文已清空'))).toBe(true);
    expect(messages.some((message) => message.text.startsWith('/clear'))).toBe(true);
    expect(messages.some((message) => message.text.includes('未知命令: /missing'))).toBe(true);
    expect(messages).toContainEqual({ channel: 'stdout', text: '命令执行失败: 受控失败' });
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('preserves command stderr classification independently from dispatcher stdout diagnostics', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { output, messages } = capture();
    const ctx = context(output);
    ctx.runtime = { getTask: () => undefined } as unknown as CommandContext['runtime'];
    await agentsCommand(['show', 'missing'], ctx);
    expect(messages).toContainEqual({
      channel: 'stderr',
      text: '❌ 未找到指定的子代理任务: missing',
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('routes model menu action messages through the same injected port', async () => {
    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    try {
      const { output, messages } = capture();
      const ctx = context(output);
      ctx.select = async <T>() => '__action_update_key__' as T;
      await modelCommand([], ctx);
      expect(messages.some((message) => message.text.includes('不需要 API Key'))).toBe(true);
    } finally {
      if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
      if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  });

  it('keeps secret input separate from the captured update notification', async () => {
    const { output, messages } = capture();
    const ctx = context(output);
    const keyedProfile = { ...profile, apiKeyEnv: 'LOCAL_API_KEY' };
    ctx.settings.profiles = [keyedProfile];
    await updateModelApiKey(keyedProfile, ctx, {
      secretReader: async () => 'fixture-sensitive-value',
      saveSettings: () => 'isolated/settings.json',
      globalSettings: ctx.settings,
    });
    expect(messages.some((message) => message.text.includes('已更新'))).toBe(true);
    expect(messages.every((message) => !message.text.includes('fixture-sensitive-value'))).toBe(
      true,
    );
  });
});

describe('default text output compatibility', () => {
  it('preserves console line methods and raw stdout/stderr writes without adding newlines', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const output = resolveCommandOutput({});
    output.log('结果');
    output.error('错误');
    output.write('片段');
    output.write('诊断片段', 'stderr');
    expect(log).toHaveBeenCalledExactlyOnceWith('结果');
    expect(error).toHaveBeenCalledExactlyOnceWith('错误');
    expect(stdout).toHaveBeenCalledExactlyOnceWith('片段');
    expect(stderr).toHaveBeenCalledExactlyOnceWith('诊断片段');
  });
});
