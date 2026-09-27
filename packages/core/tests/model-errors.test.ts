import { describe, expect, it } from 'vitest';
import { ContextOverflowError, ModelError, describeModelError } from '../src/errors/index.js';

describe('shared model errors', () => {
  it('redacts Basic authorization and cookie headers', () => {
    const info = describeModelError(
      new ModelError(
        'Forbidden\nAuthorization: Basic private-basic\nCookie: session=private-cookie; token=private-token',
      ),
    );
    expect(info.message).toContain('Forbidden');
    expect(info.message).not.toMatch(/private-basic|private-cookie|private-token/);
  });
  it.each([
    [401, 'authentication', 'after_user_action'],
    [402, 'quota', 'after_user_action'],
    [429, 'rate_limit', 'backoff'],
    [503, 'service', 'backoff'],
    [400, 'invalid_request', 'after_user_action'],
  ] as const)('classifies HTTP %s across providers', (status, category, retryPolicy) => {
    const info = describeModelError(new ModelError('server reason', { status }), {
      modelId: 'test',
      operation: 'primary',
    });
    expect(info).toMatchObject({
      status,
      category,
      retryPolicy,
      modelId: 'test',
      message: 'server reason',
    });
    expect(info.suggestion).not.toBe('');
  });
  it('classifies provider error codes even inside HTTP 200 streams', () => {
    expect(
      describeModelError(new ModelError('balance empty', { providerCode: 'insufficient_quota' })),
    ).toMatchObject({ category: 'quota' });
    expect(describeModelError(new ContextOverflowError())).toMatchObject({
      category: 'context',
      retryPolicy: 'after_user_action',
    });
  });
  it('redacts echoed credentials, headers, URL secrets and terminal controls while retaining the reason', () => {
    const info = describeModelError(
      new ModelError(
        'Quota empty\u001b[2J Authorization: Bearer abc123 api_key="private-key" https://user:pass@example.com/?token=secret-value',
        { providerCode: 'bad\ncode' },
      ),
    );
    expect(info.message).toContain('Quota empty');
    expect(JSON.stringify(info)).not.toMatch(/abc123|private-key|secret-value|user:pass|\\u001b/);
    expect(info.providerCode).toBeUndefined();
  });
});
