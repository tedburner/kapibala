import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../src/models/anthropic/index.js';
import { OpenAICompatibleProvider } from '../src/models/openai-compatible/index.js';
import { OpenAIResponsesProvider } from '../src/models/openai-responses/index.js';
import { validateProtocolContent } from '../src/models/protocol-state.js';
import type { CanonicalMessage, ContentBlock } from '../src/types/index.js';

const endpoint = 'https://example.test/v1';
const options = { baseURL: endpoint, apiKey: 'fixture-key' };
const REFERENCE_TEXT = '被引用的历史正文：登录超时的排查结论';
const referenceBlock: ContentBlock = {
  type: 'text',
  text: REFERENCE_TEXT,
  referenceSource: {
    version: 1,
    sessionId: 'ref-session-id',
    recordId: 'ref-record-id',
    branchId: 'main',
    role: 'user',
    timestamp: 1763200000000,
    title: '修复登录超时',
    contentDigest: '0123456789abcdef',
    truncated: true,
  },
};
const message: CanonicalMessage = {
  id: 'u1',
  role: 'user',
  state: 'completed',
  timestamp: Date.now(),
  content: [referenceBlock],
};

const sse = (events: Record<string, unknown>[]) =>
  new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
  );

/** Anthropic 最小合法流：只回一段文本，够走完终态即可。 */
const anthropicStream = () =>
  sse([
    {
      type: 'message_start',
      message: { id: 'a', type: 'message', role: 'assistant', content: [], usage: {} },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
    { type: 'message_stop' },
  ]);

/** Responses 最小合法流：一个 completed 事件带一条 output_text。 */
const responsesStream = () =>
  sse([
    {
      type: 'response.completed',
      response: {
        status: 'completed',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        output: [
          {
            type: 'message',
            id: 'final',
            role: 'assistant',
            status: 'completed',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: 'ok', annotations: [] }],
          },
        ],
      },
    },
  ]);

afterEach(() => vi.unstubAllGlobals());

describe('引用块只以 text 进入 wire', () => {
  /** 打桩 fetch，返回给定响应并记录请求体；每次协议调用都重新记录。 */
  async function captureBody(
    response: () => Response,
    call: () => AsyncIterable<unknown>,
  ): Promise<string> {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
        bodies.push(String(init.body ?? ''));
        return response();
      }),
    );
    for await (const _ of call()) {
      /* 消费到终态 */
    }
    expect(bodies).toHaveLength(1);
    return bodies[0];
  }

  it('Anthropic 请求体保留正文，不携带 referenceSource 或摘要字段', async () => {
    const body = await captureBody(anthropicStream, () =>
      new AnthropicProvider({ ...options, modelName: 'claude' }).create({
        systemPrompt: 'sys',
        maxTokens: 16,
        messages: [message],
      }),
    );
    expect(body).toContain(REFERENCE_TEXT);
    expect(body).not.toContain('referenceSource');
    expect(body).not.toContain('contentDigest');
    expect(body).not.toContain('ref-session-id');
    expect(body).not.toContain('ref-record-id');
  });

  it('OpenAI Responses 请求体保留正文，不携带 referenceSource 或摘要字段', async () => {
    const body = await captureBody(responsesStream, () =>
      new OpenAIResponsesProvider({ ...options, modelName: 'openai' }).create({
        systemPrompt: 'sys',
        maxTokens: 16,
        messages: [message],
      }),
    );
    expect(body).toContain(REFERENCE_TEXT);
    expect(body).not.toContain('referenceSource');
    expect(body).not.toContain('contentDigest');
    expect(body).not.toContain('ref-session-id');
  });

  it('Chat Completions 请求体保留正文，不携带 referenceSource 或摘要字段', async () => {
    const body = await captureBody(
      () =>
        new Response(
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        ),
      () =>
        new OpenAICompatibleProvider({ ...options, modelName: 'chat' }).create({
          systemPrompt: 'sys',
          maxTokens: 16,
          messages: [message],
        }),
    );
    expect(body).toContain(REFERENCE_TEXT);
    expect(body).not.toContain('referenceSource');
    expect(body).not.toContain('contentDigest');
    expect(body).not.toContain('ref-session-id');
  });
});

describe('referenceSource 结构校验', () => {
  it('接受完整的 v1 来源元数据', () => {
    expect(() => validateProtocolContent([referenceBlock])).not.toThrow();
  });

  it('拒绝缺字段、错版本与非法角色的来源元数据', () => {
    const broken = (source: Record<string, unknown>): ContentBlock => ({
      type: 'text',
      text: 'x',
      referenceSource: source as never,
    });
    const valid = referenceBlock.type === 'text' ? referenceBlock.referenceSource : undefined;
    expect(valid).toBeDefined();
    // 版本号错误
    expect(() => validateProtocolContent([broken({ ...valid!, version: 2 })])).toThrow();
    // 缺记录身份
    expect(() => validateProtocolContent([broken({ ...valid!, recordId: '' })])).toThrow();
    // 非法角色
    expect(() => validateProtocolContent([broken({ ...valid!, role: 'tool' })])).toThrow();
    // 摘要格式错误
    expect(() => validateProtocolContent([broken({ ...valid!, contentDigest: 'XYZ' })])).toThrow();
    // 时间戳非安全整数
    expect(() => validateProtocolContent([broken({ ...valid!, timestamp: 1.5 })])).toThrow();
  });
});
