import type { ModelProfile } from '@kiturone/kapibala';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProviderFamily, resolveApiKey, resolveBaseURL } from '../src/settings.js';
import { makeCustomProfileId } from '../src/wizard.js';

const DEEPSEEK_PROFILE: ModelProfile = {
  id: 'deepseek-v4-flash',
  name: 'DeepSeek V4 Flash',
  provider: 'openai-compatible',
  baseURL: 'https://api.deepseek.com/v1',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  modelName: 'deepseek-v4-flash',
};

const OPENAI_PROFILE: ModelProfile = {
  id: 'gpt-4o',
  name: 'OpenAI GPT-4o',
  provider: 'openai-compatible',
  baseURL: 'https://api.openai.com/v1',
  apiKeyEnv: 'OPENAI_API_KEY',
  modelName: 'gpt-4o',
};

const TRACKED_ENV = [
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'DASHSCOPE_API_KEY',
  'CUSTOM_API_KEY',
  'OPENAI_BASE_URL',
  'DEEPSEEK_BASE_URL',
] as const;

const originalEnv = new Map<string, string | undefined>(
  TRACKED_ENV.map((key) => [key, process.env[key]]),
);

function clearTrackedEnv(): void {
  for (const key of TRACKED_ENV) {
    delete process.env[key];
  }
}

afterEach(() => {
  for (const key of TRACKED_ENV) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('resolveApiKey', () => {
  it('按 apiKeyEnv 声明的变量读取密钥', () => {
    clearTrackedEnv();
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek';
    expect(resolveApiKey(DEEPSEEK_PROFILE)).toBe('sk-deepseek');
  });

  it('apiKeyEnv 为 NONE 时返回占位密钥', () => {
    clearTrackedEnv();
    expect(resolveApiKey({ ...DEEPSEEK_PROFILE, apiKeyEnv: 'NONE' })).toBe('none');
  });

  it('不会跨厂商回退：拿 OpenAI 的 key 去打 DeepSeek 端点只会更难排障', () => {
    clearTrackedEnv();
    process.env.OPENAI_API_KEY = 'sk-openai';
    expect(resolveApiKey(DEEPSEEK_PROFILE)).toBeUndefined();
  });

  it('同族回退仍然生效（apiKeyEnv 写错时是唯一的救赎）', () => {
    clearTrackedEnv();
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek';
    expect(resolveApiKey({ ...DEEPSEEK_PROFILE, apiKeyEnv: 'MISSPELLED_ENV' })).toBe('sk-deepseek');
  });

  it('profile 内联密钥优先级最高', () => {
    clearTrackedEnv();
    process.env.DEEPSEEK_API_KEY = 'sk-env';
    expect(resolveApiKey({ ...DEEPSEEK_PROFILE, apiKey: ' sk-inline ' })).toBe('sk-inline');
  });
});

describe('resolveBaseURL', () => {
  it('OPENAI_BASE_URL 覆盖 OpenAI 族端点并去掉尾斜杠', () => {
    clearTrackedEnv();
    process.env.OPENAI_BASE_URL = 'https://proxy.example.com/v1/';
    expect(resolveBaseURL(OPENAI_PROFILE)).toBe('https://proxy.example.com/v1');
  });

  it('DEEPSEEK_BASE_URL 覆盖 DeepSeek 族端点', () => {
    clearTrackedEnv();
    process.env.DEEPSEEK_BASE_URL = 'https://ds-proxy.example.com/v1';
    expect(resolveBaseURL(DEEPSEEK_PROFILE)).toBe('https://ds-proxy.example.com/v1');
  });

  it('其它厂商的环境变量不会串台', () => {
    clearTrackedEnv();
    process.env.DEEPSEEK_BASE_URL = 'https://ds-proxy.example.com/v1';
    expect(resolveBaseURL(OPENAI_PROFILE)).toBe('https://api.openai.com/v1');
  });
});

describe('detectProviderFamily', () => {
  it('按 id / baseURL 推断厂商族', () => {
    expect(detectProviderFamily(DEEPSEEK_PROFILE)).toBe('deepseek');
    expect(detectProviderFamily(OPENAI_PROFILE)).toBe('openai');
    expect(
      detectProviderFamily({
        ...OPENAI_PROFILE,
        id: 'qwen-plus',
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      }),
    ).toBe('qwen');
    expect(
      detectProviderFamily({
        ...OPENAI_PROFILE,
        id: 'ollama',
        baseURL: 'http://localhost:11434/v1',
      }),
    ).toBe('ollama');
    expect(
      detectProviderFamily({ ...OPENAI_PROFILE, id: 'my-gateway', baseURL: 'https://x.dev/v1' }),
    ).toBe('unknown');
  });
});

describe('makeCustomProfileId', () => {
  it('为不同端点生成不同 id —— 第二个自定义端点不会覆盖第一个', () => {
    const first = makeCustomProfileId('My Gateway', 'https://a.example.com/v1');
    const second = makeCustomProfileId('My Gateway', 'https://b.example.com/v1');
    expect(first).not.toBe(second);
  });

  it('同一端点重复配置得到稳定 id，可覆盖自身而非新增条目', () => {
    expect(makeCustomProfileId('My Gateway', 'https://a.example.com/v1')).toBe(
      makeCustomProfileId('My Gateway', 'https://a.example.com/v1'),
    );
  });

  it('中文服务名同样能得到合法 id', () => {
    const id = makeCustomProfileId('我的网关', 'https://a.example.com/v1');
    expect(id.startsWith('custom-')).toBe(true);
    expect(id).toMatch(/^[a-z0-9-]+$/);
  });
});
