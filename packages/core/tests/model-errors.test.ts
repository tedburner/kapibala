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

  it.each([
    ['insufficient_quota', { status: 429, providerCode: 'insufficient_quota' }, 'Rate limited'],
    [
      'credit_balance_exhausted',
      { status: 429, providerType: 'credit_balance_exhausted' },
      'No credits',
    ],
    ['billing_error', { status: 429, providerCode: 'billing_error' }, 'Billing issue'],
    ['usage_limit_reached', { status: 429, providerCode: 'usage_limit_reached' }, 'Limit'],
    ['usage_not_included', { status: 429, providerCode: 'usage_not_included' }, 'Plan limit'],
    ['exceeded_current_quota', { status: 429, code: 'exceeded_current_quota' }, 'Exceeded'],
    ['out of budget message', { status: 429 }, 'Account is Out Of Budget for this month'],
    ['quota exceeded message', { status: 429 }, 'Monthly Quota Exceeded; upgrade plan'],
    ['Zhipu 1304', { status: 429, providerCode: '1304' }, 'Daily call limit'],
    ['Zhipu 1308', { status: 429, providerCode: '1308' }, 'Package exhausted'],
  ] as const)('classifies %s as non-retryable quota before generic 429', (_label, opts, msg) => {
    const err = new ModelError(msg, opts);
    expect(err.category).toBe('quota');
    expect(err.retryable).toBe(false);
    expect(err.retryPolicy).toBe('after_user_action');
  });

  it('keeps token_quota_exceeded retryable as rate_limit and retains retryAfterMs', () => {
    const err = new ModelError('TPM token_quota_exceeded', {
      status: 429,
      providerCode: 'token_quota_exceeded',
      retryAfterMs: 2500.2,
    });
    expect(err.category).toBe('rate_limit');
    expect(err.retryable).toBe(true);
    expect(err.retryPolicy).toBe('backoff');
    expect(err.retryAfterMs).toBe(2501);
  });
});
