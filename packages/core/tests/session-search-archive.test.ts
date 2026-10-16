import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CrossProjectSessionCatalog } from '../src/context/catalog.js';
import { SessionManager } from '../src/context/session-manager.js';
import { MAIN_BRANCH_ID } from '../src/context/session-store.js';
import { KapibalaError } from '../src/errors/index.js';
import type { CanonicalMessage } from '../src/types/index.js';

describe('CrossProjectSessionCatalog & Archive - 跨项目全文检索与逻辑归档', () => {
  let tmpHome: string;
  let projectADir: string;
  let projectBDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-catalog-test-'));
    projectADir = path.join(tmpHome, 'workspace-a');
    projectBDir = path.join(tmpHome, 'workspace-b');
    fs.mkdirSync(projectADir, { recursive: true });
    fs.mkdirSync(projectBDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('跨项目扫描与增量 Sidecar 校验：发现多项目会话，损坏时从正文自动重建', async () => {
    const managerA = new SessionManager({
      workspaceRoot: projectADir,
      homeDirectory: tmpHome,
    });
    const managerB = new SessionManager({
      workspaceRoot: projectBDir,
      homeDirectory: tmpHome,
    });

    const sessionA1 = await managerA.create();
    await sessionA1.store.append({
      id: 'msg-a1',
      role: 'user',
      timestamp: Date.now(),
      content: [{ type: 'text', text: '项目 A 第一个问题' }],
    });
    await sessionA1.release();

    const sessionB1 = await managerB.create();
    await sessionB1.store.append({
      id: 'msg-b1',
      role: 'user',
      timestamp: Date.now() + 10,
      content: [{ type: 'text', text: '项目 B 的调研任务' }],
    });
    await sessionB1.release();

    const catalog = new CrossProjectSessionCatalog({
      homeDirectory: tmpHome,
    });

    // 1. 扫描所有跨项目会话
    const all = await catalog.scanSessions();
    expect(all.length).toBe(2);
    expect(all[0].conversationId).toBe(sessionB1.conversationId); // 时间更新排在前
    expect(all[1].conversationId).toBe(sessionA1.conversationId);

    // 2. 限定 projectRoot 过滤
    const onlyA = await catalog.scanSessions({ projectRoot: projectADir });
    expect(onlyA.length).toBe(1);
    expect(onlyA[0].conversationId).toBe(sessionA1.conversationId);

    // 3. 删除 sessionA1 的 sidecar 缓存，再次扫描依然成功并自动重建
    const sidecarFile = path.join(managerA.directory, `${sessionA1.conversationId}.meta.json`);
    expect(fs.existsSync(sidecarFile)).toBe(true);
    fs.unlinkSync(sidecarFile);
    expect(fs.existsSync(sidecarFile)).toBe(false);

    const reScanned = await catalog.scanSessions({ projectRoot: projectADir });
    expect(reScanned.length).toBe(1);
    expect(reScanned[0].conversationId).toBe(sessionA1.conversationId);
    expect(fs.existsSync(sidecarFile)).toBe(true);

    // 4. 重建 sidecar 后的会话重新打开并追加消息，校验 revision 与 logRevision 保持正确，不抛出 Metadata source mismatch
    const reopened = await managerA.open(sessionA1.conversationId);
    await expect(
      reopened.store.append({
        id: 'msg-a2',
        role: 'user',
        timestamp: Date.now() + 50,
        content: [{ type: 'text', text: '追加第二个问题' }],
      }),
    ).resolves.not.toThrow();
    await reopened.release();
  });

  it('逻辑归档与隔离：活动会话拒绝归档，归档后默认排除，可按需恢复', async () => {
    const manager = new SessionManager({
      workspaceRoot: projectADir,
      homeDirectory: tmpHome,
    });

    const activeSession = await manager.create();
    await activeSession.store.append({
      id: 'msg-act-1',
      role: 'user',
      timestamp: Date.now(),
      content: [{ type: 'text', text: '进行中的会话' }],
    });

    // 1. 活动打开中（持句柄）的会话拒绝归档，抛出 SESSION_IN_USE
    await expect(manager.archiveSession(activeSession.conversationId)).rejects.toThrowError(
      /active or in use/i,
    );

    // 2. 释放句柄后执行归档
    await activeSession.release();
    await manager.archiveSession(activeSession.conversationId);

    // 3. list 默认不包含已归档会话
    const defaultList = await manager.list();
    expect(defaultList.items.length).toBe(0);

    // 显式 includeArchived 可见
    const archivedList = await manager.list(1, { includeArchived: true });
    expect(archivedList.items.length).toBe(1);
    expect(archivedList.items[0].archived).toBe(true);

    // 4. Catalog 扫描默认排除归档会话
    const catalog = new CrossProjectSessionCatalog({
      homeDirectory: tmpHome,
    });
    const catalogDefault = await catalog.scanSessions();
    expect(catalogDefault.length).toBe(0);

    const catalogWithArchived = await catalog.scanSessions({
      includeArchived: true,
    });
    expect(catalogWithArchived.length).toBe(1);

    // 5. 恢复会话
    await manager.restoreSession(activeSession.conversationId);
    const restoredList = await manager.list();
    expect(restoredList.items.length).toBe(1);
    expect(restoredList.items[0].archived).toBe(false);
  });

  it('中文短语与属性限定全文检索：仅匹配可见文本与摘要，支持引号短语与可续答标记', async () => {
    const manager = new SessionManager({
      workspaceRoot: projectADir,
      homeDirectory: tmpHome,
    });

    const session = await manager.create();

    // 用户可见消息
    await session.store.append({
      id: 'msg-1',
      role: 'user',
      timestamp: Date.now(),
      content: [
        {
          type: 'text',
          text: '请帮我实现一个“高性能并发”的调度引擎，保证系统稳定。',
        },
      ],
    });

    // Assistant 可见文本与工具调用
    await session.store.append({
      id: 'msg-2',
      role: 'assistant',
      timestamp: Date.now() + 10,
      content: [
        { type: 'text', text: '好的，我已经为你规划了详细方案。' },
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'bash',
          input: { command: 'echo sensitive_secret_token' },
        },
      ],
    });

    // 紧跟 tool_result 闭合工具事务
    await session.store.append({
      id: 'msg-3',
      role: 'tool',
      timestamp: Date.now() + 15,
      content: [
        {
          type: 'tool_result',
          toolUseId: 'call_1',
          content: 'output containing sensitive_tool_output',
        },
      ],
    });

    // 分支摘要：分支切换后以 branch_summary 记录承载上下文背景
    const leafBeforeFork = (await session.store.readRecords()).at(-1)!.recordId;
    await session.store.createBranch('research-branch', leafBeforeFork);
    await session.store.selectBranch('research-branch');
    await session.store.appendRecord(
      'branch_summary',
      {
        sourceBranchId: MAIN_BRANCH_ID,
        summary: '分支探索上下文：针对高性能并发调度的压力测试结论',
        createdAt: Date.now(),
      },
      { branchId: 'research-branch' },
    );

    await session.release();

    const catalog = new CrossProjectSessionCatalog({
      homeDirectory: tmpHome,
    });

    // 1. 中文短语精确匹配
    const phraseRes = await catalog.search('"高性能并发"');
    expect(phraseRes.hits.length).toBe(2); // user 消息与 branch_summary 各一条
    expect(phraseRes.hits[0].snippet).toContain('高性能并发');

    // 2. 确保绝对不搜索 tool_use 内部参数或敏感凭据，亦不搜索 tool_result 原始输出
    const secretRes = await catalog.search('sensitive_secret_token');
    expect(secretRes.hits.length).toBe(0);
    const toolOutRes = await catalog.search('sensitive_tool_output');
    expect(toolOutRes.hits.length).toBe(0);

    // 3. 分支限定检索
    const branchRes = await catalog.search('高性能并发', {
      branch: 'research-branch',
    });
    expect(branchRes.hits.length).toBe(1);
    expect(branchRes.hits[0].role).toBe('branch_summary');
    expect(branchRes.hits[0].canResume).toBe(true);

    // 4. 可续答边界检查：包含未闭合 tool_use 的 assistant 消息在已闭合后依然可以作为历史展示
    const assistantRes = await catalog.search('规划了详细方案');
    expect(assistantRes.hits.length).toBe(1);
    // 因为随后紧跟了 tool_result，当前叶子已移动，该 assistant 消息已被闭合，若在历史中可作为分叉基线
  });

  it('正则检索与有界限制：支持 re: 正则，病态语法报错，limit 结果截断', async () => {
    const manager = new SessionManager({
      workspaceRoot: projectADir,
      homeDirectory: tmpHome,
    });

    const session = await manager.create();
    for (let i = 1; i <= 5; i++) {
      await session.store.append({
        id: `msg-loop-${i}`,
        role: 'user',
        timestamp: Date.now() + i,
        content: [{ type: 'text', text: `Message item index: ${i * 10}` }],
      });
    }
    await session.release();

    const catalog = new CrossProjectSessionCatalog({
      homeDirectory: tmpHome,
    });

    // 1. 正则语法匹配
    const regexRes = await catalog.search('re:item index:\\s*\\d+');
    expect(regexRes.hits.length).toBe(5);

    // 2. 无效正则语法报错
    await expect(catalog.search('re:[unclosed-group(')).rejects.toThrowError(
      /invalid regular expression/i,
    );

    // 3. 有界数量上限截断
    const limitedRes = await catalog.search('item index', { limit: 2 });
    expect(limitedRes.hits.length).toBe(2);
    expect(limitedRes.isPartial).toBe(true);
    expect(limitedRes.partialReasons).toContain('limit_reached');
  });

  it('ReDoS 防御与搜索整体超时：灾难性回溯被 Worker 隔离终止，单文件及全局 deadline 正确截断', async () => {
    const manager = new SessionManager({
      workspaceRoot: projectADir,
      homeDirectory: tmpHome,
    });

    const session = await manager.create();
    // 写入容易诱发 (a+)+$ 灾难性回溯的脆弱字符串
    await session.store.append({
      id: 'msg-redos-1',
      role: 'user',
      timestamp: Date.now(),
      content: [{ type: 'text', text: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa!' }],
    });
    await session.release();

    const catalog = new CrossProjectSessionCatalog({
      homeDirectory: tmpHome,
    });

    // 1. ReDoS 正则模式：触发 Worker 超时并在 1000ms 左右强制杀线程，主线程安全返回
    const start = Date.now();
    const redosRes = await catalog.search('re:(a+)+$');
    const elapsed = Date.now() - start;

    expect(redosRes.hits.length).toBe(0);
    expect(redosRes.isPartial).toBe(true);
    expect(redosRes.partialReasons).toContain('regex_timeout');
    // 验证确实在有限时间内返回，而不是卡死主事件循环数分钟
    expect(elapsed).toBeLessThan(3000);

    // 2. 搜索整体超时 timeoutMs: 0 验证 search_timeout
    const timeoutRes = await catalog.search('aaaa', { timeoutMs: 0 });
    expect(timeoutRes.isPartial).toBe(true);
    expect(timeoutRes.partialReasons).toContain('search_timeout');
  });
});
