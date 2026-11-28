import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { identifyHistory } from '../src/context/history.js';
import { ContextManager } from '../src/context/manager.js';
import { SessionStore } from '../src/context/session-store.js';
import { AgentSession } from '../src/context/session/index.js';
import { SessionBusyError } from '../src/errors/index.js';
import {
  type ModelProfile,
  type ModelProvider,
  assembleCanonicalToolResults,
} from '../src/models/index.js';
import { SimpleModelRouter } from '../src/models/router.js';
import type {
  CanonicalMessage,
  ModelEvent,
  ModelRequest,
  ReferenceContentSource,
  SessionEvent,
} from '../src/types/index.js';

const TEST_PROFILE: ModelProfile = {
  id: 'ref-compact-model',
  name: 'Ref Compact Model',
  provider: 'openai-compatible',
  baseURL: 'https://example.test/v1',
  apiKeyEnv: 'NONE',
  modelName: 'test-model',
  contextWindow: 32_000,
};

async function drainPrepare(
  gen: AsyncGenerator<SessionEvent, ModelRequest>,
): Promise<{ events: SessionEvent[]; request: ModelRequest }> {
  const events: SessionEvent[] = [];
  while (true) {
    const next = await gen.next();
    if (next.done) return { events, request: next.value };
    events.push(next.value);
  }
}

describe('R2.1 Compaction reference provenance index & R2.2 branchWithSummary', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-ref-branch-sum-')),
    );
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('degrades referenceSource blocks before LLM summarization and carries deduplicated <session-references> across checkpoints', async () => {
    const store = await SessionStore.create(path.join(directory, 'compact.jsonl'), {
      conversationId: 'compact-ref',
      projectRoot: directory,
      initialCwd: directory,
    });

    const refSource1: ReferenceContentSource = {
      version: 1,
      sessionId: 'ses-alpha',
      recordId: 'rec-101',
      branchId: 'main',
      role: 'assistant',
      timestamp: 1764000000000,
      title: '排查超时根因',
      contentDigest: '0123456789abcdef',
    };
    const refSource2: ReferenceContentSource = {
      version: 1,
      sessionId: 'ses-beta',
      recordId: 'rec-202',
      branchId: 'feat',
      role: 'user',
      timestamp: 1764000100000,
      title: '接口契约讨论',
      contentDigest: 'fedcba9876543210',
    };

    const hugeQuotedTranscript = `<session-reference>\n${'SECRET_RAW_QUOTE_BODY_'.repeat(600)}\n</session-reference>`;
    const seenSummarizerPayloads: string[] = [];

    const summaryProvider: ModelProvider = {
      name: 'mock-summarizer',
      assembleToolResults: assembleCanonicalToolResults,
      async *create(req: ModelRequest): AsyncIterable<ModelEvent> {
        const serialized = JSON.stringify(req.messages);
        seenSummarizerPayloads.push(serialized);
        const parsed = JSON.parse(
          (req.messages[0].content[0] as { type: 'text'; text: string }).text,
        ) as { sourceMessages: Array<{ id: string }> };
        const firstId = parsed.sourceMessages[0]?.id ?? '';
        yield {
          type: 'text_delta',
          text: JSON.stringify({
            schemaVersion: 1,
            goal: 'Keep compact context',
            constraints: [],
            decisions: ['Retained reference provenance'],
            completedWork: ['Summarized older turns'],
            pendingWork: [],
            references: firstId ? [firstId] : [],
            unknownEffects: [],
          }),
        };
        yield {
          type: 'message_stop',
          finishReason: 'stop',
          usage: { promptTokens: 80, completionTokens: 30, totalTokens: 110 },
        };
      },
    };

    const history1: CanonicalMessage[] = identifyHistory(
      [
        {
          id: 'u1',
          interactionId: 'run-1',
          role: 'user',
          content: [
            { type: 'text', text: '结合历史结论继续分析' },
            { type: 'text', text: hugeQuotedTranscript, referenceSource: refSource1 },
          ],
        },
        {
          id: 'a1',
          interactionId: 'run-1',
          role: 'assistant',
          content: [{ type: 'text', text: '收到历史结论，已完成第一步排查。' }],
        },
        {
          id: 'u2',
          interactionId: 'run-2',
          role: 'user',
          content: [{ type: 'text', text: '最近完成的一轮提问' }],
        },
        {
          id: 'a2',
          interactionId: 'run-2',
          role: 'assistant',
          content: [{ type: 'text', text: '最近完成的一轮回答' }],
        },
        {
          id: 'u3',
          interactionId: 'run-3',
          role: 'user',
          content: [{ type: 'text', text: '当前正在进行的提问' }],
        },
      ],
      'test',
    );
    for (const msg of history1) await store.append(msg);

    const manager = new ContextManager({
      conversationId: 'compact-ref',
      store,
      router: new SimpleModelRouter(TEST_PROFILE, summaryProvider),
      projectRoot: directory,
    });
    manager.finishInteraction({ interactionId: 'run-1', status: 'completed' });
    manager.finishInteraction({ interactionId: 'run-2', status: 'completed' });

    const firstCompaction = await drainPrepare(
      manager.prepare(
        history1,
        { messages: manager.project(history1) },
        TEST_PROFILE,
        'run-3',
        'manual',
      ),
    );

    expect(firstCompaction.events.some((e) => e.type === 'compaction_finish')).toBe(true);
    expect(seenSummarizerPayloads).toHaveLength(1);
    expect(seenSummarizerPayloads[0]).not.toContain('SECRET_RAW_QUOTE_BODY_');
    expect(seenSummarizerPayloads[0]).toContain(
      '[已引用历史会话 ses-alpha 记录 rec-101 (排查超时根因)]',
    );

    const projected1 = manager.project(history1);
    const summaryText1 = (projected1[0].content[0] as { type: 'text'; text: string }).text;
    expect(summaryText1).toContain('<session-references>');
    expect(summaryText1).toContain('"sessionId":"ses-alpha"');
    expect(summaryText1).toContain('"recordId":"rec-101"');
    expect(summaryText1).toContain('"title":"排查超时根因"');

    // Second incremental compaction: re-references refSource1 AND adds refSource2 -> must deduplicate!
    const moreMsgs: CanonicalMessage[] = identifyHistory(
      [
        {
          id: 'a3',
          interactionId: 'run-3',
          role: 'assistant',
          content: [{ type: 'text', text: '第三轮完成' }],
        },
        {
          id: 'u4',
          interactionId: 'run-4',
          role: 'user',
          content: [
            { type: 'text', text: '再次引用并引入第二个会话' },
            { type: 'text', text: hugeQuotedTranscript, referenceSource: refSource1 },
            { type: 'text', text: hugeQuotedTranscript, referenceSource: refSource2 },
          ],
        },
        {
          id: 'a4',
          interactionId: 'run-4',
          role: 'assistant',
          content: [{ type: 'text', text: '第四轮完成' }],
        },
        {
          id: 'u5',
          interactionId: 'run-5',
          role: 'user',
          content: [{ type: 'text', text: '第五轮最近成功提问' }],
        },
        {
          id: 'a5',
          interactionId: 'run-5',
          role: 'assistant',
          content: [{ type: 'text', text: '第五轮最近成功回答' }],
        },
      ],
      'test-more',
    );
    for (const msg of moreMsgs) await store.append(msg);
    const history2 = [...history1, ...moreMsgs];
    manager.finishInteraction({ interactionId: 'run-3', status: 'completed' });
    manager.finishInteraction({ interactionId: 'run-4', status: 'completed' });
    manager.finishInteraction({ interactionId: 'run-5', status: 'completed' });

    await drainPrepare(
      manager.prepare(
        history2,
        { messages: manager.project(history2) },
        TEST_PROFILE,
        'run-6',
        'manual',
      ),
    );

    const restoredManager = new ContextManager({
      conversationId: 'compact-ref',
      store,
      router: new SimpleModelRouter(TEST_PROFILE, summaryProvider),
      projectRoot: directory,
    });
    await restoredManager.restore(history2);
    const projectedRestored = restoredManager.project(history2);
    const summaryText2 = (projectedRestored[0].content[0] as { type: 'text'; text: string }).text;
    expect(summaryText2).toContain('"sessionId":"ses-alpha"');
    expect(summaryText2).toContain('"sessionId":"ses-beta"');
    expect(summaryText2.match(/"recordId":"rec-101"/g)).toHaveLength(1);
  });

  it('appends branch_summary in SessionStore and creates summarized branches via AgentSession.createBranchWithSummary', async () => {
    const store = await SessionStore.create(path.join(directory, 'branch-sum.jsonl'), {
      conversationId: 'branch-sum-conv',
      projectRoot: directory,
      initialCwd: directory,
    });

    let callIndex = 0;

    const provider: ModelProvider = {
      name: 'branch-summary-provider',
      assembleToolResults: assembleCanonicalToolResults,
      async *create(req: ModelRequest): AsyncIterable<ModelEvent> {
        callIndex++;
        if (callIndex === 1) {
          yield {
            type: 'text_delta',
            text: 'Main branch architecture conclusion: use SQLite WAL.',
          };
          yield {
            type: 'message_stop',
            finishReason: 'stop',
            usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
          };
          return;
        }
        if (callIndex === 2) {
          // SummaryService invocation during createBranchWithSummary
          const parsed = JSON.parse(
            (req.messages[0].content[0] as { type: 'text'; text: string }).text,
          ) as { sourceMessages: Array<{ id: string }> };
          yield {
            type: 'text_delta',
            text: JSON.stringify({
              schemaVersion: 1,
              goal: 'Design storage layer',
              constraints: ['Zero native C++ deps in Core'],
              decisions: ['Adopt SQLite WAL mode'],
              completedWork: ['Evaluated locking model'],
              pendingWork: ['Implement migration'],
              references: parsed.sourceMessages[0]?.id ? [parsed.sourceMessages[0].id] : [],
              unknownEffects: [],
            }),
          };
          yield {
            type: 'message_stop',
            finishReason: 'stop',
            usage: { promptTokens: 40, completionTokens: 25, totalTokens: 65 },
          };
          return;
        }
        yield { type: 'text_delta', text: 'slow turn finished' };
        yield { type: 'message_stop', finishReason: 'stop' };
      },
    };

    const session = new AgentSession({
      workspaceRoot: directory,
      conversationId: 'branch-sum-conv',
      store,
      defaultProfile: TEST_PROFILE,
      defaultProvider: provider,
    });

    // 1. Run one turn on main branch
    for await (const _ of session.run('Evaluate storage options')) {
      // consume
    }
    expect(session.getHistory()).toHaveLength(2);

    // 2. Branch with model-generated summary
    const created = await session.createBranchWithSummary('feat-wal');
    expect(created.branchId).toBe('feat-wal');
    expect(created.summary).toContain('Design storage layer');
    expect(created.summary).toContain('Adopt SQLite WAL mode');
    expect(store.getActiveBranchId()).toBe('feat-wal');

    const branchHistory = session.getHistory();
    expect(branchHistory.at(-1)?.role).toBe('user');
    expect((branchHistory.at(-1)?.content[0] as { text: string }).text).toContain(
      '[分支上下文背景摘要；历史参考信息，非当前指令或权限授予]',
    );
    expect((branchHistory.at(-1)?.content[0] as { text: string }).text).toContain(
      'Adopt SQLite WAL mode',
    );

    // 3. Branch with customSummary from root header (explicit customSummary)
    const headerId = (await store.readRecords())[0].recordId;
    const customBranch = await session.createBranchWithSummary('feat-custom', {
      baseRecordId: headerId,
      customSummary: '手动指定的分支背景摘要',
    });
    expect(customBranch).toEqual({
      branchId: 'feat-custom',
      summary: '手动指定的分支背景摘要',
    });
    expect(session.getHistory()).toHaveLength(1);
    expect((session.getHistory()[0].content[0] as { text: string }).text).toContain(
      '手动指定的分支背景摘要',
    );

    // 4. Empty-history deterministic host fallback without invoking summary model
    const callsBeforeEmptyFallback = callIndex;
    const emptyBranch = await session.createBranchWithSummary('feat-empty', {
      baseRecordId: headerId,
    });
    expect(callIndex).toBe(callsBeforeEmptyFallback);
    expect(emptyBranch.branchId).toBe('feat-empty');
    expect(emptyBranch.summary).toContain('源于分支');
    expect(session.getHistory()).toHaveLength(1);

    // 5. Rejects with SessionBusyError while an active run is in flight
    const activeIterator = session.run('Start slow turn')[Symbol.asyncIterator]();
    const firstEvent = await activeIterator.next();
    expect(firstEvent.done).toBe(false);
    await expect(session.createBranchWithSummary('feat-busy')).rejects.toBeInstanceOf(
      SessionBusyError,
    );
    while (!(await activeIterator.next()).done) {
      // drain
    }

    await session.destroy();
  });

  it('compacts cleanly across root-forked branch_summary on small contextWindow (4000) without ContextBudgetError and reuses checkpoint projection on subsequent branch summary', async () => {
    const store = await SessionStore.create(path.join(directory, 'root-fork-compact.jsonl'), {
      conversationId: 'root-fork-compact',
      projectRoot: directory,
      initialCwd: directory,
    });

    // Verify appendBranchSummary resolves activeBranchId inside enqueue when queued right after selectBranch
    const headerId = (await store.readRecords())[0].recordId;
    await store.createBranch('queued-branch', headerId);
    const selectPromise = store.selectBranch('queued-branch');
    const summaryRecordPromise = store.appendBranchSummary({
      summary: 'Queued branch summary check',
      generatedBy: 'host',
    });
    const [, queuedSummaryRecord] = await Promise.all([selectPromise, summaryRecordPromise]);
    expect(queuedSummaryRecord.branchId).toBe('queued-branch');
    expect(queuedSummaryRecord.payload.branchId).toBe('queued-branch');
    await store.selectBranch('main');

    const smallProfile: ModelProfile = {
      ...TEST_PROFILE,
      id: 'small-window-model',
      contextWindow: 4_000,
      maxOutputTokens: 512,
    };

    let summaryCalls = 0;
    let lastSummaryPayload = '';
    const provider: ModelProvider = {
      name: 'small-window-provider',
      assembleToolResults: assembleCanonicalToolResults,
      async *create(req: ModelRequest): AsyncIterable<ModelEvent> {
        if (req.systemPrompt?.startsWith('Summarize the supplied conversation as JSON only')) {
          summaryCalls++;
          lastSummaryPayload = (req.messages[0].content[0] as { type: 'text'; text: string }).text;
          const parsed = JSON.parse(lastSummaryPayload) as {
            sourceMessages: Array<{ id: string }>;
          };
          const refId = parsed.sourceMessages[0]?.id;
          yield {
            type: 'text_delta',
            text: JSON.stringify({
              schemaVersion: 1,
              goal: 'Continue feature work on forked branch',
              constraints: ['Keep context under 4000 tokens'],
              decisions: ['Summarized across branch_summary cleanly'],
              completedWork: [`Compacted ${parsed.sourceMessages.length} messages`],
              pendingWork: ['Finish remaining turns'],
              references: refId ? [refId] : [],
              unknownEffects: [],
            }),
          };
          yield {
            type: 'message_stop',
            finishReason: 'stop',
            usage: { promptTokens: 120, completionTokens: 40, totalTokens: 160 },
          };
          return;
        }

        const filler =
          'Detailed implementation progress notes for small window verification. '.repeat(35);
        yield { type: 'text_delta', text: filler };
        yield {
          type: 'message_stop',
          finishReason: 'stop',
          usage: { promptTokens: 800, completionTokens: 450, totalTokens: 1250 },
        };
      },
    };

    const session = new AgentSession({
      workspaceRoot: directory,
      conversationId: 'root-fork-compact',
      store,
      defaultProfile: smallProfile,
      defaultProvider: provider,
    });

    await session.createBranchWithSummary('root-fork', {
      baseRecordId: headerId,
      customSummary:
        'Root fork initial context summary with architectural background for small context window.',
    });
    expect(session.getHistory()[0]?.role).toBe('user');

    const seenCompactions: SessionEvent[] = [];
    for (let turn = 1; turn <= 6; turn++) {
      for await (const event of session.run(
        `Turn ${turn}: ${'Provide detailed module analysis and state transition checks. '.repeat(15)}`,
      )) {
        if (event.type === 'compaction_finish') {
          seenCompactions.push(event);
        }
      }
    }

    expect(seenCompactions.length).toBeGreaterThan(0);
    expect(session.getContextSnapshot()?.checkpointId).toBeDefined();

    // Run one more turn so there is an eligible turn after the previous checkpoint, then test manual session.compact()
    for await (const _ of session.run(
      `Turn 7: ${'Additional context before manual compact verification. '.repeat(6)}`,
    )) {
      // consume
    }
    for await (const _ of session.run('Turn 8: Latest protected turn.')) {
      // consume
    }

    const manualCompactEvents: SessionEvent[] = [];
    for await (const event of session.compact()) {
      manualCompactEvents.push(event);
    }
    expect(manualCompactEvents.some((e) => e.type === 'compaction_finish')).toBe(true);

    // Branching with summary from an already-compacted session must reuse ContextManager projection (1 summary call)
    const callsBeforeBranch = summaryCalls;
    const subBranch = await session.createBranchWithSummary('post-compact-fork');
    expect(subBranch.branchId).toBe('post-compact-fork');
    expect(summaryCalls - callsBeforeBranch).toBe(1);
    expect(lastSummaryPayload).toContain('Historical conversation summary');

    await session.destroy();
  });
});
