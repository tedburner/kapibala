import { expect, it } from 'vitest';
import { NativeNotices } from '../src/main/native-notices.js';
import type { Notification } from '../src/shared/contracts.js';

it('后台通知只定位窗口，去重且迟到点击在关闭、过期和换 Host 后失效', () => {
  const shown: { title: string; body: string; click: () => void }[] = [];
  let focused = 0;
  let foreground = false;
  const notices = new NativeNotices(
    () => !foreground,
    (title, body, click) => {
      shown.push({ title, body, click });
      return () => {};
    },
    () => focused++,
  );
  notices.open('s');
  const receipt = {
    workspaceId: 'w',
    sessionId: 's',
    runId: 'r',
    operationId: 'o',
    phase: 'idle' as const,
    result: 'completed' as const,
  };
  for (let i = 0; i < 2000; i++) notices.observe({ type: 'run.changed', receipt });
  expect(shown).toHaveLength(1);
  expect(shown[0].body).toBe('打开 Kapibala 查看运行结果。');
  shown[0].click();
  expect(focused).toBe(1);
  notices.close('s');
  shown[0].click();
  expect(focused).toBe(1);
  notices.open('s');
  const approval = {
    type: 'approval.requested',
    workspaceId: 'w',
    sessionId: 's',
    conversationId: 'c',
    workspaceName: 'secret-title',
    workspaceRoot: '/secret',
    approvalId: 'a',
    runId: 'r',
    toolName: 'write_file',
    capabilities: ['write'],
    description: 'secret-input',
    sessionAllowed: false,
    expiresAt: Date.now() + 10_000,
  } satisfies Notification;
  notices.observe(approval);
  expect(JSON.stringify(shown)).not.toContain('secret');
  notices.observe({ type: 'approval.closed', approvalId: 'a' });
  shown.at(-1)!.click();
  expect(focused).toBe(1);
  notices.observe({ ...approval, approvalId: 'expired', expiresAt: 0 });
  expect(shown).toHaveLength(2);
  notices.observe({ ...approval, approvalId: 'b' });
  notices.reset();
  shown.at(-1)!.click();
  expect(focused).toBe(1);
  notices.open('s');
  foreground = true;
  notices.observe({ type: 'run.changed', receipt: { ...receipt, runId: 'r2' } });
  expect(shown).toHaveLength(3);
});
