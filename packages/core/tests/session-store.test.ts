import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../src/context/session-store.js';

describe('versioned session store', () => {
  let directory: string;
  let file: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-session-'));
    file = path.join(directory, 'session.jsonl');
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
  const open = () =>
    SessionStore.create(file, {
      conversationId: 'test-session',
      projectRoot: directory,
      initialCwd: directory,
    });

  it('rejects a stale second writer before changing the durable body', async () => {
    const first = await open();
    const stale = await SessionStore.open(file);
    await first.append({ role: 'user', content: [{ type: 'text', text: 'owned' }] });
    const before = fs.readFileSync(file);
    await expect(stale.append({ role: 'user', content: [] })).rejects.toThrow(
      /outside this writer/,
    );
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it('persists stable IDs, causal envelopes and a durable reset boundary', async () => {
    const store = await open();
    await store.append({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
    const history = await store.load();
    expect(history[0].id).toBeTruthy();
    const reopened = await SessionStore.open(file);
    expect(await reopened.load()).toEqual(history);
    const records = await reopened.readRecords();
    expect(records[1].parentId).toBe(records[0].recordId);
    await reopened.appendRecord('checkpoint', { id: 'old' });
    await reopened.clear();
    expect(await reopened.load()).toEqual([]);
    expect((await reopened.loadState()).records.map((r) => r.type)).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toContain('hello');
  });

  it('quarantines partial tails and safely appends after complete lines without newline', async () => {
    const store = await open();
    await store.append({ role: 'user', content: [{ type: 'text', text: 'one' }] });
    fs.appendFileSync(file, '{"broken":');
    const recovered = await SessionStore.open(file);
    expect(fs.readdirSync(directory).some((name) => name.includes('.corrupt-'))).toBe(true);
    await recovered.append({ role: 'user', content: [{ type: 'text', text: 'two' }] });
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').trimEnd());
    const final = await SessionStore.open(file);
    await final.append({ role: 'user', content: [{ type: 'text', text: 'three' }] });
    expect((await final.load()).map((m) => m.content[0])).toEqual(
      ['one', 'two', 'three'].map((text) => ({ type: 'text', text })),
    );
  });

  it('rejects middle corruption, duplicate identities and unsupported versions', async () => {
    const store = await open();
    await store.append({ id: 'same', role: 'user', content: [] });
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    fs.writeFileSync(file, `${lines[0]}\nBROKEN\n${lines[1]}\n`);
    await expect(SessionStore.open(file)).rejects.toThrow(/corrupt/i);
    const duplicate = {
      ...JSON.parse(lines[1]),
      recordId: 'different',
      parentId: JSON.parse(lines[1]).recordId,
    };
    fs.writeFileSync(file, `${lines.join('\n')}\n${JSON.stringify(duplicate)}\n`);
    await expect(SessionStore.open(file)).rejects.toThrow(/Duplicate message/);
    const header = { ...JSON.parse(lines[0]), schemaVersion: 99 };
    fs.writeFileSync(file, `${JSON.stringify(header)}\n`);
    await expect(SessionStore.open(file)).rejects.toThrow(/version/i);
  });

  it('persists missing-result repairs once and replays them in the original transaction', async () => {
    const store = await open();
    await store.append({
      id: 'assistant',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call', name: 'write_file', input: {} }],
    });
    await store.append({ role: 'user', content: [{ type: 'text', text: 'next' }] });
    const before = await store.load();
    const after = await (await SessionStore.open(file)).load();
    expect(after).toEqual(before);
    expect(after.map((m) => m.role)).toEqual(['assistant', 'tool', 'user']);
    expect(after[1].content[0]).toMatchObject({ errorCode: 'OUTCOME_UNKNOWN' });
    expect((await store.readRecords()).filter((r) => r.type === 'history_repair')).toHaveLength(1);
  });

  it('serializes competing appends and poisons the writer after a storage failure', async () => {
    const store = await open();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.append({ role: 'user', content: [{ type: 'text', text: String(i) }] }),
      ),
    );
    expect(await store.load()).toHaveLength(10);
    fs.renameSync(directory, `${directory}-moved`);
    try {
      await expect(store.append({ role: 'user', content: [] })).rejects.toThrow();
      fs.mkdirSync(directory);
      await expect(store.append({ role: 'user', content: [] })).rejects.toThrow();
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
      fs.renameSync(`${directory}-moved`, directory);
    }
  });
});
