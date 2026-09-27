import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionLock } from '../src/context/session-lock.js';
import { SessionManager, resolveSessionProject } from '../src/context/session-manager.js';
import { SessionStore } from '../src/context/session-store.js';

describe('independent sessions', () => {
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-manager-'));
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manager = () =>
    new SessionManager({ cwd: directory, homeDirectory: path.join(directory, 'home') });

  it('rejects ambiguous prefixes and foreign project IDs without changing either session', async () => {
    const sessions = manager();
    const a = await sessions.create();
    const b = await sessions.create();
    expect(a.conversationId.slice(0, 8)).toBe(b.conversationId.slice(0, 8));
    await expect(sessions.open(a.conversationId.slice(0, 8))).rejects.toThrow(/ambiguous/i);
    const foreignDirectory = path.join(directory, 'foreign');
    fs.mkdirSync(foreignDirectory);
    const foreign = new SessionManager({
      cwd: foreignDirectory,
      homeDirectory: path.join(directory, 'home'),
    });
    await expect(foreign.open(a.conversationId)).rejects.toThrow(/not found/i);
    const copied = path.join(foreign.directory, path.basename(a.store.filePath));
    fs.copyFileSync(a.store.filePath, copied);
    fs.appendFileSync(copied, '{"partial":');
    const foreignBody = fs.readFileSync(copied);
    await expect(foreign.open(a.conversationId)).rejects.toThrow(/foreign/i);
    expect(fs.readFileSync(copied)).toEqual(foreignBody);
    expect((await foreign.list()).total).toBe(0);
    expect((await sessions.list()).total).toBe(2);
    await foreign.close();
    await sessions.close();
  });

  it('groups actual repository subdirectories and resolves symbolic paths without changing cwd', () => {
    const cwd = process.cwd();
    expect(resolveSessionProject(path.resolve('packages/core')).projectKey).toBe(
      resolveSessionProject(cwd).projectKey,
    );
    const target = path.join(directory, 'target');
    const alias = path.join(directory, 'alias');
    fs.mkdirSync(target);
    fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(resolveSessionProject(alias).projectKey).toBe(resolveSessionProject(target).projectKey);
    expect(process.cwd()).toBe(cwd);
  });

  it('creates isolated sessions and continues only the most recent content', async () => {
    const sessions = manager();
    const a = await sessions.create();
    await a.store.append({ role: 'user', content: [{ type: 'text', text: 'first task' }] });
    const b = await sessions.create();
    expect(a.conversationId).not.toBe(b.conversationId);
    expect(await b.store.load()).toEqual([]);
    expect((await sessions.continueRecent()).conversationId).toBe(a.conversationId);
    expect(await sessions.open(a.conversationId.slice(0, 12))).toBe(a);
    await sessions.rename(a.conversationId, 'custom\u001b[31m title');
    const list = await sessions.list();
    const renamed = list.items.find((item) => item.conversationId === a.conversationId)!;
    expect(renamed.title).toBe('custom\\u001b[31m title');
    expect(renamed.messageCount).toBe(1);
    const at = renamed.lastActivityAt;
    expect(
      (await sessions.list()).items.find((item) => item.conversationId === a.conversationId)!
        .lastActivityAt,
    ).toBe(at);
    await sessions.close();
    const restored = manager();
    expect((await restored.open(a.conversationId)).conversationId).toBe(a.conversationId);
    expect(
      (await restored.list()).items.find((item) => item.conversationId === a.conversationId)!.title,
    ).toBe('custom\\u001b[31m title');
    await restored.close();
  });

  it('rejects missing IDs and contention without creating an empty replacement', async () => {
    const first = manager();
    const a = await first.create();
    const other = manager();
    await expect(other.open(a.conversationId)).rejects.toThrow(/locked/i);
    await expect(other.open('missing')).rejects.toThrow(/not found/i);
    expect((await other.list()).total).toBe(1);
    await first.close();
    await other.open(a.conversationId);
    await other.close();
  });

  it('lists valid metadata without reading JSONL bodies and rebuilds damaged metadata', async () => {
    const sessions = manager();
    const handle = await sessions.create();
    await handle.store.append({ role: 'user', content: [{ type: 'text', text: 'title' }] });
    const original = fs.readFileSync;
    const originalOpen = fs.openSync;
    const { vi } = await import('vitest');
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation(((file, ...args) => {
      if (String(file).endsWith('.jsonl')) throw new Error('streaming body read');
      return originalOpen(file, ...args);
    }) as typeof fs.openSync);
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file, options) => {
      if (String(file).endsWith('.jsonl')) throw new Error('body read');
      return original(file, options as never);
    }) as typeof fs.readFileSync);
    try {
      expect((await sessions.list()).items[0].title).toBe('title');
    } finally {
      spy.mockRestore();
      openSpy.mockRestore();
    }
    fs.writeFileSync(handle.metadataPath, 'broken');
    expect((await sessions.list()).items[0].title).toBe('title');
    await sessions.close();
  });

  it('paginates a large valid cache without opening session bodies', async () => {
    const sessions = manager();
    for (let i = 0; i < 25; i++) {
      const handle = await sessions.create();
      await handle.store.append({ role: 'user', content: [{ type: 'text', text: `task-${i}` }] });
    }
    const { vi } = await import('vitest');
    const original = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((file, ...args) => {
      if (String(file).endsWith('.jsonl')) throw new Error('unexpected body read');
      return original(file, ...args);
    }) as typeof fs.openSync);
    try {
      const first = await sessions.list(1);
      const second = await sessions.list(2);
      expect(first).toMatchObject({ total: 25, pages: 2 });
      expect(first.items).toHaveLength(20);
      expect(second.items).toHaveLength(5);
      expect(new Set([...first.items, ...second.items].map((m) => m.conversationId)).size).toBe(25);
      expect((await sessions.list(3)).items).toEqual([]);
    } finally {
      spy.mockRestore();
      await sessions.close();
    }
  });

  it('imports legacy snapshots once and keeps their source untouched', async () => {
    const source = path.join(directory, '.kapibala', 'history.jsonl');
    fs.mkdirSync(path.dirname(source));
    const content = `${JSON.stringify({ ts: 1, role: 'user', content: [{ type: 'text', text: 'legacy' }] })}\n`;
    fs.writeFileSync(source, content);
    const sessions = manager();
    expect(await sessions.importLegacy()).toHaveLength(1);
    expect(await sessions.importLegacy()).toHaveLength(0);
    expect(fs.readFileSync(source, 'utf8')).toBe(content);
    expect((await sessions.list()).total).toBe(1);
    await sessions.close();
  });

  it('postpones changed legacy input instead of installing a stale snapshot', async () => {
    const source = path.join(directory, '.kapibala', 'history.jsonl');
    fs.mkdirSync(path.dirname(source));
    const line = `${JSON.stringify({ ts: 1, role: 'user', content: [{ type: 'text', text: 'first' }] })}\n`;
    fs.writeFileSync(source, line);
    const { vi } = await import('vitest');
    const original = SessionStore.prototype.append;
    const spy = vi.spyOn(SessionStore.prototype, 'append').mockImplementationOnce(function (
      this: SessionStore,
      message,
    ) {
      fs.appendFileSync(source, line.replace('first', 'new input'));
      return original.call(this, message);
    });
    const sessions = manager();
    try {
      expect(await sessions.importLegacy()).toEqual([]);
      expect((await sessions.list()).total).toBe(0);
      expect(fs.readdirSync(sessions.directory)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect(await sessions.importLegacy()).toHaveLength(1);
    const handle = await sessions.continueRecent();
    expect(await handle.store.load()).toHaveLength(2);
    expect(fs.readFileSync(source, 'utf8')).toContain('new input');
    await sessions.close();
  });

  it('recovers a failed install and deduplicates an installed import despite missing sidecars', async () => {
    const source = path.join(directory, '.kapibala', 'history.jsonl');
    fs.mkdirSync(path.dirname(source));
    const content = `${JSON.stringify({ ts: 1, role: 'user', content: [{ type: 'text', text: 'legacy' }] })}\n`;
    fs.writeFileSync(source, content);
    const { vi } = await import('vitest');
    const sessions = manager();
    const failedInstall = vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
      throw new Error('install interrupted');
    });
    try {
      expect(await sessions.importLegacy()).toEqual([]);
      expect(fs.readdirSync(sessions.directory)).toEqual([]);
    } finally {
      failedInstall.mockRestore();
    }
    const rename = fs.renameSync;
    const failedCache = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('.meta.json')) throw new Error('cache interrupted');
      return rename(from, to);
    });
    try {
      expect(await sessions.importLegacy()).toHaveLength(1);
      expect(await sessions.importLegacy()).toHaveLength(0);
      expect(fs.readdirSync(sessions.directory).filter((f) => f.endsWith('.jsonl'))).toHaveLength(
        1,
      );
    } finally {
      failedCache.mockRestore();
    }
    expect((await sessions.list()).total).toBe(1);
    expect(fs.readFileSync(source, 'utf8')).toBe(content);
    await sessions.close();
  });
});

describe('single writer ownership', () => {
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-lock-'));
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('does not reclaim a live or unknown owner regardless of age', async () => {
    const lockPath = path.join(directory, 'session.lock');
    const first = await SessionLock.acquire(lockPath);
    await expect(SessionLock.acquire(lockPath)).rejects.toThrow(/locked/i);
    const ownerPath = path.join(lockPath, 'owner.json');
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    fs.writeFileSync(ownerPath, JSON.stringify({ ...owner, createdAt: 0 }));
    await expect(SessionLock.acquire(lockPath)).rejects.toThrow(/locked/i);
    await first.release();
    fs.mkdirSync(lockPath);
    fs.writeFileSync(ownerPath, '{}');
    await expect(SessionLock.acquire(lockPath)).rejects.toThrow(/locked/i);
  });

  it('never releases a different owner', async () => {
    const lockPath = path.join(directory, 'session.lock');
    const lock = await SessionLock.acquire(lockPath);
    const ownerPath = path.join(lockPath, 'owner.json');
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    fs.writeFileSync(ownerPath, JSON.stringify({ ...owner, nonce: 'replacement' }));
    await expect(lock.release()).rejects.toThrow(/owner/i);
    expect(fs.existsSync(lockPath)).toBe(true);
  });
});
