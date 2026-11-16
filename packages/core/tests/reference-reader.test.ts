import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionReferenceReader } from '../src/context/reference.js';
import { SessionManager } from '../src/context/session-manager.js';

describe('SessionReferenceReader - 跨会话引用只读读取', () => {
  let tmpHome: string;
  let projectADir: string;
  let projectBDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-reference-test-'));
    projectADir = path.join(tmpHome, 'workspace-a');
    projectBDir = path.join(tmpHome, 'workspace-b');
    fs.mkdirSync(projectADir, { recursive: true });
    fs.mkdirSync(projectBDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  /** 建一个临时会话并写入给定消息，返回会话 ID、管理器与「消息 ID → 记录 ID」映射。 */
  async function createSession(
    messages: Array<{
      id: string;
      role: 'user' | 'assistant' | 'tool';
      text?: string;
      toolUse?: { id: string; name: string };
      toolResult?: { toolUseId: string; content: string };
    }>,
  ): Promise<{
    sessionId: string;
    manager: SessionManager;
    recordIdByMessageId: Map<string, string>;
  }> {
    const manager = new SessionManager({ workspaceRoot: projectADir, homeDirectory: tmpHome });
    const session = await manager.create();
    let time = Date.now();
    for (const message of messages) {
      const content: Array<Record<string, unknown>> = [];
      if (message.text !== undefined) content.push({ type: 'text', text: message.text });
      if (message.toolUse) {
        content.push({
          type: 'tool_use',
          id: message.toolUse.id,
          name: message.toolUse.name,
          input: {},
        });
      }
      if (message.toolResult) {
        content.push({
          type: 'tool_result',
          toolUseId: message.toolResult.toolUseId,
          content: message.toolResult.content,
        });
      }
      await session.store.append({
        id: message.id,
        role: message.role,
        timestamp: time++,
        content: content as never,
      });
    }
    const recordIdByMessageId = new Map<string, string>();
    for (const record of await session.store.readRecords()) {
      if (record.type !== 'message') continue;
      const messageId = (record.payload as { id?: string }).id;
      if (messageId) recordIdByMessageId.set(messageId, record.recordId);
    }
    await session.release();
    return { sessionId: session.conversationId, manager, recordIdByMessageId };
  }

  it('桶校验：同桶可读，拷贝到其它项目桶后以 REFERENCE_PROJECT_MISMATCH 拒绝', async () => {
    const { sessionId, manager } = await createSession([
      { id: 'm1', role: 'user', text: '项目 A 的调研记录' },
    ]);
    const reader = new SessionReferenceReader({ homeDirectory: tmpHome });

    const result = await reader.read({ projectRoot: projectADir, sessionId });
    expect(result.sessionId).toBe(sessionId);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].text).toBe('项目 A 的调研记录');
    expect(result.title).toBe('项目 A 的调研记录');

    // 把正文复制到另一个项目桶，header 身份与请求项目根不一致
    const managerB = new SessionManager({ workspaceRoot: projectBDir, homeDirectory: tmpHome });
    const fileName = fs
      .readdirSync(manager.directory)
      .find((name) => name.endsWith(`_${sessionId}.jsonl`))!;
    fs.copyFileSync(
      path.join(manager.directory, fileName),
      path.join(managerB.directory, fileName),
    );

    await expect(reader.read({ projectRoot: projectBDir, sessionId })).rejects.toMatchObject({
      code: 'REFERENCE_PROJECT_MISMATCH',
    });
    // 跨桶候选列表也不会出现该会话
    expect(await reader.listCandidates({ projectRoot: projectBDir })).toEqual([]);
  });

  it('归档拒绝：已归档会话读取失败且不进入候选列表', async () => {
    const { sessionId, manager } = await createSession([
      { id: 'm1', role: 'user', text: '待归档' },
    ]);
    await manager.archiveSession(sessionId);
    const reader = new SessionReferenceReader({ homeDirectory: tmpHome });

    await expect(reader.read({ projectRoot: projectADir, sessionId })).rejects.toMatchObject({
      code: 'REFERENCE_ARCHIVED',
    });
    expect(await reader.listCandidates({ projectRoot: projectADir })).toEqual([]);
  });

  it('工具剥离：只保留 text 块，工具参数与结果不进入引用，纯工具记录明确报不可见', async () => {
    const { sessionId, recordIdByMessageId } = await createSession([
      { id: 'm1', role: 'user', text: '请检查构建' },
      {
        id: 'm2',
        role: 'assistant',
        text: '我先运行一次构建。',
        toolUse: { id: 'call_1', name: 'run_command' },
      },
      {
        id: 'm3',
        role: 'tool',
        toolResult: { toolUseId: 'call_1', content: 'sensitive_tool_output' },
      },
    ]);
    const reader = new SessionReferenceReader({ homeDirectory: tmpHome });

    const result = await reader.read({ projectRoot: projectADir, sessionId });
    expect(result.records.map((record) => record.role)).toEqual(['user', 'assistant']);
    expect(result.records[1].text).toBe('我先运行一次构建。');
    expect(JSON.stringify(result)).not.toContain('sensitive_tool_output');
    expect(JSON.stringify(result)).not.toContain('run_command');
    expect(result.partial).toContain('tool_blocks_stripped');

    // 显式引用纯工具结果记录：不可见内容按稳定错误码失败
    await expect(
      reader.read({
        projectRoot: projectADir,
        sessionId,
        recordIds: [recordIdByMessageId.get('m3')!],
      }),
    ).rejects.toMatchObject({ code: 'REFERENCE_UNSUPPORTED_ROLE' });
  });

  it('半事务丢弃：未闭合 tool_use 的消息不进入引用，只标记 partial 而不整体失败', async () => {
    const { sessionId, recordIdByMessageId } = await createSession([
      { id: 'm1', role: 'user', text: '开始执行' },
      {
        id: 'm2',
        role: 'assistant',
        text: '正在调用工具',
        toolUse: { id: 'call_open', name: 'run_command' },
      },
    ]);
    const reader = new SessionReferenceReader({ homeDirectory: tmpHome });

    const sessionLevel = await reader.read({ projectRoot: projectADir, sessionId });
    expect(sessionLevel.records.map((record) => record.recordId)).toEqual([
      recordIdByMessageId.get('m1'),
    ]);
    expect(sessionLevel.partial).toContain('unclosed_tool_transaction');

    const explicit = await reader.read({
      projectRoot: projectADir,
      sessionId,
      recordIds: [recordIdByMessageId.get('m2')!],
    });
    expect(explicit.records).toEqual([]);
    expect(explicit.partial).toContain('unclosed_tool_transaction');
  });

  it('裁剪顺序：user 取头部、assistant 取尾部，字符与字节双上限同时生效', async () => {
    const longUser = 'u'.repeat(200);
    const longAssistant = 'a'.repeat(200);
    const { sessionId, recordIdByMessageId } = await createSession([
      { id: 'm1', role: 'user', text: longUser },
      { id: 'm2', role: 'assistant', text: longAssistant },
    ]);
    const reader = new SessionReferenceReader({ homeDirectory: tmpHome });

    const clipped = await reader.read({
      projectRoot: projectADir,
      sessionId,
      maxCharsPerRecord: 50,
    });
    const userRecord = clipped.records.find(
      (record) => record.recordId === recordIdByMessageId.get('m1'),
    )!;
    const assistantRecord = clipped.records.find(
      (record) => record.recordId === recordIdByMessageId.get('m2'),
    )!;
    expect(userRecord.truncated).toBe(true);
    // 裁剪标记与换行计入上限：正文仍保留头部，但总长不得超过 maxCharsPerRecord。
    expect(userRecord.text.startsWith('u')).toBe(true);
    expect(userRecord.text.endsWith('…')).toBe(true);
    expect(userRecord.text).toContain('原文共 200 字符');
    expect(Array.from(userRecord.text).length).toBeLessThanOrEqual(50);
    expect(assistantRecord.truncated).toBe(true);
    expect(assistantRecord.text.startsWith('…')).toBe(true);
    expect(assistantRecord.text.endsWith('a')).toBe(true);
    expect(Array.from(assistantRecord.text).length).toBeLessThanOrEqual(50);

    // CJK：字符数未超 4000，但 UTF-8 字节超过 8000，必须按字节截止且不劈开多字节字符
    const cjk = '汉'.repeat(3000);
    const cjkSession = await createSession([{ id: 'c1', role: 'user', text: cjk }]);
    const cjkResult = await reader.read({
      projectRoot: projectADir,
      sessionId: cjkSession.sessionId,
    });
    expect(cjkResult.records[0].truncated).toBe(true);
    expect(Buffer.byteLength(cjkResult.records[0].text, 'utf8')).toBeLessThan(
      Buffer.byteLength(cjk, 'utf8'),
    );
    expect(cjkResult.records[0].text).not.toContain('\uFFFD');
  });

  it('尾部优先取样：只取最近 N 条可见消息并按时间正序还原', async () => {
    const messages = Array.from({ length: 9 }, (_, index) => ({
      id: `m${index + 1}`,
      role: 'user' as const,
      text: `消息 ${index + 1}`,
    }));
    const { sessionId, recordIdByMessageId } = await createSession(messages);
    const reader = new SessionReferenceReader({ homeDirectory: tmpHome });

    const result = await reader.read({ projectRoot: projectADir, sessionId, limit: 3 });
    expect(result.records.map((record) => record.text)).toEqual(['消息 7', '消息 8', '消息 9']);

    await expect(
      reader.read({ projectRoot: projectADir, sessionId, limit: 0 }),
    ).rejects.toMatchObject({ code: 'REFERENCE_BUDGET_EXCEEDED' });
    await expect(
      reader.read({
        projectRoot: projectADir,
        sessionId,
        recordIds: messages.map((message) => recordIdByMessageId.get(message.id)!),
      }),
    ).rejects.toMatchObject({ code: 'REFERENCE_BUDGET_EXCEEDED' });
    await expect(
      reader.read({ projectRoot: projectADir, sessionId: 'missing-session' }),
    ).rejects.toMatchObject({ code: 'REFERENCE_SESSION_NOT_FOUND' });
  });

  it('默认脱敏：正文中的密钥与 Bearer 令牌在快照阶段被替换', async () => {
    const { sessionId } = await createSession([
      {
        id: 'm1',
        role: 'user',
        text: '配置 api_key=sk-ABCDEF12345 和 Authorization: Bearer tok_987654321 后重试',
      },
    ]);
    const reader = new SessionReferenceReader({ homeDirectory: tmpHome });

    const result = await reader.read({ projectRoot: projectADir, sessionId });
    const text = result.records[0].text;
    expect(text).not.toContain('ABCDEF12345');
    expect(text).not.toContain('tok_987654321');
    expect(text).toContain('[redacted]');
  });

  it('分支摘要：分支级引用消费 branch_summary，未知分支明确失败', async () => {
    const manager = new SessionManager({ workspaceRoot: projectADir, homeDirectory: tmpHome });
    const session = await manager.create();
    await session.store.append({
      id: 'm1',
      role: 'user',
      timestamp: Date.now(),
      content: [{ type: 'text', text: '主线问题' }],
    });
    const leaf = (await session.store.readRecords()).at(-1)!.recordId;
    await session.store.createBranch('research', leaf);
    await session.store.selectBranch('research');
    const summary = await session.store.appendRecord(
      'branch_summary',
      { sourceBranchId: 'main', summary: '分支探索结论：并发压力测试通过' },
      { branchId: 'research' },
    );
    await session.release();
    const reader = new SessionReferenceReader({ homeDirectory: tmpHome });

    const result = await reader.read({
      projectRoot: projectADir,
      sessionId: session.conversationId,
      branchId: 'research',
      recordIds: [summary.recordId],
    });
    expect(result.branchId).toBe('research');
    expect(result.records).toHaveLength(1);
    expect(result.records[0].role).toBe('branch_summary');
    expect(result.records[0].text).toContain('并发压力测试通过');

    await expect(
      reader.read({
        projectRoot: projectADir,
        sessionId: session.conversationId,
        branchId: 'missing-branch',
      }),
    ).rejects.toMatchObject({ code: 'REFERENCE_RECORD_NOT_FOUND' });
  });

  it('候选列表：按最后活动时间倒序并携带标题与消息数', async () => {
    const first = await createSession([{ id: 'a1', role: 'user', text: '较早的会话' }]);
    const second = await createSession([{ id: 'b1', role: 'user', text: '较新的会话' }]);
    const reader = new SessionReferenceReader({ homeDirectory: tmpHome });

    const candidates = await reader.listCandidates({ projectRoot: projectADir });
    expect(candidates.map((item) => item.sessionId)).toEqual([second.sessionId, first.sessionId]);
    expect(candidates[0].title).toBe('较新的会话');
    expect(candidates[0].messageCount).toBe(1);
    expect(candidates[0].delegation).toBe(false);
  });
});
