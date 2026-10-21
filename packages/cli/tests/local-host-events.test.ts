import { describe, expect, it } from 'vitest';
import { SessionEventFeed } from '../src/local-host/events.js';

describe('session event feed', () => {
  it('publishes strictly increasing events and isolates subscriber failures', () => {
    const feed = new SessionEventFeed('instance', 'session', 'stream');
    const observed: number[] = [];
    feed.subscribe((event) => {
      observed.push(event.seq);
    });
    feed.subscribe(() => {
      throw new Error('observer');
    });
    feed.publish({ type: 'text_delta', payload: { text: '你好' }, runId: 'run' });
    const last = feed.publish({ type: 'run_settled', payload: { outcome: 'completed' } });
    expect(observed).toEqual([1, 2]);
    expect(last).toMatchObject({ serverInstanceId: 'instance', sessionId: 'session', seq: 2 });
    expect(feed.highWaterMark).toBe(2);
  });

  it('rejects invalid or oversized projections before advancing the watermark', () => {
    const feed = new SessionEventFeed('instance', 'session', 'stream');
    expect(() =>
      feed.publish({ type: 'text_delta', payload: { text: 'x', extra: 1 } } as never),
    ).toThrow(/Invalid public event/);
    expect(() =>
      feed.publish({ type: 'text_delta', payload: { text: 'x'.repeat(1_048_576) } }),
    ).toThrow(/bounded projection/);
    expect(feed.highWaterMark).toBe(0);
  });
});
