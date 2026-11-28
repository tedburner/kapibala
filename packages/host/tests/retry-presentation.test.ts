import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { type CanonicalMessage, WorkspaceLeaseCoordinator } from '@kiturone/kapibala';
import { afterEach, describe, expect, it } from 'vitest';
import { createManagedSession } from '../src/host/managed-session.js';
import { PresentationStore } from '../src/host/presentation-store.js';
import {
  redactPresentationChange,
  redactPresentationState,
} from '../src/host/public-projection.js';
import { SessionPresentation } from '../src/host/session-presentation.js';
import {
  createUserSettingsSkeleton,
  saveGlobalSettings,
  trustProject,
} from '../src/host/settings.js';
import {
  type PresentationEvent,
  createPresentation,
  reducePresentation,
} from '../src/view-model/index.js';

const tempDirs: string[] = [];
const servers: http.Server[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync.native(dir);
}

afterEach(async () => {
  for (const srv of servers.splice(0)) {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('ViewModel & SessionPresentation 自动重试与断流回滚', () => {
  it('reducePresentation 在 stream_reset 时清除目标未提交消息并在新增量到达时自动清除 retryStatus', () => {
    const identity = { conversationId: 'conv-1', branchId: 'main', viewEpoch: 1 };
    let state = createPresentation(identity);
    let seq = 0;
    const apply = (
      change: PresentationEvent['change'],
      operationId: string | undefined = 'op-1',
    ) => {
      state = reducePresentation(state, {
        ...state.identity,
        sequence: ++seq,
        ...(operationId ? { operationId } : {}),
        change,
      });
    };

    apply({ type: 'operation_started' });
    apply({
      type: 'append',
      messageId: 'prov-1',
      blockId: 'b-think',
      kind: 'thinking',
      text: '半截思考',
    });
    apply({
      type: 'append',
      messageId: 'prov-1',
      blockId: 'b-text',
      kind: 'text',
      text: '半截回答',
    });
    expect(state.pendingMessages).toHaveLength(1);
    expect(state.order).toContain('prov-1');

    apply({ type: 'stream_reset', messageId: 'prov-1' });
    expect(state.pendingMessages).toHaveLength(0);
    expect(state.order).not.toContain('prov-1');

    apply({
      type: 'retry_status_changed',
      retryStatus: {
        step: 1,
        attempt: 1,
        maxRetries: 2,
        delayMs: 1200,
        nextRetryAt: 10_000,
        category: 'network',
        message: 'SSE 连接中断，准备重试',
      },
    });
    expect(state.retryStatus?.attempt).toBe(1);

    // 下一轮尝试的首个流式块到达时，无需额外事件即原子清除 retryStatus
    apply({
      type: 'append',
      messageId: 'prov-2',
      blockId: 'b-text-2',
      kind: 'text',
      text: '完整回答',
    });
    expect(state.retryStatus).toBeUndefined();
    expect(Object.hasOwn(state, 'retryStatus')).toBe(false);
    expect(state.pendingMessages).toHaveLength(1);
    expect(state.pendingMessages[0]?.id).toBe('prov-2');
  });

  it('redactPresentationChange 与 redactPresentationState 对 retryStatus.message 执行凭证脱敏', () => {
    const redact = (value: string) => value.replaceAll('sk-live-secret99', '[REDACTED]');
    const retryStatus = {
      step: 1,
      attempt: 1,
      maxRetries: 2,
      delayMs: 1000,
      nextRetryAt: 2000,
      category: 'rate_limit',
      message: '网关限流 (key=sk-live-secret99)',
    };
    const redactedChange = redactPresentationChange(
      { type: 'retry_status_changed', retryStatus },
      redact,
    );
    expect(redactedChange).toEqual({
      type: 'retry_status_changed',
      retryStatus: { ...retryStatus, message: '网关限流 (key=[REDACTED])' },
    });

    const base = createPresentation({ conversationId: 'c', branchId: 'main', viewEpoch: 1 });
    const withRetry = { ...base, retryStatus };
    expect(redactPresentationState(withRetry, redact).retryStatus?.message).toBe(
      '网关限流 (key=[REDACTED])',
    );
  });

  it('SessionPresentation 在断流重试期间轮换临时消息 ID 并完整保留前序已落盘工具步骤', () => {
    const history: CanonicalMessage[] = [
      {
        id: 'u-1',
        role: 'user',
        timestamp: 1,
        content: [{ type: 'text', text: '修复测试' }],
      },
    ];
    const identity = { conversationId: 'conv-p', branchId: 'main', viewEpoch: 1 };
    const store = new PresentationStore(identity, []);
    const redact = (value: string) => value.replaceAll('sk-secret-tok', '[REDACTED]');
    const presentation = new SessionPresentation(store, 'op-retry', () => history, redact);

    // Step 1: 完成一次工具调用并落盘
    presentation.consume({ type: 'turn_start', turn: 1 });
    presentation.consume({
      type: 'tool_start',
      id: 'call-1',
      name: 'read_file',
      input: { path: 'a.ts' },
    });
    presentation.consume({
      type: 'tool_finish',
      id: 'call-1',
      name: 'read_file',
      result: 'export const x = 1;',
      isError: false,
      durationMs: 5,
    });
    const assistantStep1: CanonicalMessage = {
      id: 'a-1',
      role: 'assistant',
      timestamp: 2,
      content: [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'a.ts' } }],
    };
    const toolStep1: CanonicalMessage = {
      id: 't-1',
      role: 'tool',
      timestamp: 3,
      content: [{ type: 'tool_result', toolUseId: 'call-1', content: 'export const x = 1;' }],
    };
    history.push(assistantStep1);
    presentation.consume({ type: 'message_stop', message: assistantStep1 });
    history.push(toolStep1);
    presentation.consume({ type: 'tool_messages', messages: [toolStep1] });

    const committedBeforeRetry = store.snapshot().messages.length;
    expect(committedBeforeRetry).toBeGreaterThanOrEqual(2);

    // Step 2: 输出半截文本后断流 -> stream_reset -> retry_scheduled -> 重新输出完整文本
    presentation.consume({ type: 'turn_start', turn: 2 });
    presentation.consume({ type: 'thinking_delta', thinking: '断流前思考' });
    presentation.consume({ type: 'text_delta', text: '断流前半截正文' });
    const oldProvisionalId = store.snapshot().pendingMessages[0]?.id;
    expect(oldProvisionalId).toBeDefined();

    presentation.consume({ type: 'stream_reset', step: 2, attempt: 1 });
    expect(store.snapshot().pendingMessages).toHaveLength(0);

    presentation.consume({
      type: 'retry_scheduled',
      step: 2,
      attempt: 1,
      maxRetries: 2,
      delayMs: 1000,
      nextRetryAt: Date.now() + 1000,
      category: 'network',
      message: '上游中断 sk-secret-tok\u001b[2J',
    });
    expect(store.snapshot().retryStatus?.message).toBe('上游中断 [REDACTED]');

    presentation.consume({ type: 'text_delta', text: '重试后的完整答复' });
    expect(store.snapshot().retryStatus).toBeUndefined();
    const newProvisional = store.snapshot().pendingMessages[0];
    expect(newProvisional?.id).toBeDefined();
    expect(newProvisional?.id).not.toBe(oldProvisionalId);
    expect(newProvisional?.blocks.map((b) => b.text).join('')).toBe('重试后的完整答复');

    const finalAssistant: CanonicalMessage = {
      id: 'a-2',
      role: 'assistant',
      timestamp: 4,
      content: [{ type: 'text', text: '重试后的完整答复' }],
    };
    history.push(finalAssistant);
    presentation.consume({ type: 'message_stop', message: finalAssistant });
    presentation.settle('completed');

    const finalSnap = store.snapshot();
    expect(finalSnap.pendingMessages).toHaveLength(0);
    expect(finalSnap.messages.length).toBe(committedBeforeRetry + 1);
    const allTexts = finalSnap.messages.flatMap((m) => m.blocks.map((b) => b.text)).join('\n');
    expect(allTexts).not.toContain('断流前半截正文');
    expect(allTexts).toContain('重试后的完整答复');
  });

  it('ManagedHostSession 默认开启 allowMidStreamRetry 并在空闲态支持 createBranchWithSummary 同步投影', async () => {
    const home = makeTempDir('kpbl-managed-retry-home-');
    const workspace = makeTempDir('kpbl-managed-retry-ws-');

    let attempts = 0;
    const server = http.createServer((req, res) => {
      if (req.url?.endsWith('/chat/completions')) {
        attempts++;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        if (attempts === 1) {
          // 首次请求吐出半截流式 chunk 后直接掐断 socket（无 [DONE] 终止帧）
          res.write(
            `data: ${JSON.stringify({
              id: 'cmpl-1',
              choices: [
                { index: 0, delta: { content: '半截残片 sk-mysecret' }, finish_reason: null },
              ],
            })}\n\n`,
          );
          setTimeout(() => req.socket.destroy(), 15);
          return;
        }
        res.write(
          `data: ${JSON.stringify({
            id: 'cmpl-2',
            choices: [{ index: 0, delta: { content: '断流自愈成功' }, finish_reason: 'stop' }],
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(404).end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const baseSettings = createUserSettingsSkeleton();
    saveGlobalSettings(
      {
        ...baseSettings,
        defaultModel: 'local-retry-test',
        profiles: [
          {
            id: 'local-retry-test',
            name: 'Local Retry Test',
            provider: 'openai-compatible',
            modelName: 'test-model',
            baseURL: `http://127.0.0.1:${port}/v1`,
            apiKey: 'sk-mysecret-key-12345',
            apiKeyEnv: 'NONE',
            contextWindow: 32_000,
          },
        ],
      },
      { homeDir: home },
    );
    trustProject(createUserSettingsSkeleton(), workspace, { homeDir: home });

    const managed = await createManagedSession({
      workspaceRoot: workspace,
      homeDirectory: home,
      approvalChannel: { requestApproval: async () => 'deny_once' },
      leaseCoordinator: new WorkspaceLeaseCoordinator(),
    });

    const seenChanges: string[] = [];
    const unsub = managed.subscribeEvents((evt) => {
      seenChanges.push(evt.change.type);
    });

    try {
      await managed.run('请回答');
      expect(attempts).toBe(2);
      expect(seenChanges).toContain('stream_reset');
      expect(seenChanges).toContain('retry_status_changed');

      const snap = managed.snapshot();
      expect(snap.retryStatus).toBeUndefined();
      const assistantTexts = snap.messages
        .filter((m) => m.role === 'assistant')
        .flatMap((m) => m.blocks.map((b) => b.text))
        .join('');
      expect(assistantTexts).toBe('断流自愈成功');
      expect(assistantTexts).not.toContain('半截残片');

      const branched = await managed.createBranchWithSummary('exp-summary', {
        customSummary: '前序分支结论：断流恢复验证通过。',
      });
      expect(branched.branchId).toBe('exp-summary');
      expect(managed.snapshot().identity.branchId).toBe('exp-summary');
    } finally {
      unsub();
      await managed.dispose();
    }
  });
});
