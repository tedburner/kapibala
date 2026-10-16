import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../src/context/session-store.js';
import {
  type AgentNotification,
  SessionInbox,
  SubagentOutbox,
  formatNotificationContent,
} from '../src/runtime/agent/outbox.js';
import type { AgentTaskRecord } from '../src/runtime/agent/types.js';

describe('SubagentOutbox and SessionInbox reliable notification delivery', () => {
  let directory: string;
  let file: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-notification-'));
    file = path.join(directory, 'parent-session.jsonl');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const createParentStore = async () =>
    SessionStore.create(file, {
      conversationId: 'parent-session-1',
      projectRoot: directory,
      initialCwd: directory,
    });

  const createDummyTask = (overrides?: Partial<AgentTaskRecord>): AgentTaskRecord => ({
    agentId: 'subagent-abc',
    origin: {
      rootTaskId: 'root-task-1',
      parentSessionId: 'parent-session-1',
      originBranchId: 'main',
      originRunId: 'run-1',
      spawnToolCallId: 'call-spawn-1',
      generation: 1,
      depth: 1,
    },
    role: 'explore',
    description: 'Inspect database schemas',
    prompt: 'Check SQL files',
    status: 'completed',
    createdAt: Date.now() - 1000,
    finishedAt: Date.now(),
    childAgentIds: new Set(),
    summary: 'Found 12 migration files',
    workspaceRoot: directory,
    executionCwd: directory,
    limits: {
      maxSteps: 15,
      timeoutMs: 300_000,
    },
    ...overrides,
  });

  it('delivers completed subagent notification as background context into parent session', async () => {
    const parentStore = await createParentStore();
    const inbox = new SessionInbox(parentStore);
    const outbox = new SubagentOutbox();

    const task = createDummyTask();
    const notification = outbox.enqueueFromTask(task);

    expect(outbox.isAcknowledged(notification.eventId)).toBe(false);
    expect(outbox.getPendingNotifications()).toHaveLength(1);

    // Consume notification
    const consumed = await inbox.consume(notification);
    expect(consumed).toBe(true);

    outbox.acknowledge(notification.eventId);
    expect(outbox.isAcknowledged(notification.eventId)).toBe(true);
    expect(outbox.getPendingNotifications()).toHaveLength(0);

    // Verify parent session history
    const history = await parentStore.load();
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe('user');

    const contentText = (history[0].content[0] as { text: string }).text;
    expect(contentText).toContain('子代理任务通知 · 执行完成');
    expect(contentText).toContain('Inspect database schemas');
    expect(contentText).toContain('Found 12 migration files');
  });

  it('deduplicates re-deliveries and prevents duplicate injection on crash recovery', async () => {
    const parentStore = await createParentStore();
    const inbox = new SessionInbox(parentStore);
    const outbox = new SubagentOutbox();

    const task = createDummyTask();
    const notification = outbox.enqueueFromTask(task);

    // First delivery
    const firstAttempt = await inbox.consume(notification);
    expect(firstAttempt).toBe(true);

    // Second delivery (simulating crash before ACK)
    const secondAttempt = await inbox.consume(notification);
    expect(secondAttempt).toBe(false);

    // Verify parent history has exactly one message
    const historyAfterSecond = await parentStore.load();
    expect(historyAfterSecond).toHaveLength(1);

    // Reopen store and create new inbox (simulating process restart)
    const reopenedStore = await SessionStore.open(file);
    const freshInbox = new SessionInbox(reopenedStore);

    const thirdAttempt = await freshInbox.consume(notification);
    expect(thirdAttempt).toBe(false);

    const finalHistory = await reopenedStore.load();
    expect(finalHistory).toHaveLength(1);
  });

  it('does not append a second spawn tool_result and preserves tool transaction closure', async () => {
    const parentStore = await createParentStore();

    // Parent initiates spawn_agent
    const spawnCallId = 'tool-use-spawn-123';
    await parentStore.append({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: spawnCallId,
          name: 'spawn_agent',
          input: { description: 'Subtask', prompt: 'Do work', role: 'explore' },
        },
      ],
    });

    // Parent receives immediate accepted tool_result
    await parentStore.append({
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          toolUseId: spawnCallId,
          content: JSON.stringify({ agentId: 'sub-1', status: 'accepted' }),
        },
      ],
    });

    const recordsBefore = await parentStore.readRecords();
    const toolResultCountBefore = recordsBefore.filter((r) => {
      if (r.type !== 'message') return false;
      const content = (r.payload as { content: unknown[] }).content;
      return Array.isArray(content) && content.some((b: any) => b.type === 'tool_result');
    }).length;
    expect(toolResultCountBefore).toBe(1);

    // Subagent finishes and notification is delivered
    const inbox = new SessionInbox(parentStore);
    const task = createDummyTask({
      agentId: 'sub-1',
      origin: {
        rootTaskId: 'root-1',
        parentSessionId: 'parent-session-1',
        originBranchId: 'main',
        originRunId: 'run-1',
        spawnToolCallId: spawnCallId,
        generation: 1,
        depth: 1,
      },
      status: 'completed',
      summary: 'All done',
    });
    const outbox = new SubagentOutbox();
    const notification = outbox.enqueueFromTask(task);
    await inbox.consume(notification);

    const recordsAfter = await parentStore.readRecords();
    const toolResultCountAfter = recordsAfter.filter((r) => {
      if (r.type !== 'message') return false;
      const content = (r.payload as { content: unknown[] }).content;
      return Array.isArray(content) && content.some((b: any) => b.type === 'tool_result');
    }).length;

    // Assert tool_result count is strictly unchanged (NO second tool_result added)
    expect(toolResultCountAfter).toBe(1);

    // Total messages is 3: assistant(tool_use), tool(tool_result), user(subagent notification background)
    const history = await parentStore.load();
    expect(history).toHaveLength(3);
    expect(history[0].role).toBe('assistant');
    expect(history[1].role).toBe('tool');
    expect(history[2].role).toBe('user');
  });

  it('delivers notification to the specific branch specified in originBranchId', async () => {
    const parentStore = await createParentStore();
    await parentStore.append({ role: 'user', content: [{ type: 'text', text: 'base message' }] });
    const baseId = (await parentStore.readRecords())[1].recordId;

    // Create a feature branch
    await parentStore.createBranch('feat-worker', baseId);

    const inbox = new SessionInbox(parentStore);
    const task = createDummyTask({
      origin: {
        rootTaskId: 'root-1',
        parentSessionId: 'parent-session-1',
        originBranchId: 'feat-worker',
        originRunId: 'run-feat',
        spawnToolCallId: 'call-feat',
        generation: 1,
        depth: 1,
      },
    });

    const outbox = new SubagentOutbox();
    const notification = outbox.enqueueFromTask(task);

    await inbox.consume(notification);

    // Main branch history should NOT have the notification
    const mainHistory = await parentStore.buildProjection({ branchId: 'main' });
    expect(mainHistory).toHaveLength(1);
    expect((mainHistory[0].content[0] as { text: string }).text).toBe('base message');

    // Feat branch history should have the notification
    const featHistory = await parentStore.buildProjection({ branchId: 'feat-worker' });
    expect(featHistory).toHaveLength(2);
    expect((featHistory[1].content[0] as { text: string }).text).toContain('子代理任务通知');
  });

  it('merges in-flight concurrent consume calls across different SessionInbox instances (R17)', async () => {
    const parentStore = await createParentStore();
    // Two distinct SessionInbox instances simulating CLI /agents collect or parallel consumers
    const inbox1 = new SessionInbox(parentStore);
    const inbox2 = new SessionInbox(parentStore);

    const outbox = new SubagentOutbox();
    const task = createDummyTask({ agentId: 'concurrent-sub' });
    const notification = outbox.enqueueFromTask(task);

    // Concurrently consume from both instances
    const [res1, res2] = await Promise.all([
      inbox1.consume(notification),
      inbox2.consume(notification),
    ]);

    // Exactly one append took place
    const history = await parentStore.load();
    expect(history).toHaveLength(1);
    expect((history[0].content[0] as { text: string }).text).toContain('子代理任务通知');
    expect(res1 || res2).toBe(true);
  });

  it('persists notifications and acks to JSONL storage and recovers unacknowledged on restart (R08)', () => {
    const storagePath = path.join(directory, 'outbox.jsonl');
    const outbox1 = new SubagentOutbox({ storagePath });

    const task1 = createDummyTask({ agentId: 'sub-persist-1' });
    const task2 = createDummyTask({ agentId: 'sub-persist-2' });

    const notif1 = outbox1.enqueueFromTask(task1);
    const notif2 = outbox1.enqueueFromTask(task2);

    expect(outbox1.getPendingNotifications()).toHaveLength(2);

    // Acknowledge task 1
    outbox1.acknowledge(notif1.eventId);
    expect(outbox1.getPendingNotifications()).toHaveLength(1);
    expect(outbox1.getPendingNotifications()[0].agentId).toBe('sub-persist-2');

    // Simulate process restart: create a new SubagentOutbox instance with the same storagePath
    const outbox2 = new SubagentOutbox({ storagePath });
    const pendingOnRestart = outbox2.getPendingNotifications();
    expect(pendingOnRestart).toHaveLength(1);
    expect(pendingOnRestart[0].agentId).toBe('sub-persist-2');
    expect(outbox2.isAcknowledged(notif1.eventId)).toBe(true);
    expect(outbox2.isAcknowledged(notif2.eventId)).toBe(false);
  });
});
