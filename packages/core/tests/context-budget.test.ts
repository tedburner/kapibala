import { describe, expect, it } from 'vitest';
import {
  UnicodeTokenEstimator,
  createContextBudget,
  requestFingerprint,
} from '../src/context/budget.js';

describe('context budget', () => {
  it('uses conservative unknown windows and exact output/safety reserves', () => {
    expect(createContextBudget()).toMatchObject({
      contextWindow: 32000,
      estimatedWindow: true,
      outputReserve: 4000,
      safetyReserve: 1600,
      inputBudget: 26400,
    });
    expect(createContextBudget('128K')).toMatchObject({
      contextWindow: 128000,
      estimatedWindow: false,
      outputReserve: 4096,
      safetyReserve: 6400,
      inputBudget: 117504,
    });
    const b = createContextBudget(1024);
    expect(b.target).toBeLessThan(b.trigger);
    expect(b.trigger).toBeLessThan(b.inputBudget);
    for (const value of [1, -1, Number.NaN, 1.5])
      expect(() => createContextBudget(value)).toThrow();
  });

  it('counts Unicode, schema and protocol overhead without splitting surrogate pairs', () => {
    const estimator = new UnicodeTokenEstimator();
    const request = {
      systemPrompt: 'rules',
      messages: [
        { role: 'user' as const, content: [{ type: 'text' as const, text: '中文😀const x = 1;' }] },
      ],
      tools: [
        {
          name: 'read',
          description: 'read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    };
    const estimate = estimator.estimate(request);
    expect(estimate.total).toBeGreaterThan(estimate.history);
    expect(estimate.tools).toBeGreaterThan(0);
    expect(estimator.estimate({ messages: [] }).total).toBeGreaterThan(0);
    expect(requestFingerprint(request)).toBe(requestFingerprint(structuredClone(request)));
    expect(requestFingerprint({ ...request, maxTokens: 100 })).not.toBe(
      requestFingerprint(request),
    );
  });

  it('invalidates measured calibration when instructions, model or tools change', () => {
    const estimator = new UnicodeTokenEstimator();
    const request = { systemPrompt: 'a', messages: [] };
    const before = estimator.estimate(request, 'model-a').total;
    estimator.observe(request, before * 2, 'model-a');
    expect(estimator.estimate(request, 'model-a').total).toBe(before * 2);
    expect(estimator.estimate(request, 'model-b').total).toBe(before);
    expect(estimator.estimate({ ...request, systemPrompt: 'b' }, 'model-a').source).toBe(
      'estimated',
    );
  });
});
