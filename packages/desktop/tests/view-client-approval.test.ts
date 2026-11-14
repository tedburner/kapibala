import { expect, it } from 'vitest';
import { ViewClient } from '../src/renderer/view-client.js';
import type { DesktopAPI, Notification } from '../src/shared/contracts.js';

/** 只实现 onEvent 的最小 DesktopAPI 桩；审批通知不依赖会话订阅即可到达。 */
function createClient(): { client: ViewClient; emit: (event: Notification) => void } {
  let handler: ((event: Notification) => void) | undefined;
  const api = {
    onEvent(listener: (event: Notification) => void) {
      handler = listener;
      return () => {};
    },
  } as unknown as DesktopAPI;
  const client = new ViewClient(api);
  return { client, emit: (event) => handler?.(event) };
}

const requested = {
  type: 'approval.requested',
  workspaceId: 'w',
  sessionId: 's',
  conversationId: 'c',
  workspaceName: 'kapibala',
  workspaceRoot: '/tmp/kapibala',
  approvalId: 'a',
  runId: 'r',
  toolName: 'run_command',
  capabilities: ['exec'],
  description: '{"command":"ls"}',
  sessionAllowed: false,
  expiresAt: Date.now() + 10_000,
} satisfies Notification;

it('审批超时自动拒绝时给出中文诊断，并在面板中移除该请求', () => {
  const { client, emit } = createClient();
  emit(requested);
  expect(client.snapshot().approvals).toHaveLength(1);
  emit({ type: 'approval.closed', approvalId: 'a', reason: 'timeout' });
  const facts = client.snapshot();
  expect(facts.approvals).toHaveLength(0);
  expect(facts.error).toContain('审批请求超时');
  expect(facts.error).toContain('run_command');
});

it('用户主动裁决或未知审批关闭不产生诊断', () => {
  const { client, emit } = createClient();
  emit(requested);
  emit({ type: 'approval.closed', approvalId: 'a', reason: 'resolved' });
  expect(client.snapshot().error).toBeUndefined();

  // 未曾请求过的审批关闭（迟到/脏事件）不产生诊断。
  emit({ type: 'approval.closed', approvalId: 'ghost', reason: 'timeout' });
  expect(client.snapshot().error).toBeUndefined();
});

it('重复请求同一审批以最新上下文为准', () => {
  const { client, emit } = createClient();
  emit(requested);
  emit({ ...requested, toolName: 'write_file' });
  emit({ type: 'approval.closed', approvalId: 'a', reason: 'timeout' });
  expect(client.snapshot().error).toContain('write_file');
});
