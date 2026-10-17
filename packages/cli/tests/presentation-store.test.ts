import { describe, expect, it } from 'vitest';
import { PresentationStore } from '../src/host/presentation-store.js';
import type { PresentationEvent, ViewIdentity } from '../src/view-model/index.js';

const identity: ViewIdentity = { conversationId: 'c', branchId: 'main', viewEpoch: 1 };
const event = (sequence: number, change: PresentationEvent['change']): PresentationEvent => ({
  ...identity,
  sequence,
  operationId: 'op',
  change,
});

describe('ordered host presentation publication', () => {
  it('applies every delta immediately while coalescing subscriptions without an interval timer', async () => {
    const store = new PresentationStore(identity);
    store.dispatch(event(1, { type: 'operation_started' }));
    let notifications = 0;
    store.subscribe(() => {
      notifications++;
    });
    for (let sequence = 2; sequence < 102; sequence++)
      store.dispatch(
        event(sequence, {
          type: 'append',
          messageId: 'pending',
          blockId: 'text',
          kind: 'text',
          text: 'x',
        }),
      );
    expect(store.snapshot().pendingMessages[0].blocks[0].text).toHaveLength(100);
    expect(notifications).toBe(0);
    await Promise.resolve();
    expect(notifications).toBe(1);
    store.close();
  });

  it('publishes the complete boundary state before a pending delta callback can run', async () => {
    const store = new PresentationStore(identity);
    store.dispatch(event(1, { type: 'operation_started' }));
    const phases: string[] = [];
    store.subscribe(() => {
      phases.push(store.snapshot().operation!.phase);
    });
    store.dispatch(
      event(2, {
        type: 'append',
        messageId: 'pending',
        blockId: 'text',
        kind: 'text',
        text: 'last',
      }),
    );
    store.dispatch(event(3, { type: 'operation_result', result: 'completed' }));
    expect(phases).toEqual(['settling']);
    await Promise.resolve();
    expect(phases).toEqual(['settling']);
    store.close();
  });

  it('cancels old-view publication and isolates failed or unsubscribed observers', async () => {
    const store = new PresentationStore(identity);
    store.dispatch(event(1, { type: 'operation_started' }));
    let live = 0;
    store.subscribe(() => {
      throw new Error('observer failed');
    });
    const unsubscribe = store.subscribe(() => {
      live++;
    });
    store.dispatch(
      event(2, { type: 'append', messageId: 'pending', blockId: 't', kind: 'text', text: 'old' }),
    );
    store.reload({ ...identity, viewEpoch: 2 }, []);
    expect(live).toBe(1);
    await Promise.resolve();
    expect(live).toBe(1);
    expect(store.snapshot().messages).toEqual([]);
    expect(store.dispatch(event(3, { type: 'operation_settled' }))).toBe(false);
    unsubscribe();
    store.close();
    expect(
      store.dispatch({
        ...identity,
        viewEpoch: 2,
        sequence: 10,
        change: { type: 'diagnostic', id: 'late', level: 'info', text: 'late' },
      }),
    ).toBe(false);
  });
});
