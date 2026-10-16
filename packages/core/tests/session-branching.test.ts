import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAIN_BRANCH_ID, SessionStore } from '../src/context/session-store.js';
import { KapibalaError } from '../src/errors/index.js';

describe('session branching and causal projection', () => {
  let directory: string;
  let file: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-branching-'));
    file = path.join(directory, 'session.jsonl');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const createStore = async () =>
    SessionStore.create(file, {
      conversationId: 'test-branching',
      projectRoot: directory,
      initialCwd: directory,
    });

  it('creates and switches branches with persistent control events', async () => {
    const store = await createStore();
    await store.append({ role: 'user', content: [{ type: 'text', text: 'initial prompt' }] });
    const records = await store.readRecords();
    const baseRecordId = records[1].recordId;

    // Create branch
    const branchRecord = await store.createBranch('feature-1', baseRecordId);
    expect(branchRecord.type).toBe('branch_created');
    expect(branchRecord.parentId).toBeNull();
    expect(branchRecord.branchId).toBeNull();

    // Select branch
    const selectRecord = await store.selectBranch('feature-1');
    expect(selectRecord.type).toBe('branch_selected');
    expect(store.getActiveBranchId()).toBe('feature-1');

    // Append to feature-1
    await store.append({ role: 'user', content: [{ type: 'text', text: 'feature-1 message' }] });

    const branches = await store.getBranches();
    expect(branches).toHaveLength(2);

    const mainBranch = branches.find((b) => b.branchId === MAIN_BRANCH_ID)!;
    expect(mainBranch.isActive).toBe(false);
    expect(mainBranch.messageCount).toBe(1);

    const featBranch = branches.find((b) => b.branchId === 'feature-1')!;
    expect(featBranch.isActive).toBe(true);
    expect(featBranch.baseRecordId).toBe(baseRecordId);
    expect(featBranch.messageCount).toBe(2); // initial + feature-1
  });

  it('validates branch naming and prevents duplicate creation or unknown selection', async () => {
    const store = await createStore();
    await store.append({ role: 'user', content: [{ type: 'text', text: 'root' }] });
    const rootId = (await store.readRecords())[1].recordId;

    // Invalid naming
    await expect(store.createBranch('invalid name with spaces', rootId)).rejects.toThrow(
      /alphanumeric/i,
    );
    await expect(store.createBranch('invalid/slash', rootId)).rejects.toThrow(/alphanumeric/i);

    // Non-existent base record
    await expect(store.createBranch('feat', 'non-existent-record-id')).rejects.toThrow(
      /Base record not found/,
    );

    // Create valid branch
    await store.createBranch('feat', rootId);

    // Duplicate branch creation
    await expect(store.createBranch('feat', rootId)).rejects.toThrow(/already exists/);

    // Selecting non-existent branch
    await expect(store.selectBranch('unknown-branch')).rejects.toThrow(/Branch not found/);
  });

  it('strictly rejects forking from an unclosed tool transaction assistant message', async () => {
    const store = await createStore();
    await store.append({ role: 'user', content: [{ type: 'text', text: 'call tool' }] });
    await store.append({
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling tool' },
        { type: 'tool_use', id: 'call_1', name: 'shell', input: { command: 'ls' } },
      ],
    });

    const records = await store.readRecords();
    const assistantWithToolUse = records[2];
    expect(assistantWithToolUse.payload.role).toBe('assistant');

    // Attempting to fork directly from assistant with open tool_use must fail
    try {
      await store.createBranch('broken-fork', assistantWithToolUse.recordId);
      expect.fail('should have rejected fork from unclosed tool transaction');
    } catch (err) {
      expect(err).toBeInstanceOf(KapibalaError);
      expect((err as KapibalaError).code).toBe('UNCLOSED_TOOL_TRANSACTION_FORK');
    }

    // Now close the tool transaction
    await store.append({
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'call_1',
          content: 'file1.txt',
        },
      ],
    });

    const updatedRecords = await store.readRecords();
    const closedToolRecord = updatedRecords.at(-1)!;

    // Forking from the closed tool transaction boundary is completely valid
    const safeBranch = await store.createBranch('safe-fork', closedToolRecord.recordId);
    expect(safeBranch.type).toBe('branch_created');
  });

  it('isolates causal projection between branches and handles reset boundaries', async () => {
    const store = await createStore();
    // M1
    await store.append({ role: 'user', content: [{ type: 'text', text: 'M1' }] });
    // M2
    await store.append({ role: 'assistant', content: [{ type: 'text', text: 'M2' }] });
    const recordsAfterM2 = await store.readRecords();
    const m2Id = recordsAfterM2[2].recordId;

    // M3 on main
    await store.append({ role: 'user', content: [{ type: 'text', text: 'M3-main' }] });

    // Fork 'feat-x' from M2
    await store.createBranch('feat-x', m2Id);
    await store.selectBranch('feat-x');

    // M4 on feat-x
    await store.append({ role: 'user', content: [{ type: 'text', text: 'M4-feat-x' }] });
    // M5 on feat-x
    await store.append({ role: 'assistant', content: [{ type: 'text', text: 'M5-feat-x' }] });

    // Switch back to main and append M4-main
    await store.selectBranch(MAIN_BRANCH_ID);
    await store.append({ role: 'assistant', content: [{ type: 'text', text: 'M4-main' }] });

    // Verify projection for main
    const mainHistory = await store.load();
    expect(mainHistory.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'M1',
      'M2',
      'M3-main',
      'M4-main',
    ]);

    // Verify projection for feat-x
    const featHistory = await store.buildProjection({ branchId: 'feat-x' });
    expect(featHistory.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'M1',
      'M2',
      'M4-feat-x',
      'M5-feat-x',
    ]);

    // Test reset on feat-x
    await store.selectBranch('feat-x');
    await store.clear();
    const featHistoryAfterClear = await store.load();
    expect(featHistoryAfterClear).toHaveLength(0);

    // Verify main history is completely unaffected by feat-x reset
    const mainHistoryAfterFeatClear = await store.buildProjection({ branchId: MAIN_BRANCH_ID });
    expect(mainHistoryAfterFeatClear.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'M1',
      'M2',
      'M3-main',
      'M4-main',
    ]);
  });

  it('recovers all branches and active selection on reopen', async () => {
    const store = await createStore();
    await store.append({ role: 'user', content: [{ type: 'text', text: 'base message' }] });
    const baseId = (await store.readRecords())[1].recordId;

    await store.createBranch('dev', baseId);
    await store.selectBranch('dev');
    await store.append({ role: 'user', content: [{ type: 'text', text: 'dev work' }] });

    // Reopen store
    const reopened = await SessionStore.open(file);
    expect(reopened.getActiveBranchId()).toBe('dev');

    const branches = await reopened.getBranches();
    expect(branches).toHaveLength(2);
    expect(branches.find((b) => b.branchId === 'dev')?.isActive).toBe(true);

    const devHistory = await reopened.load();
    expect(devHistory).toHaveLength(2);
    expect(devHistory.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'base message',
      'dev work',
    ]);
  });

  it('rejects corrupt branch reference or broken causal parent', async () => {
    const store = await createStore();
    await store.append({ role: 'user', content: [{ type: 'text', text: 'hello' }] });

    const rawLines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const records = rawLines.map((l) => JSON.parse(l));

    // Append record with unknown branch
    records.push({
      schemaVersion: 2,
      type: 'message',
      recordId: 'rec-unknown-branch',
      timestamp: Date.now(),
      seq: records.length,
      prevRecordId: records.at(-1).recordId,
      parentId: records[1].recordId,
      branchId: 'non-existent-branch',
      payload: {
        id: 'msg-unknown',
        role: 'user',
        content: [{ type: 'text', text: 'broken' }],
      },
    });

    fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
    await expect(SessionStore.open(file)).rejects.toThrow(/Session corrupt branchId/);
  });
});
