import { expect, it, vi } from 'vitest';
import { HistoryListClient } from '../src/renderer/history-list-client.js';
import type { Output } from '../src/shared/contracts.js';

const result = (page: number): Output<'session.list'> => ({
  page,
  pages: 3,
  total: 101,
  items: [],
});
it('自动刷新保留空间当前页，并阻止迟到第一页覆盖用户已选择的后页', async () => {
  const pending: Array<{
    workspaceId: string;
    page: number;
    finish: (value: Output<'session.list'>) => void;
  }> = [];
  const read = vi.fn(
    (workspaceId: string, page: number) =>
      new Promise<Output<'session.list'>>((finish) => pending.push({ workspaceId, page, finish })),
  );
  const installed: Array<{ workspaceId: string; page: number }> = [];
  const client = new HistoryListClient(read, (workspaceId, list) =>
    installed.push({ workspaceId, page: list.page }),
  );
  const old = client.refresh('w', 1);
  const selected = client.refresh('w', 2);
  pending[1].finish(result(2));
  await selected;
  pending[0].finish(result(1));
  await old;
  expect(installed).toEqual([{ workspaceId: 'w', page: 2 }]);
  const refreshed = client.refresh('w');
  expect(pending[2].page).toBe(2);
  const other = client.refresh('other');
  expect(pending[3].page).toBe(1);
  pending[3].finish(result(1));
  await other;
  pending[2].finish(result(2));
  await refreshed;
  expect(installed).toEqual([
    { workspaceId: 'w', page: 2 },
    { workspaceId: 'other', page: 1 },
    { workspaceId: 'w', page: 2 },
  ]);
});
