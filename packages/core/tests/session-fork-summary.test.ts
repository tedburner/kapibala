import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../src/context/session-manager.js';
import { MAIN_BRANCH_ID, SessionStore } from '../src/context/session-store.js';
import type { KapibalaError } from '../src/errors/index.js';

describe('session fork and branch summary', () => {
  let directory: string;
  let homeDirectory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-fork-'));
    homeDirectory = path.join(directory, 'home');
    fs.mkdirSync(homeDirectory, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('forks active branch to an independent session file with parent linkage and isolated usage', async () => {
    const manager = new SessionManager({
      workspaceRoot: directory,
      homeDirectory,
    });

    const sourceSession = await manager.create();
    const sourceId = sourceSession.conversationId;

    await sourceSession.store.append({
      role: 'user',
      content: [{ type: 'text', text: 'Source Q1' }],
    });
    await sourceSession.store.append({
      role: 'assistant',
      content: [{ type: 'text', text: 'Source A1' }],
    });
    await sourceSession.store.appendRecord('usage', { inputTokens: 100, outputTokens: 50 });
    await sourceSession.store.append({
      role: 'user',
      content: [{ type: 'text', text: 'Source Q2' }],
    });

    await sourceSession.release();

    // Fork session from the latest leaf
    const forked = await manager.forkSession({
      sourceSessionId: sourceId,
    });

    expect(forked.conversationId).not.toBe(sourceId);
    expect(forked.header.parentSessionId).toBe(sourceId);
    expect(forked.header.forkPointRecordId).toBeTruthy();

    // Verify records in forked session
    const forkedRecords = await forked.store.readRecords();
    for (let i = 0; i < forkedRecords.length; i++) {
      expect(forkedRecords[i].seq).toBe(i);
      expect(forkedRecords[i].schemaVersion).toBe(2);
    }

    const forkedUsage = forkedRecords.find((r) => r.type === 'usage');
    expect(forkedUsage?.payload.importedFromFork).toBe(true);

    const forkedHistory = await forked.store.load();
    expect(forkedHistory.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'Source Q1',
      'Source A1',
      'Source Q2',
    ]);

    // Append to forked session
    await forked.store.append({ role: 'user', content: [{ type: 'text', text: 'Forked Q3' }] });
    expect(await forked.store.load()).toHaveLength(4);

    await forked.release();

    // Verify source session is completely unaffected
    const reopenedSource = await manager.open(sourceId);
    expect(await reopenedSource.store.load()).toHaveLength(3);
    await reopenedSource.release();
  });

  it('rejects forkSession when fork point is inside an unclosed tool transaction', async () => {
    const manager = new SessionManager({
      workspaceRoot: directory,
      homeDirectory,
    });

    const source = await manager.create();
    await source.store.append({ role: 'user', content: [{ type: 'text', text: 'run tool' }] });
    await source.store.append({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_x', name: 'fetch', input: {} }],
    });
    const unclosedId = (await source.store.readRecords())[2].recordId;
    await source.release();

    try {
      await manager.forkSession({
        sourceSessionId: source.conversationId,
        forkPointRecordId: unclosedId,
      });
      expect.fail('should have rejected fork from unclosed tool transaction');
    } catch (err) {
      expect((err as KapibalaError).code).toBe('UNCLOSED_TOOL_TRANSACTION_FORK');
    }
  });

  it('rejects fork from global control records like title and usage (N3)', async () => {
    const manager = new SessionManager({
      workspaceRoot: directory,
      homeDirectory,
    });

    const source = await manager.create();
    await source.store.append({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
    await source.store.appendRecord('title', { title: 'My Title' });
    await source.store.appendRecord('usage', { inputTokens: 10, outputTokens: 20 });
    const records = await source.store.readRecords();
    const titleRecord = records.find((r) => r.type === 'title')!;
    const usageRecord = records.find((r) => r.type === 'usage')!;
    await source.release();

    await expect(
      manager.forkSession({
        sourceSessionId: source.conversationId,
        forkPointRecordId: titleRecord.recordId,
      }),
    ).rejects.toThrow(/Cannot fork or branch from a global control record/);

    await expect(
      manager.forkSession({
        sourceSessionId: source.conversationId,
        forkPointRecordId: usageRecord.recordId,
      }),
    ).rejects.toThrow(/Cannot fork or branch from a global control record/);
  });

  it('strips upgradeIdentity when forking to prevent hijacking v1 upgrades (N1)', async () => {
    const manager = new SessionManager({
      workspaceRoot: directory,
      homeDirectory,
    });

    const source = await manager.create();
    // Simulate source being an upgraded v1 session by putting an upgradeIdentity on its header
    const sourceRecords = await source.store.readRecords();
    const header = sourceRecords[0];
    (header.payload as Record<string, unknown>).upgradeIdentity = 'source-legacy-id';
    await source.store.append({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
    await source.release();

    const forked = await manager.forkSession({
      sourceSessionId: source.conversationId,
    });

    expect(forked.header.upgradeIdentity).toBeUndefined();
    await forked.release();
  });

  it('allows branching on sessions recovered with history_repair records (N2)', async () => {
    const manager = new SessionManager({
      workspaceRoot: directory,
      homeDirectory,
    });

    const source = await manager.create();
    await source.store.append({ role: 'user', content: [{ type: 'text', text: 'call tool' }] });
    await source.store.append({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'hanging_call_1', name: 'search', input: {} }],
    });
    // Simulate crash recovery repair record
    await source.store.appendRecord('history_repair', {
      repairedAt: Date.now(),
      toolCallId: 'hanging_call_1',
      action: 'close_interrupted',
    });
    await source.store.append({
      role: 'user',
      content: [{ type: 'text', text: 'after recovery' }],
    });

    // Branching from the leaf should now succeed because history_repair resolved the pending call
    const lastRecord = (await source.store.readRecords()).at(-1)!;
    const featBranch = await source.store.createBranch('feat-repaired', lastRecord.recordId);
    expect(featBranch.type).toBe('branch_created');
    await source.release();
  });
});
