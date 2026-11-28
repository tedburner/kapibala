import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '@kiturone/kapibala';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../src/commands/dispatcher.js';
import { quoteCommand } from '../src/commands/quote.js';
import { QuoteDraft } from '../src/quote-draft.js';

describe('/quote 与引用草稿', () => {
  let home: string;
  let root: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-quote-'));
    root = path.join(home, 'workspace');
    fs.mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** 建一个源会话并写入消息；返回会话 ID 与「消息 ID → 记录 ID」映射。 */
  async function seed(messages: Array<{ id: string; role: 'user' | 'assistant'; text: string }>) {
    const manager = new SessionManager({
      workspaceRoot: root,
      homeDirectory: home,
      projectRootMode: 'exact',
    });
    const session = await manager.create();
    let time = Date.now();
    for (const message of messages) {
      await session.store.append({
        id: message.id,
        role: message.role,
        timestamp: time++,
        content: [{ type: 'text', text: message.text }],
      });
    }
    const recordIds = new Map<string, string>();
    for (const record of await session.store.readRecords()) {
      if (record.type !== 'message') continue;
      const messageId = (record.payload as { id?: string }).id;
      if (messageId) recordIds.set(messageId, record.recordId);
    }
    await session.release();
    return { sessionId: session.conversationId, recordIds };
  }

  /** 最小命令上下文：只提供 /quote 读取的会话身份、HOME、草稿与输出端口。 */
  function context(draft: QuoteDraft, lines: string[]): CommandContext {
    return {
      session: { workspaceRoot: root, conversationId: 'current' },
      settings: {},
      onExit: () => {},
      onModelSwitched: () => {},
      homeDir: home,
      references: draft,
      output: {
        log: (message: string) => lines.push(message),
        error: (message: string) => lines.push(message),
        write: () => {},
      },
    } as unknown as CommandContext;
  }

  it('草稿按会话数上限拒绝、支持按序号删除，take 后清空', () => {
    const draft = new QuoteDraft();
    draft.add({ sessionId: 'a', recordIds: ['r1'] });
    draft.add({ sessionId: 'b', recordIds: ['r2'] });
    draft.add({ sessionId: 'c', recordIds: ['r3'] });
    expect(() => draft.add({ sessionId: 'd', recordIds: ['r4'] })).toThrow(/单轮最多引用 3 个会话/);
    expect(draft.size).toBe(3);
    expect(draft.remove(4)).toBe(false);
    expect(draft.remove(2)).toBe(true);
    expect(draft.list().map((entry) => entry.sessionId)).toEqual(['a', 'c']);
    expect(draft.take()).toHaveLength(2);
    expect(draft.size).toBe(0);
  });

  it('会话级选择按实际读取条数裁决：短会话组合仍可挂载', async () => {
    const first = await seed([{ id: 'm1', role: 'user', text: '结论一' }]);
    const second = await seed([{ id: 'm1', role: 'user', text: '结论二' }]);
    const draft = new QuoteDraft();
    const lines: string[] = [];
    const ctx = context(draft, lines);

    await quoteCommand([first.sessionId], ctx);
    await quoteCommand([second.sessionId], ctx);
    expect(draft.size).toBe(2);
    expect(lines.join('\n')).toMatch(/已引用 2 条（2 个会话/);
  });

  it('会话级引用的实际条数超过单轮上限时在挂载阶段拒绝', async () => {
    const six = (prefix: string) =>
      Array.from({ length: 6 }, (_, index) => ({
        id: `${prefix}${index}`,
        role: 'user' as const,
        text: `${prefix} 消息 ${index}`,
      }));
    const first = await seed(six('a'));
    const second = await seed(six('b'));
    const draft = new QuoteDraft();
    const lines: string[] = [];
    const ctx = context(draft, lines);

    await quoteCommand([first.sessionId], ctx);
    await expect(quoteCommand([second.sessionId], ctx)).rejects.toMatchObject({
      code: 'REFERENCE_BUDGET_EXCEEDED',
    });
    expect(draft.size).toBe(1);
  });

  it('会话级引用挂载后打印摘要，--list 可查看并按序号删除', async () => {
    const { sessionId } = await seed([
      { id: 'm1', role: 'user', text: '登录接口超时的排查结论' },
      { id: 'm2', role: 'assistant', text: '建议先看网关超时配置' },
    ]);
    const draft = new QuoteDraft();
    const lines: string[] = [];
    const ctx = context(draft, lines);

    await quoteCommand([sessionId], ctx);
    expect(draft.size).toBe(1);
    expect(draft.list()[0]).toMatchObject({ sessionId, limit: 6 });
    expect(lines.join('\n')).toMatch(/已引用 2 条（1 个会话/);
    expect(lines.join('\n')).toContain('下一条输入发送时一并注入');

    lines.length = 0;
    await quoteCommand(['--list'], ctx);
    expect(lines[0]).toBe(`1. ${sessionId}`);

    lines.length = 0;
    await quoteCommand(['--list', '--remove', '1'], ctx);
    expect(lines.join('\n')).toContain('已移除第 1 条引用');
    expect(draft.size).toBe(0);
  });

  it('消息级引用按 recordId 挂载；无效会话在挂载时即失败且不残留草稿', async () => {
    const { sessionId, recordIds } = await seed([{ id: 'm1', role: 'user', text: '单独一条消息' }]);
    const draft = new QuoteDraft();
    const lines: string[] = [];
    const ctx = context(draft, lines);

    await quoteCommand([`${sessionId}#${recordIds.get('m1')!}`], ctx);
    expect(draft.list()[0]).toEqual({ sessionId, recordIds: [recordIds.get('m1')] });

    const empty = new QuoteDraft();
    await expect(quoteCommand(['missing-session'], context(empty, lines))).rejects.toMatchObject({
      code: 'REFERENCE_SESSION_NOT_FOUND',
    });
    expect(empty.size).toBe(0);
  });

  it('非 TTY 无参只列出候选与用法，不等待菜单', async () => {
    await seed([{ id: 'm1', role: 'user', text: '另一个会话的历史' }]);
    const draft = new QuoteDraft();
    const lines: string[] = [];
    await quoteCommand([], context(draft, lines));
    expect(lines.join('\n')).toContain('使用 /quote <sessionId> 引用该会话最近消息');
    expect(draft.size).toBe(0);
  });

  it('--search 只保留当前项目桶的命中；非 TTY 打印命中与用法', async () => {
    const { sessionId } = await seed([{ id: 'm1', role: 'user', text: '唯一关键词：水豚超时' }]);
    const draft = new QuoteDraft();
    const lines: string[] = [];
    await quoteCommand(['--search', '水豚超时'], context(draft, lines));
    const joined = lines.join('\n');
    expect(joined).toContain(sessionId);
    expect(joined).toContain('使用 /quote <sessionId>#<recordId> 引用命中消息');
    expect(draft.size).toBe(0);
  });

  it('在绑定独立 Worktree 时优先按主仓库 projectRoot 读取同桶会话引用', async () => {
    const { sessionId } = await seed([{ id: 'm1', role: 'user', text: '主仓库桶内历史' }]);
    const isolatedWorktreeDir = path.join(home, 'isolated-wt');
    fs.mkdirSync(isolatedWorktreeDir, { recursive: true });
    const draft = new QuoteDraft();
    const lines: string[] = [];
    const wtCtx: CommandContext = {
      ...context(draft, lines),
      projectRoot: root,
      executionRoot: isolatedWorktreeDir,
      session: { workspaceRoot: isolatedWorktreeDir, conversationId: 'wt-current' } as never,
    };

    await quoteCommand([sessionId], wtCtx);
    expect(draft.size).toBe(1);
    expect(lines.join('\n')).toMatch(/已引用 1 条（1 个会话/);
  });
});
