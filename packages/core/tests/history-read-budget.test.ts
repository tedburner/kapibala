import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readJsonlLines } from '../src/context/jsonl-lines.js';
import { SessionManager } from '../src/context/session-manager.js';
import { SessionStore } from '../src/context/session-store.js';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
const fixture = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-history-limit-'));
  directories.push(root);
  const manager = new SessionManager({ workspaceRoot: root, homeDirectory: root });
  const handle = await manager.create();
  await handle.store.append({ role: 'user', content: [{ type: 'text', text: 'x'.repeat(4096) }] });
  await handle.release();
  return { root, file: handle.store.filePath, id: handle.conversationId };
};

describe('history byte budgets', () => {
  it('rejects oversized partial tails before recovery can change the original file', async () => {
    const { file } = await fixture();
    fs.appendFileSync(file, '{"partial":');
    const before = fs.readFileSync(file);
    await expect(SessionStore.open(file, { maxReadBytes: 1024 })).rejects.toMatchObject({
      code: 'HISTORY_READ_LIMIT',
    });
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(path.dirname(file)).some((name) => name.includes('.corrupt-'))).toBe(
      false,
    );
  });

  it('counts bytes read after opening, including growth beyond the initial stat', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-growing-limit-'));
    directories.push(root);
    const file = path.join(root, 'growing.jsonl');
    fs.writeFileSync(file, 'ok\n');
    const lines = readJsonlLines(file, { maxReadBytes: 8 });
    expect(lines.next().value?.text).toBe('ok');
    fs.appendFileSync(file, 'too much content\n');
    expect(() => lines.next()).toThrow(expect.objectContaining({ code: 'HISTORY_READ_LIMIT' }));
  });

  it('lists an oversized session with its identity and refuses open without discarding other histories', async () => {
    const { root, file, id } = await fixture();
    const sessions = new SessionManager({
      workspaceRoot: root,
      homeDirectory: root,
      maxReadBytes: 1024,
    });
    const fresh = await sessions.create();
    await fresh.release();
    for (const name of fs.readdirSync(sessions.directory))
      if (name.endsWith('.meta.json')) fs.unlinkSync(path.join(sessions.directory, name));
    const before = fs.readFileSync(file);
    const listed = await sessions.list();
    expect(listed.items.find((item) => item.conversationId === id)).toMatchObject({
      unavailableReason: 'HISTORY_READ_LIMIT',
    });
    expect(listed.items.some((item) => item.conversationId === fresh.conversationId)).toBe(true);
    await expect(sessions.open(id)).rejects.toMatchObject({ code: 'HISTORY_READ_LIMIT' });
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it('超限重载保留分支与父链，后续工具事务仍可完整落盘', async () => {
    const { file } = await fixture();
    const setup = await SessionStore.open(file);
    await setup.createBranch('work', setup.getBranchLeaves().get('main')!);
    await setup.selectBranch('work');
    await setup.append({ role: 'user', content: [{ type: 'text', text: 'branch' }] });
    const limit = fs.statSync(file).size;
    const store = await SessionStore.open(file, { maxReadBytes: limit });
    await store.append({ role: 'user', content: [{ type: 'text', text: 'more' }] });
    const leaves = new Map(store.getBranchLeaves());
    await expect(store.readRecords()).rejects.toMatchObject({ code: 'HISTORY_READ_LIMIT' });
    expect(store.getActiveBranchId()).toBe('work');
    expect(store.getBranchLeaves()).toEqual(leaves);
    await store.append({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call', name: 'read_file', input: {} }],
    });
    await store.append({
      role: 'tool',
      content: [{ type: 'tool_result', toolUseId: 'call', content: 'real-result' }],
    });
    const reopened = await SessionStore.open(file);
    const messages = await reopened.load();
    expect(messages.map((message) => message.content[0].type)).toEqual([
      'text',
      'text',
      'text',
      'tool_use',
      'tool_result',
    ]);
    expect(reopened.getActiveBranchId()).toBe('work');
    expect(messages.at(-1)?.content[0]).toMatchObject({ content: 'real-result' });
  });

  it('列表扫描期间增长超限仍保留身份，继续最近历史不得新建空会话', async () => {
    const { root, file, id } = await fixture();
    const original = fs.readFileSync(file);
    const sessions = new SessionManager({
      workspaceRoot: root,
      homeDirectory: root,
      maxReadBytes: original.length + 64,
    });
    for (const name of fs.readdirSync(sessions.directory))
      if (name.endsWith('.meta.json')) fs.unlinkSync(path.join(sessions.directory, name));
    const stat = fs.statSync;
    let grown = false;
    vi.spyOn(fs, 'statSync').mockImplementation((...args) => {
      const result = Reflect.apply(stat, fs, args);
      if (String(args[0]) === file && !grown) {
        grown = true;
        fs.appendFileSync(file, 'x'.repeat(4096));
      }
      return result;
    });
    const listed = await sessions.list();
    expect(listed.items.find((item) => item.conversationId === id)).toMatchObject({
      unavailableReason: 'HISTORY_READ_LIMIT',
    });
    fs.writeFileSync(file, original);
    grown = false;
    await expect(sessions.continueRecent()).rejects.toMatchObject({ code: 'HISTORY_READ_LIMIT' });
    expect(
      fs.readdirSync(sessions.directory).filter((name) => name.endsWith('.jsonl')),
    ).toHaveLength(1);
  });

  it('legacy 导入和 v1 自动升级在超限时保留源文件，不安装半份历史', async () => {
    const { root, file, id } = await fixture();
    const sessions = new SessionManager({
      workspaceRoot: root,
      homeDirectory: root,
      maxReadBytes: 1024,
    });
    const legacy = path.join(root, '.kapibala/history.jsonl');
    fs.writeFileSync(
      legacy,
      `${JSON.stringify({ ts: 1, role: 'user', content: [{ type: 'text', text: 'x'.repeat(4096) }] })}\n`,
    );
    const legacyBefore = fs.readFileSync(legacy);
    await expect(sessions.importLegacy()).rejects.toMatchObject({ code: 'HISTORY_READ_LIMIT' });
    expect(fs.readFileSync(legacy)).toEqual(legacyBefore);
    const v1 = fs.readFileSync(file, 'utf8').replaceAll('"schemaVersion":2', '"schemaVersion":1');
    fs.writeFileSync(file, v1);
    await expect(sessions.open(id, { autoUpgradeLegacy: true })).rejects.toMatchObject({
      code: 'HISTORY_READ_LIMIT',
    });
    await expect(sessions.upgradeLegacyV1Session(id)).rejects.toMatchObject({
      code: 'HISTORY_READ_LIMIT',
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(v1);
    expect(
      fs.readdirSync(sessions.directory).filter((name) => name.endsWith('.jsonl')),
    ).toHaveLength(1);
  });
});
