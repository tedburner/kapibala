import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeModelCatalog } from '../src/host/model-probe.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeModelCatalog', () => {
  it('extracts the declared context window for the requested model', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () =>
          Promise.resolve(
            JSON.stringify({
              data: [
                { id: 'other-model', context_length: 4096 },
                { id: 'target-model', context_length: 1048576 },
              ],
            }),
          ),
      }),
    );
    expect(
      await probeModelCatalog({
        baseURL: 'http://127.0.0.1:3425/',
        provider: 'openai-compatible',
        modelName: 'target-model',
        credential: 'fixture-key',
      }),
    ).toEqual({ status: 'ok', detail: 'HTTP 200', contextWindow: 1048576 });
    // 尾随斜杠被剥掉，路径落在 {baseURL}/models，鉴权走 Bearer。
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3425/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer fixture-key' }),
      }),
    );
  });

  it('falls back to the single-entry catalog and rejects implausible values', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () =>
          Promise.resolve(JSON.stringify({ data: [{ id: 'only', context_window: 512 }] })),
      }),
    );
    // 数值低于可信下限（512 < 1024）时不采信，避免把无关数值当窗口。
    expect(
      await probeModelCatalog({
        baseURL: 'http://127.0.0.1:1/v1',
        provider: 'openai-compatible',
      }),
    ).toEqual({ status: 'ok', detail: 'HTTP 200' });
  });

  it('never adopts a window from a multi-model catalog without an exact match', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () =>
          Promise.resolve(
            JSON.stringify({ data: [{ id: 'a', context_length: 8192 }, { id: 'b' }] }),
          ),
      }),
    );
    expect(
      await probeModelCatalog({
        baseURL: 'http://127.0.0.1:1/v1',
        provider: 'openai-compatible',
        modelName: 'missing',
      }).then((r) => r.contextWindow),
    ).toBeUndefined();
  });

  it('maps auth rejection and non-JSON bodies to fixed outcomes without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: () => Promise.resolve(''),
      }),
    );
    expect(
      await probeModelCatalog({ baseURL: 'http://127.0.0.1:1/v1', provider: 'openai-compatible' }),
    ).toMatchObject({ status: 'auth' });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve('<html>not json</html>'),
      }),
    );
    expect(
      await probeModelCatalog({ baseURL: 'http://127.0.0.1:1/v1', provider: 'openai-compatible' }),
    ).toEqual({ status: 'ok', detail: 'HTTP 200（响应不是 JSON，未解析窗口）' });
  });

  it('reports unreachable when the endpoint rejects the connection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect(
      await probeModelCatalog({ baseURL: 'http://127.0.0.1:1/v1', provider: 'openai-compatible' }),
    ).toMatchObject({ status: 'unreachable' });
  });
});
