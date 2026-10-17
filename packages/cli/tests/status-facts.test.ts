import { describe, expect, it, vi } from 'vitest';
import { GitStatusCache, projectStatusFacts } from '../src/host/status-facts.js';

describe('host status facts', () => {
  it('projects explicit usage facts without retaining Core objects or private model data', () => {
    const contextUsage = { usedTokens: 200, limitTokens: 4000, estimatedLimit: false };
    const input = {
      phase: 'running' as const,
      model: '\x1b[31mModel\x1b[0m',
      permissionMode: 'Approval',
      contextUsage,
      runUsage: { promptTokens: 1000, completionTokens: 200, totalTokens: 1200, secret: 'PRIVATE' },
    };
    const facts = projectStatusFacts(input);
    expect(facts.model).toBe('Model');
    expect(facts.contextUsage?.usedTokens).toBe(200);
    expect(facts.runUsage?.totalTokens).toBe(1200);
    expect(JSON.stringify(facts)).not.toContain('PRIVATE');
    contextUsage.usedTokens = 999;
    expect(facts.contextUsage?.usedTokens).toBe(200);
  });

  it('reads immediately while Git is slow, coalesces refreshes and caches successful results', async () => {
    let finish: (branch: string) => void = () => {};
    let now = 0;
    const loader = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const changed = vi.fn();
    const cache = new GitStatusCache(loader, { onChange: changed, ttlMs: 100, now: () => now });
    const refresh = cache.refresh();
    expect(cache.peek()).toBeUndefined();
    const duplicate = cache.refresh();
    await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(1);
    finish('feature');
    await Promise.all([refresh, duplicate]);
    expect(cache.peek()).toBe('feature');
    await cache.refresh();
    expect(loader).toHaveBeenCalledTimes(1);
    now = 101;
    const next = cache.refresh();
    expect(cache.peek()).toBe('feature');
    await Promise.resolve();
    finish('main');
    await next;
    expect(cache.peek()).toBe('main');
    expect(changed).toHaveBeenCalledTimes(2);
    cache.close();
  });

  it('omits failed Git, retains cached facts on later failure and ignores stale results after close', async () => {
    const loader = vi
      .fn<() => Promise<string | undefined>>()
      .mockRejectedValueOnce(new Error('No repository'))
      .mockResolvedValueOnce('main')
      .mockRejectedValueOnce(new Error('Process failed'));
    const cache = new GitStatusCache(loader, { ttlMs: 0 });
    await cache.refresh();
    expect(cache.peek()).toBeUndefined();
    await cache.refresh();
    await cache.refresh();
    expect(cache.peek()).toBe('main');
    cache.close();
    let finish: (branch: string) => void = () => {};
    const changed = vi.fn();
    const stale = new GitStatusCache(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      { onChange: changed },
    );
    const refreshing = stale.refresh();
    await Promise.resolve();
    stale.close();
    finish('stale');
    await refreshing;
    expect(stale.peek()).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
  });
});
