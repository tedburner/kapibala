import { PresentationStore } from '@kiturone/kapibala-host/internal';
import { describe, expect, it } from 'vitest';

const identity = { conversationId: 'c', branchId: 'main', viewEpoch: 1 };
describe('展示顺序订阅', () => {
  it('不合并事件，隔离观察者异常、修改和重入，拒绝的事件不发布', async () => {
    const store = new PresentationStore(identity);
    const seen: number[] = [];
    const other: number[] = [];
    let notifications = 0;
    store.subscribe(() => {
      notifications++;
    });
    store.subscribeEvents((event) => {
      seen.push(event.sequence);
      if (event.sequence === 1)
        store.dispatch({
          ...identity,
          sequence: 2,
          operationId: 'op',
          change: { type: 'append', messageId: 'm', blockId: 'b', kind: 'text', text: 'hello' },
        });
      (event as { sequence: number }).sequence = 999;
      throw new Error('observer');
    });
    const unsubscribe = store.subscribeEvents((event) => other.push(event.sequence));
    expect(
      store.dispatch({
        ...identity,
        sequence: 1,
        operationId: 'op',
        change: { type: 'operation_started' },
      }),
    ).toBe(true);
    expect(seen).toEqual([1, 2]);
    expect(other).toEqual([1, 2]);
    expect(store.snapshot().sequence).toBe(2);
    store.dispatch({
      ...identity,
      sequence: 1,
      change: { type: 'diagnostic', id: 'old', level: 'error', text: 'stale' },
    });
    expect(seen).toEqual([1, 2]);
    unsubscribe();
    await Promise.resolve();
    expect(notifications).toBeGreaterThan(0);
    store.close();
  });
});
