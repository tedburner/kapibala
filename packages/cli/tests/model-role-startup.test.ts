import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';
import { BUILTIN_CATALOG_VERSION, BUILTIN_PROFILES } from '../src/settings.js';

describe('noninteractive CLI model roles', () => {
  let directory: string;
  let models: string[];
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-role-startup-'));
    fs.mkdirSync(path.join(directory, '.kapibala'));
    fs.mkdirSync(path.join(directory, 'project'));
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(directory, 'project'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    models = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url, init) => {
        models.push(JSON.parse(String(init.body)).model);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                ),
              );
              controller.close();
            },
          }),
          { status: 200 },
        );
      }),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.exitCode = undefined;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const save = (planning = true, defaultNeedsKey = false) => {
    const make = (id: string) => ({
      id,
      name: id,
      provider: 'openai-compatible',
      modelName: id,
      baseURL: `https://${id}.example/v1`,
      apiKeyEnv: 'NONE',
      contextWindow: '32K',
    });
    fs.writeFileSync(
      path.join(directory, '.kapibala', 'settings.json'),
      JSON.stringify({
        builtinCatalogVersion: BUILTIN_CATALOG_VERSION,
        defaultModel: 'normal',
        modelRouting: planning ? { planning: 'planner' } : undefined,
        profiles: [
          {
            ...make('normal'),
            ...(defaultNeedsKey ? { apiKeyEnv: 'UNSET_DEFAULT_CLI_TEST_KEY' } : {}),
          },
          make('planner'),
        ],
      }),
    );
  };

  it('rejects unsupported or missing roles before any model request or input wait', async () => {
    save(false);
    await expect(main(['--role', 'summary', '--disable-shell', '-p', 'test'])).rejects.toThrow(
      /role/,
    );
    await expect(main(['--role', 'fast', '--disable-shell', '-p', 'test'])).rejects.toThrow(
      /fast.*尚未配置/,
    );
    expect(models).toEqual([]);
    expect(fs.readdirSync(path.join(directory, '.kapibala'))).toEqual(['settings.json']);
  });

  it('uses the explicit role and returns to default on the next process-style startup with history continuation', async () => {
    save();
    await main(['--role', 'planning', '--model', 'normal', '--disable-shell', '-p', 'plan']);
    await main(['--continue', '--disable-shell', '-p', 'continue']);
    expect(models).toEqual(['planner', 'normal']);
  });

  it('runs a usable explicit role without starting a default credential wizard', async () => {
    save(true, true);
    await main(['--role', 'planning', '--disable-shell', '-p', 'plan']);
    expect(models).toEqual(['planner']);
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('请输入'));
  });

  it('applies temporary credentials and endpoint to the selected role without persisting either', async () => {
    save(true, true);
    const file = path.join(directory, '.kapibala', 'settings.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.profiles[1].apiKeyEnv = 'UNSET_PLANNER_CLI_TEST_KEY';
    fs.writeFileSync(file, JSON.stringify(stored));
    const before = fs.readFileSync(file, 'utf8');
    await main([
      '--role',
      'planning',
      '--api-key',
      'temporary-fixture-key',
      '--base-url',
      'https://temporary-planner.example/v1',
      '--disable-shell',
      '-p',
      'plan',
    ]);
    expect(models).toEqual(['planner']);
    expect(fetch).toHaveBeenCalledWith(
      'https://temporary-planner.example/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer temporary-fixture-key' }),
      }),
    );
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('fails before HTTP when a builtin native role has an invalid output override', async () => {
    save();
    const file = path.join(directory, '.kapibala', 'settings.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.profiles.push({
      ...BUILTIN_PROFILES.find((profile) => profile.id === 'gpt-6-astra')!,
      apiKey: 'fixture-native-key',
      maxOutputTokens: 0,
    });
    stored.modelRouting.planning = 'gpt-6-astra';
    fs.writeFileSync(file, JSON.stringify(stored));
    await expect(
      main([
        '--role',
        'planning',
        '--api-key',
        'temporary-native-key',
        '--disable-shell',
        '-p',
        'plan',
      ]),
    ).rejects.toThrow(/maxOutputTokens/);
    expect(models).toEqual([]);
  });
});
