import { describe, expect, it } from 'vitest';
import { SnapshotPager } from '../src/local-host/snapshots.js';

describe('bounded consistent snapshots', () => {
  it('chunks a large logical snapshot and validates session/revision cursors', () => {
    const pager = new SnapshotPager();
    const data = { history: [{ text: '你好'.repeat(200000) }], live: [] };
    const first = pager.capture('s', data);
    let encoded = first.chunk;
    let cursor = first.cursor;
    while (cursor) {
      const page = pager.read('s', cursor);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1048576);
      encoded += page.chunk;
      cursor = page.cursor;
    }
    expect(JSON.parse(encoded)).toEqual(data);
    expect(() => pager.read('other', first.cursor!)).toThrow(/RESYNC_REQUIRED/);
    pager.capture('s', { history: [], live: [] });
    expect(() => pager.read('s', first.cursor!)).toThrow(/RESYNC_REQUIRED/);
  });
  it('refuses snapshots beyond the connection memory budget', () => {
    expect(() => new SnapshotPager().capture('s', { text: 'x'.repeat(8388609) })).toThrow(
      /RESOURCE_LIMIT/,
    );
  });
});
