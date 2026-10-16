/**
 * @fileoverview MCP Prompt 注册表、参数校验、角色标签降级与受控任务准备测试
 *
 * 覆盖验收：
 * 1. PromptRegistry 发现、元数据搜索（不预取正文）、同名跨 Server 隔离；
 * 2. 严格参数校验：JSON 字符串/字典解析、必填项缺失拒绝、未知参数严格拦截（禁止静默丢弃）；
 * 3. 权限与状态门禁：Plan 模式拒绝、非 ready 状态拒绝；
 * 4. 角色标签降级：messages 转换为带 Role 标签文本，绝不伪造真实 assistant；
 * 5. 必需二进制块拒绝（MCP_PROMPT_UNSUPPORTED）；
 * 6. 最终提交前同步身份复核（verifyIdentity）：目录变更或 epoch 变化零提交并报错 MCP_PROMPT_CHANGED；
 * 7. 接入 Core runPreparedTask：单条 user 消息包含不带 arguments-json 的标识 + promptSource v1；
 * 8. 成功提交派发 mcp_prompt_loaded 事件并写入审计；Store append 失败零加载事件零模型请求。
 */

import {
  AgentSession,
  type CanonicalMessage,
  type ModelProfile,
  type ModelProvider,
  type SessionEvent,
} from '@kiturone/kapibala';
import { describe, expect, it, vi } from 'vitest';
import {
  McpPromptRegistry,
  calculatePromptDigest,
  checkPromptExecutionPermission,
  formatPromptMessagesWithRoleTags,
  prepareMcpPromptTask,
  validatePromptArguments,
} from '../src/index.js';

describe('MCP PromptRegistry & Discovery', () => {
  it('search 应仅根据元数据进行快速检索，绝不获取远端正文', () => {
    const registry = new McpPromptRegistry();

    const digest1 = calculatePromptDigest({
      name: 'code-review',
      description: 'Review code changes against style guide',
      arguments: [{ name: 'pr_id', required: true }],
    });
    const digest2 = calculatePromptDigest({
      name: 'commit-message',
      description: 'Generate concise commit messages',
      arguments: [{ name: 'scope' }],
    });

    registry.replaceServerPrompts('git-server', [
      {
        stableId: 'git-server/code-review',
        server: 'git-server',
        name: 'code-review',
        description: 'Review code changes against style guide',
        arguments: [{ name: 'pr_id', required: true }],
        serverGeneration: 1,
        catalogEpoch: 1,
        contentDigest: digest1,
      },
      {
        stableId: 'git-server/commit-message',
        server: 'git-server',
        name: 'commit-message',
        description: 'Generate concise commit messages',
        arguments: [{ name: 'scope' }],
        serverGeneration: 1,
        catalogEpoch: 1,
        contentDigest: digest2,
      },
    ]);

    expect(registry.size).toBe(2);

    // 搜索匹配
    const searchPr = registry.search('review');
    expect(searchPr.length).toBe(1);
    expect(searchPr[0].stableId).toBe('git-server/code-review');

    // 搜索无匹配
    const searchNone = registry.search('non_existing');
    expect(searchNone.length).toBe(0);

    // 空 query 返回全部
    expect(registry.search().length).toBe(2);
  });

  it('同名 Prompt 跨 Server 隔离，通过 <server>/<name> 明确归属', () => {
    const registry = new McpPromptRegistry();

    registry.replaceServerPrompts('server-a', [
      {
        stableId: 'server-a/summarize',
        server: 'server-a',
        name: 'summarize',
        description: 'Summarize from A',
        serverGeneration: 1,
        catalogEpoch: 1,
        contentDigest: 'digest-a',
      },
    ]);

    registry.replaceServerPrompts('server-b', [
      {
        stableId: 'server-b/summarize',
        server: 'server-b',
        name: 'summarize',
        description: 'Summarize from B',
        serverGeneration: 1,
        catalogEpoch: 1,
        contentDigest: 'digest-b',
      },
    ]);

    expect(registry.size).toBe(2);
    expect(registry.get('server-a/summarize')?.description).toBe('Summarize from A');
    expect(registry.get('server-b/summarize')?.description).toBe('Summarize from B');
    expect(registry.get('unknown/summarize')).toBeUndefined();
  });
});

describe('MCP Prompt Argument & Permission Validation', () => {
  const promptDef = {
    stableId: 'git/create-issue',
    server: 'git',
    name: 'create-issue',
    arguments: [
      { name: 'title', required: true },
      { name: 'body', required: false },
    ],
    serverGeneration: 1,
    catalogEpoch: 1,
    contentDigest: 'dummy-digest',
  };

  it('有效参数通过校验并规范化为字典', () => {
    // JSON 字符串输入
    const res1 = validatePromptArguments(promptDef, '{"title": "Bug fix", "body": "details"}');
    expect(res1.valid).toBe(true);
    if (res1.valid) {
      expect(res1.arguments.title).toBe('Bug fix');
      expect(res1.arguments.body).toBe('details');
    }

    // 对象输入
    const res2 = validatePromptArguments(promptDef, { title: 'New Feature' });
    expect(res2.valid).toBe(true);
    if (res2.valid) {
      expect(res2.arguments.title).toBe('New Feature');
    }
  });

  it('缺失必填参数时严格报错拒绝', () => {
    const res = validatePromptArguments(promptDef, '{"body": "only body"}');
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.error).toContain("Missing required argument 'title'");
      expect(res.code).toBe('MCP_PROMPT_INVALID_ARGUMENTS');
    }
  });

  it('传入未声明的未知参数时严格报错拦截（零静默丢弃）', () => {
    const res = validatePromptArguments(
      promptDef,
      '{"title": "Valid", "extra_injected": "malicious"}',
    );
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.error).toContain("Unknown argument 'extra_injected'");
      expect(res.code).toBe('MCP_PROMPT_INVALID_ARGUMENTS');
    }
  });

  it('Plan 模式或非 ready 状态严格禁止执行 Prompt', () => {
    // Plan 模式拒绝
    const permPlan = checkPromptExecutionPermission('Plan', 'ready', 'git/create-issue');
    expect(permPlan.allowed).toBe(false);
    if (!permPlan.allowed) {
      expect(permPlan.code).toBe('PERMISSION_DENIED');
    }

    // Server 未就绪拒绝
    const permStale = checkPromptExecutionPermission('Auto', 'stale', 'git/create-issue');
    expect(permStale.allowed).toBe(false);
    if (!permStale.allowed) {
      expect(permStale.code).toBe('MCP_SERVER_UNAVAILABLE');
    }

    const permReady = checkPromptExecutionPermission('Auto', 'ready', 'git/create-issue');
    expect(permReady.allowed).toBe(true);
  });
});

describe('MCP Role Tag Degradation & Task Runner', () => {
  it('正确将多条 user/assistant 消息序列转换为带 Role 标签的文本', () => {
    const messages = [
      { role: 'user', content: 'Please review the following code' },
      { role: 'assistant', content: 'Sure, I will check code quality and security.' },
      { role: 'user', content: 'const x = eval(input);' },
    ];

    const text = formatPromptMessagesWithRoleTags(messages, 'Security review prompt');
    expect(text).toContain('[Prompt Description]\nSecurity review prompt');
    expect(text).toContain('Role: user\nPlease review the following code');
    expect(text).toContain('Role: assistant\nSure, I will check code quality and security.');
    expect(text).toContain('Role: user\nconst x = eval(input);');
  });

  it('包含不支持的二进制或图片块时严格抛出 MCP_PROMPT_UNSUPPORTED', () => {
    const messages = [{ role: 'user', content: { type: 'image', data: 'base64...' } }];

    expect(() => formatPromptMessagesWithRoleTags(messages)).toThrow(
      /MCP prompt contains unsupported non-text content block/,
    );
  });

  it('最终提交前若检测到目录或 epoch 发生变化，verifyIdentity 拒绝提交', async () => {
    const promptDef = {
      stableId: 'test/prompt',
      server: 'test',
      name: 'prompt',
      arguments: [],
      serverGeneration: 1,
      catalogEpoch: 1,
      contentDigest: 'digest-v1',
    };

    let currentPromptState = { ...promptDef };

    const mockSession = {
      connectionState: 'ready',
      promptsState: 'ready',
      generation: 1,
      promptsCatalogEpoch: 1,
      client: {
        getPrompt: vi.fn().mockResolvedValue({
          messages: [{ role: 'user', content: 'Run my template' }],
        }),
      },
    } as any;

    const prepared = await prepareMcpPromptTask({
      prompt: promptDef,
      rawArguments: '{}',
      session: mockSession,
      getCurrentPrompt: () => currentPromptState,
    });

    // 状态未变时 verifyIdentity 成功
    expect(prepared.result.verifyIdentity?.()).toBe(true);

    // 模拟后台收到变更通知，epoch 递增
    currentPromptState = {
      ...promptDef,
      catalogEpoch: 2,
      contentDigest: 'digest-v2',
    };

    // 此时提交前复核坚决返回 false（阻止提交）
    expect(prepared.result.verifyIdentity?.()).toBe(false);
  });
});

describe('MCP Prompt End-to-End runPreparedTask & Events Integration', () => {
  const dummyProfile: ModelProfile = {
    id: 'test-model',
    name: 'Test Model',
    provider: 'openai-compatible',
    baseURL: 'http://127.0.0.1:9/v1',
    apiKeyEnv: 'NONE',
    modelName: 'test-model',
    contextWindow: 16384,
  };

  const dummyProvider: ModelProvider = {
    name: 'test-provider',
    create: vi.fn().mockReturnValue(
      (async function* () {
        yield { type: 'text_delta', text: 'Task completed successfully' };
      })(),
    ),
    assembleToolResults: (results) =>
      results.map((r) => ({
        role: 'tool',
        content: [structuredClone(r)],
        timestamp: Date.now(),
      })),
  };

  it('成功准备并提交 Prompt 任务：单条 user 消息带 promptSource，派发 mcp_prompt_loaded 事件', async () => {
    const promptDef = {
      stableId: 'code/review',
      server: 'code',
      name: 'review',
      arguments: [{ name: 'file', required: true }],
      serverGeneration: 1,
      catalogEpoch: 1,
      contentDigest: 'digest-file-review',
    };

    const mockSession = {
      connectionState: 'ready',
      promptsState: 'ready',
      generation: 1,
      promptsCatalogEpoch: 1,
      client: {
        getPrompt: vi.fn().mockResolvedValue({
          description: 'Review code',
          messages: [
            { role: 'user', content: 'Review the file content below' },
            { role: 'assistant', content: 'Understood, inspecting...' },
          ],
        }),
      },
    } as any;

    const prepared = await prepareMcpPromptTask({
      prompt: promptDef,
      rawArguments: JSON.stringify({ file: 'src/main.ts' }),
      userTaskText: 'Please pay extra attention to memory leaks',
      session: mockSession,
      getCurrentPrompt: () => promptDef,
    });

    // 校验命令标识文本不包含 raw json
    expect(prepared.userInput).toContain('/prompt code/review');
    expect(prepared.userInput).toContain('Please pay extra attention to memory leaks');
    expect(prepared.userInput).not.toContain('src/main.ts'); // 参数不在外层命令标识中裸暴露

    // 创建内存 AgentSession 执行 runPreparedTask
    const agentSession = new AgentSession({
      workspaceRoot: process.cwd(),
      defaultProfile: dummyProfile,
      defaultProvider: dummyProvider,
    });

    const receivedEvents: SessionEvent[] = [];
    for await (const event of agentSession.runPreparedTask(
      prepared.userInput,
      async () => prepared.result,
    )) {
      receivedEvents.push(event);
    }

    // 验证派发了 mcp_prompt_loaded 事件
    const loadedEvent = receivedEvents.find((e) => e.type === 'mcp_prompt_loaded');
    expect(loadedEvent).toBeDefined();
    if (loadedEvent && loadedEvent.type === 'mcp_prompt_loaded') {
      expect(loadedEvent.server).toBe('code');
      expect(loadedEvent.name).toBe('review');
      expect(loadedEvent.persistence).toBe('memory');
      expect(loadedEvent.promptSource.contentDigest).toBe('digest-file-review');
    }

    // 验证历史记录中的 user 消息带 promptSource
    const history = agentSession.getHistory();
    const userMessage = history.find((m: CanonicalMessage) => m.role === 'user');
    expect(userMessage).toBeDefined();
    expect(
      userMessage?.content.some((b: any) => b.type === 'text' && b.promptSource?.server === 'code'),
    ).toBe(true);

    await agentSession.destroy();
  });

  it('Store append 失败时零派发 mcp_prompt_loaded 事件且零模型调用', async () => {
    const promptDef = {
      stableId: 'doc/gen',
      server: 'doc',
      name: 'gen',
      serverGeneration: 1,
      catalogEpoch: 1,
      contentDigest: 'digest-doc',
    };

    const mockSession = {
      connectionState: 'ready',
      promptsState: 'ready',
      generation: 1,
      promptsCatalogEpoch: 1,
      client: {
        getPrompt: vi.fn().mockResolvedValue({
          messages: [{ role: 'user', content: 'Generate docs' }],
        }),
      },
    } as any;

    const prepared = await prepareMcpPromptTask({
      prompt: promptDef,
      session: mockSession,
      getCurrentPrompt: () => promptDef,
    });

    const failingStore = {
      append: vi.fn().mockRejectedValue(new Error('Simulated disk write failure')),
      load: vi.fn().mockResolvedValue([]),
      loadHistory: vi.fn().mockResolvedValue([]),
    } as any;

    const mockProvider = {
      name: 'failing-test-provider',
      create: vi.fn(),
      assembleToolResults: (results: any[]) => results,
    };

    const agentSession = new AgentSession({
      workspaceRoot: process.cwd(),
      defaultProfile: dummyProfile,
      defaultProvider: mockProvider as any,
      store: failingStore,
    });

    const receivedEvents: SessionEvent[] = [];
    await expect(async () => {
      for await (const event of agentSession.runPreparedTask(
        prepared.userInput,
        async () => prepared.result,
      )) {
        receivedEvents.push(event);
      }
    }).rejects.toThrow('Simulated disk write failure');

    // 断言：失败时绝对未派发 mcp_prompt_loaded 事件
    expect(receivedEvents.some((e) => e.type === 'mcp_prompt_loaded')).toBe(false);
    // 断言：绝对未发起模型调用
    expect(mockProvider.create).not.toHaveBeenCalled();

    await agentSession.destroy();
  });
});
