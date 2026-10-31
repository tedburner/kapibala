import { expect, it } from 'vitest';
import { LatestSnapshot } from '../src/agent-host/latest-snapshot.js';

it('只保留一份待发最新摘要，初始读取后允许 revision 跳号，退订阻止迟到发送', async () => {
  const sent: Array<{ subscriptionId: string; value: number }> = [];
  const acknowledgements: Array<() => void> = [];
  const stream = new LatestSnapshot<number>(
    async (subscriptionId, value) => {
      sent.push({ subscriptionId, value });
      await new Promise<void>((resolve) => acknowledgements.push(resolve));
    },
    () => {},
  );
  stream.subscribe('a');
  stream.push(1);
  stream.push(2);
  stream.push(3);
  expect(sent).toEqual([{ subscriptionId: 'a', value: 1 }]);
  acknowledgements.shift()!();
  await Promise.resolve();
  await Promise.resolve();
  expect(sent).toEqual([
    { subscriptionId: 'a', value: 1 },
    { subscriptionId: 'a', value: 3 },
  ]);
  stream.unsubscribe('a');
  stream.subscribe('b');
  stream.push(4);
  acknowledgements.shift()!();
  await Promise.resolve();
  await Promise.resolve();
  expect(sent.at(-1)).toEqual({ subscriptionId: 'b', value: 4 });
  stream.close();
  acknowledgements.shift()!();
});
it('数据拥塞使摘要失效，不用无界重试或独立停止队列发送正文', async () => {
  let invalid = '';
  const stream = new LatestSnapshot<number>(
    async () => {
      throw new Error('OUTPUT_CONGESTED');
    },
    (id) => {
      invalid = id;
    },
  );
  stream.subscribe('a');
  stream.push(1);
  await Promise.resolve();
  await Promise.resolve();
  stream.push(2);
  expect(invalid).toBe('a');
});
