import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionLock } from '../src/context/session-lock.js';
import { SessionManager } from '../src/context/session-manager.js';

describe('stable session error classifications', () => {
  it('classifies live locks, recovery and changed release ownership without parsing messages', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-error-'));
    try {
      const lockPath = path.join(root, 'lock');
      const lock = await SessionLock.acquire(lockPath);
      await expect(SessionLock.acquire(lockPath)).rejects.toMatchObject({ code: 'SESSION_LOCKED' });
      fs.mkdirSync(`${lockPath}.recovery`);
      fs.writeFileSync(
        path.join(`${lockPath}.recovery`, 'owner.json'),
        JSON.stringify({ nonce: 'recovery', pid: process.pid, createdAt: Date.now() }),
      );
      await expect(SessionLock.acquire(lockPath)).rejects.toMatchObject({
        code: 'SESSION_RECOVERY_IN_PROGRESS',
      });
      fs.rmSync(`${lockPath}.recovery`, { recursive: true });
      fs.writeFileSync(
        path.join(lockPath, 'owner.json'),
        JSON.stringify({ nonce: 'changed', pid: process.pid, createdAt: Date.now() }),
      );
      await expect(lock.release()).rejects.toMatchObject({ code: 'SESSION_LOCK_OWNER_CHANGED' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('classifies missing sessions and invalid history pages at their source', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-error-manager-'));
    const manager = new SessionManager({ workspaceRoot: root, homeDirectory: root });
    try {
      await expect(manager.open('absent')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
      await expect(manager.list(0)).rejects.toMatchObject({ code: 'HISTORY_PAGE_INVALID' });
    } finally {
      await manager.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
