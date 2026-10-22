import type { LocalClient } from '../src/client/index.js';

async function checkResults(client: LocalClient, cursor?: string) {
  const full = await client.call('session/snapshot', { sessionId: 's' });
  full.history;
  const page = await client.call('session/snapshot', { sessionId: 's', cursor: 'revision:1' });
  page.chunk;
  // @ts-expect-error 显式 cursor 返回续块，不包含正文。
  page.history;
  const unknown = await client.call('session/snapshot', { sessionId: 's', cursor });
  // @ts-expect-error 可选 cursor 的变量必须先收窄结果。
  unknown.history;
}
void checkResults;
