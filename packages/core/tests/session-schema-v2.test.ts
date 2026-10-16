import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../src/context/session-manager.js';
import {
  MAIN_BRANCH_ID,
  SESSION_SCHEMA_VERSION_V1,
  SESSION_SCHEMA_VERSION_V2,
  type SessionRecord,
  SessionStore,
} from '../src/context/session-store.js';
import { KapibalaError } from '../src/errors/index.js';

describe('session schema v2 and v1 upgrade', () => {
  let directory: string;
  let homeDirectory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-schema-v2-'));
    homeDirectory = path.join(directory, 'home');
    fs.mkdirSync(homeDirectory, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('creates v2 envelope with strictly sequential seq and prevRecordId', async () => {
    const file = path.join(directory, 'v2-session.jsonl');
    const store = await SessionStore.create(file, {
      conversationId: 'test-v2',
      projectRoot: directory,
      initialCwd: directory,
    });

    expect(store.getSchemaVersion()).toBe(SESSION_SCHEMA_VERSION_V2);
    expect(store.isReadOnly()).toBe(false);
    expect(store.getActiveBranchId()).toBe(MAIN_BRANCH_ID);

    await store.append({ role: 'user', content: [{ type: 'text', text: 'hello v2' }] });
    await store.appendRecord('title', { title: '自定义标题' });
    await store.append({ role: 'assistant', content: [{ type: 'text', text: 'response' }] });

    const records = await store.readRecords();
    expect(records).toHaveLength(4);

    // Header record (seq 0)
    expect(records[0]).toMatchObject({
      schemaVersion: SESSION_SCHEMA_VERSION_V2,
      type: 'header',
      seq: 0,
      prevRecordId: null,
      parentId: null,
      branchId: null,
    });

    // Message 1 (seq 1, branchId main)
    expect(records[1]).toMatchObject({
      schemaVersion: SESSION_SCHEMA_VERSION_V2,
      type: 'message',
      seq: 1,
      prevRecordId: records[0].recordId,
      parentId: records[0].recordId,
      branchId: MAIN_BRANCH_ID,
    });

    // Global control record 'title' (seq 2, parentId null, branchId null)
    expect(records[2]).toMatchObject({
      schemaVersion: SESSION_SCHEMA_VERSION_V2,
      type: 'title',
      seq: 2,
      prevRecordId: records[1].recordId,
      parentId: null,
      branchId: null,
    });

    // Message 2 (seq 3, parentId records[1].recordId because title did not advance branch leaf)
    expect(records[3]).toMatchObject({
      schemaVersion: SESSION_SCHEMA_VERSION_V2,
      type: 'message',
      seq: 3,
      prevRecordId: records[2].recordId,
      parentId: records[1].recordId,
      branchId: MAIN_BRANCH_ID,
    });

    const state = await store.loadState();
    expect(state.schemaVersion).toBe(SESSION_SCHEMA_VERSION_V2);
    expect(state.activeBranchId).toBe(MAIN_BRANCH_ID);
    expect(state.activeLeafId).toBe(records[3].recordId);
    expect(state.logRevision).toBe(records[3].recordId);
    expect(state.contentRevision).toBe(records[3].recordId);
  });

  it('rejects corrupt v2 envelopes with invalid seq or prevRecordId', async () => {
    const file = path.join(directory, 'corrupt-seq.jsonl');
    const store = await SessionStore.create(file, {
      conversationId: 'test-corrupt',
      projectRoot: directory,
      initialCwd: directory,
    });
    await store.append({ role: 'user', content: [{ type: 'text', text: 'hi' }] });

    const rawLines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const records = rawLines.map((line) => JSON.parse(line));

    // Corrupt seq on line 2
    records[1].seq = 99;
    fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
    await expect(SessionStore.open(file)).rejects.toThrow(/Session corrupt seq/);

    // Corrupt prevRecordId
    records[1].seq = 1;
    records[1].prevRecordId = 'invalid-prev-id';
    fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
    await expect(SessionStore.open(file)).rejects.toThrow(/Session corrupt prevRecordId/);
  });

  it('treats legacy v1 session as read-only and forbids further mutations', async () => {
    const file = path.join(directory, 'legacy-v1.jsonl');
    const v1Header: SessionRecord = {
      schemaVersion: SESSION_SCHEMA_VERSION_V1,
      type: 'header',
      recordId: 'rec-0',
      timestamp: 1000,
      parentId: null,
      payload: {
        conversationId: 'v1-session',
        projectRoot: directory,
        initialCwd: directory,
      },
    };
    const v1Message: SessionRecord = {
      schemaVersion: SESSION_SCHEMA_VERSION_V1,
      type: 'message',
      recordId: 'rec-1',
      timestamp: 1001,
      parentId: 'rec-0',
      payload: {
        id: 'msg-1',
        role: 'user',
        content: [{ type: 'text', text: 'hello from v1' }],
      },
    };

    fs.writeFileSync(file, `${JSON.stringify(v1Header)}\n${JSON.stringify(v1Message)}\n`);

    const store = await SessionStore.open(file);
    expect(store.getSchemaVersion()).toBe(SESSION_SCHEMA_VERSION_V1);
    expect(store.isReadOnly()).toBe(true);

    const history = await store.load();
    expect(history).toHaveLength(1);
    expect(history[0].content).toEqual([{ type: 'text', text: 'hello from v1' }]);

    // Attempting append must throw LEGACY_SESSION_READ_ONLY
    await expect(
      store.append({ role: 'assistant', content: [{ type: 'text', text: 'cannot write' }] }),
    ).rejects.toThrow(KapibalaError);

    try {
      await store.append({ role: 'user', content: [{ type: 'text', text: 'fail' }] });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as KapibalaError).code).toBe('LEGACY_SESSION_READ_ONLY');
    }

    // Attempting createBranch or selectBranch must also fail
    await expect(store.createBranch('new-branch', 'rec-1')).rejects.toThrow(KapibalaError);
  });

  it('upgrades legacy v1 session to an independent v2 copy idempotently and preserves source', async () => {
    const manager = new SessionManager({
      workspaceRoot: directory,
      homeDirectory,
    });

    const v1ConversationId = 'c1234567890ab';
    const v1FileName = `1000_${v1ConversationId}.jsonl`;
    const v1Path = path.join(manager.directory, v1FileName);

    const v1Header: SessionRecord = {
      schemaVersion: SESSION_SCHEMA_VERSION_V1,
      type: 'header',
      recordId: 'v1-header',
      timestamp: 1000,
      parentId: null,
      payload: {
        conversationId: v1ConversationId,
        projectRoot: manager.project.projectRoot,
        initialCwd: manager.project.cwd,
      },
    };
    const v1Message1: SessionRecord = {
      schemaVersion: SESSION_SCHEMA_VERSION_V1,
      type: 'message',
      recordId: 'v1-msg-1',
      timestamp: 1001,
      parentId: 'v1-header',
      payload: {
        id: 'msg-1',
        role: 'user',
        content: [{ type: 'text', text: 'hello legacy v1' }],
      },
    };
    const v1Title: SessionRecord = {
      schemaVersion: SESSION_SCHEMA_VERSION_V1,
      type: 'title',
      recordId: 'v1-title',
      timestamp: 1002,
      parentId: 'v1-msg-1',
      payload: {
        title: '旧版标题',
      },
    };
    const v1Message2: SessionRecord = {
      schemaVersion: SESSION_SCHEMA_VERSION_V1,
      type: 'message',
      recordId: 'v1-msg-2',
      timestamp: 1003,
      parentId: 'v1-title',
      payload: {
        id: 'msg-2',
        role: 'assistant',
        content: [{ type: 'text', text: 'hello from assistant' }],
      },
    };

    const originalContent = `${[v1Header, v1Message1, v1Title, v1Message2]
      .map((r) => JSON.stringify(r))
      .join('\n')}\n`;
    fs.writeFileSync(v1Path, originalContent);

    // Verify v1 session can be discovered by list
    const initialList = await manager.list();
    expect(initialList.items.some((m) => m.conversationId === v1ConversationId)).toBe(true);

    // Perform upgrade to v2 copy
    const upgraded = await manager.upgradeLegacyV1Session(v1ConversationId);
    expect(upgraded.header.conversationId).not.toBe(v1ConversationId);
    expect(upgraded.header.parentSessionId).toBe(v1ConversationId);
    expect(upgraded.header.upgradeIdentity).toBeTruthy();
    expect(upgraded.store.getSchemaVersion()).toBe(SESSION_SCHEMA_VERSION_V2);
    expect(upgraded.store.isReadOnly()).toBe(false);

    // Verify source v1 file is completely unchanged
    expect(fs.readFileSync(v1Path, 'utf8')).toBe(originalContent);

    // Verify upgraded records satisfy v2 envelope constraints
    const upgradedRecords = await upgraded.store.readRecords();
    expect(upgradedRecords).toHaveLength(4);
    for (let i = 0; i < upgradedRecords.length; i++) {
      expect(upgradedRecords[i].seq).toBe(i);
      expect(upgradedRecords[i].schemaVersion).toBe(SESSION_SCHEMA_VERSION_V2);
    }
    expect(upgradedRecords[0].type).toBe('header');
    expect(upgradedRecords[0].parentId).toBeNull();

    expect(upgradedRecords[1].type).toBe('message');
    expect(upgradedRecords[1].parentId).toBe(upgradedRecords[0].recordId);
    expect(upgradedRecords[1].branchId).toBe(MAIN_BRANCH_ID);

    expect(upgradedRecords[2].type).toBe('title');
    expect(upgradedRecords[2].parentId).toBeNull();
    expect(upgradedRecords[2].branchId).toBeNull();

    expect(upgradedRecords[3].type).toBe('message');
    expect(upgradedRecords[3].parentId).toBe(upgradedRecords[1].recordId);
    expect(upgradedRecords[3].branchId).toBe(MAIN_BRANCH_ID);

    // Test that the upgraded session can write new messages
    await upgraded.store.append({
      role: 'user',
      content: [{ type: 'text', text: 'new prompt in v2' }],
    });
    const fullHistory = await upgraded.store.load();
    expect(fullHistory).toHaveLength(3);
    expect(fullHistory.map((m) => m.content[0])).toEqual([
      { type: 'text', text: 'hello legacy v1' },
      { type: 'text', text: 'hello from assistant' },
      { type: 'text', text: 'new prompt in v2' },
    ]);

    // Test idempotency: upgrading again returns the existing v2 session copy
    const secondUpgrade = await manager.upgradeLegacyV1Session(v1ConversationId);
    expect(secondUpgrade.conversationId).toBe(upgraded.conversationId);

    await upgraded.release();
  });
});
