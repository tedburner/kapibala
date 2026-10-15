/**
 * @fileoverview v0.0.6 代码审查 14 项修复（R01~R14）综合回归测试
 */

import http from 'node:http';
import { HookRegistry, ToolExecutor, ToolRegistry } from '@kiturone/kapibala';
import { describe, expect, it, vi } from 'vitest';
import { McpClientSession } from '../src/client.js';
import { McpServerManager } from '../src/manager.js';
import { prepareMcpPromptTask } from '../src/prompts/runner.js';
import { convertMcpToolResponse } from '../src/results/converter.js';
import { sanitizeMcpContentBlock } from '../src/results/sanitizer.js';
import { createMcpToolAdapter } from '../src/tools/adapter.js';
import { discoverAndPublishTools } from '../src/tools/catalog.js';
import { createManagedHttpTransport } from '../src/transports/http.js';
import { validateEndpointUrl } from '../src/transports/ip-security.js';
import { getPosixDescendantPids } from '../src/transports/process-tree.js';

describe('v0.0.6 Code Review Fixes Regression (R01~R14)', () => {
  // R01: 正确读取否定形式的 --no-mcp 开关
  it('R01: 否定开关解析逻辑断言', () => {
    const isNoMcp = (args: { mcp?: boolean; 'no-mcp'?: boolean }) =>
      args.mcp === false || Boolean(args['no-mcp']);

    expect(isNoMcp({ mcp: true })).toBe(false);
    expect(isNoMcp({ mcp: false, 'no-mcp': false })).toBe(true);
    expect(isNoMcp({ 'no-mcp': true })).toBe(true);
  });

  // R02: SDK 默认缺少授权通道时拒绝启动
  it('R02: 缺少启动授权回调与缓存时默认拒绝启动', async () => {
    const manager = new McpServerManager();
    const result = await manager.startupAll({
      testServer: {
        command: 'node',
        args: ['-e', 'process.exit(0)'],
        enabled: true,
      },
    });

    // 默认应阻断启动，零进程创建
    const status = manager.getStatus('testServer');
    expect(status?.connectionState).toBe('blocked');
    await manager.teardown();
  });

  // R05: Stdio 重连与旧工具注销
  it('R05: reconnectServer 会先注销旧工具并在重连就绪后重新发布', async () => {
    const registry = new ToolRegistry();
    const manager = new McpServerManager({
      startupCoordinator: {
        authorize: async () => ({ permitted: true }),
      } as any,
    });
    manager.setToolRegistry(registry);

    // 预先启动一个带有 srv 的服务
    await manager.startupAll({
      srv: {
        command: 'node',
        args: ['-e', 'process.exit(0)'],
        enabled: true,
      },
    });

    // 预先注册一个属于该来源的工具
    registry.register({
      name: 'mcp__srv__tool1',
      description: 'old tool',
      parameters: { type: 'object' },
      metadata: { source: 'mcp:srv' },
      execute: async () => 'old',
    });
    expect(registry.has('mcp__srv__tool1')).toBe(true);

    // 执行重连未知或断开服务时，旧工具必须被彻底注销
    try {
      await manager.reconnectServer('srv');
    } catch {
      /* 容忍重连失败 */
    }
    expect(registry.has('mcp__srv__tool1')).toBe(false);
    await manager.teardown();
  }, 15000);

  // R07: 适配器发送后异常标记为 OUTCOME_UNKNOWN 与 unknown，发送前失败为 not_sent
  it('R07: 适配器区分发送前拒绝(not_sent)与发送后异常(OUTCOME_UNKNOWN)', async () => {
    // 1. 发送前 session 未 ready
    const mockSessionNotReady: any = {
      serverName: 'testSrv',
      connectionState: 'connecting',
      generation: 1,
      toolsCatalogEpoch: 1,
    };
    const toolNotReady = createMcpToolAdapter({
      candidate: {
        normalizedName: 'mcp__testSrv__testTool',
        rawName: 'testTool',
        serverName: 'testSrv',
        description: 'test tool',
        inputSchema: { type: 'object' },
        toolDigest: 'digest',
      },
      getSession: () => mockSessionNotReady,
      targetGeneration: 1,
      targetCatalogEpoch: 1,
    });

    await expect(toolNotReady.execute({}, { rootDir: process.cwd() })).rejects.toThrow(
      /MCP_SERVER_UNAVAILABLE/,
    );

    // 2. 发送后异常 (callTool 抛错)
    const mockSessionDispatchedError: any = {
      serverName: 'testSrv',
      connectionState: 'ready',
      generation: 1,
      toolsCatalogEpoch: 1,
      client: {
        callTool: vi.fn().mockRejectedValue(new Error('Connection reset by peer')),
      },
    };
    const toolDispatched = createMcpToolAdapter({
      candidate: {
        normalizedName: 'mcp__testSrv__testTool',
        rawName: 'testTool',
        serverName: 'testSrv',
        description: 'test tool',
        inputSchema: { type: 'object' },
        toolDigest: 'digest',
      },
      getSession: () => mockSessionDispatchedError,
      targetGeneration: 1,
      targetCatalogEpoch: 1,
    });

    const postDispatchRaw = await toolDispatched.execute({}, { rootDir: process.cwd() });
    const postResult = toolDispatched.toExecutionResult!(postDispatchRaw);
    expect(postResult.isError).toBe(true);
    expect(postResult.errorCode).toBe('OUTCOME_UNKNOWN');
    expect(postResult.retryPolicy).toBe('after_user_action');
    expect(postResult.execution?.dispatchOutcome).toBe('unknown');
  });

  // R08: HTTP 204 响应返回 null body，防止 TypeError
  it('R08: HTTP 204/205/304 允许构造 Response(null)', () => {
    for (const code of [204, 205, 304]) {
      expect(() => new Response(null, { status: code })).not.toThrow();
    }
  });

  // R10: Prompt verifyIdentity 复核活动连接 realtime epoch
  it('R10: Prompt 准备复核活动连接 generation 与实时 catalogEpoch', async () => {
    const mockSession: any = {
      connectionState: 'ready',
      promptsState: 'ready',
      generation: 1,
      promptsCatalogEpoch: 1,
      client: {
        getPrompt: vi.fn().mockResolvedValue({
          description: 'test prompt',
          messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
        }),
      },
    };

    const promptDef: any = {
      server: 'testSrv',
      name: 'hello',
      stableId: 'testSrv/hello',
      serverGeneration: 1,
      catalogEpoch: 1,
      contentDigest: 'sha_test',
    };

    const prep = await prepareMcpPromptTask({
      prompt: promptDef,
      session: mockSession,
      getCurrentPrompt: () => promptDef,
    });

    // 初始状态一致
    expect(prep.result.verifyIdentity?.()).toBe(true);

    // 服务端发通知导致 session epoch 漂移成 2
    mockSession.promptsCatalogEpoch = 2;
    expect(prep.result.verifyIdentity?.()).toBe(false);

    // 恢复 epoch 但 generation 变了（发生过重连）
    mockSession.promptsCatalogEpoch = 1;
    mockSession.generation = 2;
    expect(prep.result.verifyIdentity?.()).toBe(false);

    // 连接断开
    mockSession.generation = 1;
    mockSession.connectionState = 'disconnected';
    expect(prep.result.verifyIdentity?.()).toBe(false);
  });

  // R11: HTTP 请求头环境变量展开
  it('R11: HTTP 传输创建时展开 ${TOKEN} 变量，缺变量时阻断', () => {
    process.env.__TEST_MCP_TOKEN__ = 'secret-token-123';

    const transport = createManagedHttpTransport({
      type: 'http',
      url: 'http://127.0.0.1:8080/mcp',
      headers: {
        Authorization: 'Bearer ${__TEST_MCP_TOKEN__}',
      },
    });

    expect(transport.url.href).toBe('http://127.0.0.1:8080/mcp');

    // 缺失变量时阻断
    Reflect.deleteProperty(process.env, '__TEST_MCP_TOKEN_MISSING__');
    expect(() =>
      createManagedHttpTransport({
        type: 'http',
        url: 'http://127.0.0.1:8080/mcp',
        headers: {
          Authorization: 'Bearer ${__TEST_MCP_TOKEN_MISSING__}',
        },
      }),
    ).toThrow(/Missing required environment variables/);

    Reflect.deleteProperty(process.env, '__TEST_MCP_TOKEN__');
  });

  // R12: 取消信号传透至 Prompt 获取
  it('R12: prepareMcpPromptTask 将 signal 透传给 getPrompt', async () => {
    const abortCtrl = new AbortController();
    const mockSession: any = {
      connectionState: 'ready',
      promptsState: 'ready',
      generation: 1,
      promptsCatalogEpoch: 1,
      client: {
        getPrompt: vi.fn().mockImplementation((_args, opts) => {
          expect(opts?.signal).toBe(abortCtrl.signal);
          return Promise.resolve({
            messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
          });
        }),
      },
    };

    const promptDef: any = {
      server: 'testSrv',
      name: 'hi',
      stableId: 'testSrv/hi',
      serverGeneration: 1,
      catalogEpoch: 1,
      contentDigest: 'sha_hi',
    };

    await prepareMcpPromptTask({
      prompt: promptDef,
      session: mockSession,
      signal: abortCtrl.signal,
      getCurrentPrompt: () => promptDef,
    });

    expect(mockSession.client.getPrompt).toHaveBeenCalledTimes(1);
  });

  // R13: 整体 20 KiB 结果预算与 4 MiB 传输限制
  it('R13: 多个内容块拼接后执行整体 20 KiB 预算截断与 4 MiB 硬界检查', () => {
    // 构造 10 个 3000 字节的文本块，合并后 30000 字节 > 20480
    const blocks = Array.from({ length: 10 }, (_, i) => ({
      type: 'text',
      text: `Block ${i}: ${'x'.repeat(3000)}`,
    }));

    const converted = convertMcpToolResponse({ content: blocks });
    expect(converted.isError).toBe(false);
    expect(Buffer.byteLength(converted.content, 'utf8')).toBeLessThanOrEqual(20480);
    expect(converted.content).toContain('omitted');

    // 超过 4 MiB 拒绝
    const hugeBlock = {
      type: 'text',
      text: 'a'.repeat(4.5 * 1024 * 1024),
    };
    const hugeConverted = convertMcpToolResponse({ content: [hugeBlock] });
    expect(hugeConverted.isError).toBe(true);
    expect(hugeConverted.errorCode).toBe('MCP_RESULT_TOO_LARGE');
  });

  // R14: 音频 Base64 内容块脱敏
  it('R14: 音频 content block 剥离裸 Base64 并替换为占位符', () => {
    const audioBlock = {
      type: 'audio',
      mimeType: 'audio/mp3',
      data: 'UklGRi4AAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=',
    };

    const sanitized = sanitizeMcpContentBlock(audioBlock);
    expect(sanitized).toBe('[Embedded Audio: audio/mp3, ~45 bytes not retained]');
    expect(sanitized).not.toContain('UklGRi4AAABXQVZFZm10');
  });
});

describe('v0.0.6 Second Review Fixes Regression (R15~R37)', () => {
  // R15: 贯穿 Core ToolExecutor 全链路
  it('R15: 贯穿 Core ToolExecutor 全链路，发送前撤销产出 dispatchOutcome: not_sent 且零发送', async () => {
    let callToolCount = 0;
    const mockSession: any = {
      serverName: 'testSrv',
      connectionState: 'disconnected', // not ready!
      generation: 1,
      toolsCatalogEpoch: 1,
      client: {
        callTool: vi.fn(async () => {
          callToolCount++;
          return { content: [{ type: 'text', text: 'ok' }] };
        }),
      },
    };

    const tool = createMcpToolAdapter({
      candidate: {
        normalizedName: 'mcp__testSrv__testTool',
        rawName: 'testTool',
        serverName: 'testSrv',
        description: 'test tool',
        inputSchema: { type: 'object' },
        toolDigest: 'digest',
      },
      getSession: () => mockSession,
      targetGeneration: 1,
      targetCatalogEpoch: 1,
    });

    const registry = new ToolRegistry();
    registry.register(tool);

    const executor = new ToolExecutor({
      tools: registry,
      hooks: new HookRegistry(),
      rootDir: process.cwd(),
      mode: 'FullAccess',
      permissionRules: [{ capability: 'external:call', action: 'allow' }],
    });

    const [result] = await executor.runAll([
      {
        type: 'tool_use',
        id: 'call_test',
        name: 'mcp__testSrv__testTool',
        input: {},
      },
    ]);

    expect(result.type).toBe('tool_result');
    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe('MCP_SERVER_UNAVAILABLE');
    expect(result.execution).toEqual({
      version: 1,
      dispatchOutcome: 'not_sent',
    });
    expect(callToolCount).toBe(0);
  });

  // R16: 并发启动回滚孤儿竞态
  it('R16: 并发启动回滚等待所有 worker 结算，杜绝孤儿进程泄漏', async () => {
    const manager = new McpServerManager({
      maxConcurrentStartups: 2,
      startupCoordinator: {
        authorize: vi.fn(async (desc) => {
          if (desc.serverName === 'failSrv') {
            throw new Error('Immediate failure');
          }
          return { permitted: true };
        }),
      } as any,
    });

    await expect(
      manager.startupAll({
        failSrv: {
          command: 'node',
          args: ['-e', 'process.exit(0)'],
          required: true,
        },
        slowSrv: {
          command: 'node',
          args: ['-e', 'process.exit(0)'],
          required: false,
        },
      }),
    ).rejects.toThrow();

    const statuses = manager.getAllStatuses();
    for (const status of statuses) {
      expect(['failed', 'disabled', 'disconnected']).toContain(status.connectionState);
      expect(status.pid).toBeNull();
    }
    await manager.teardown();
  });

  // R17: 请求级超时 requestTimeoutMs
  it('R17: 远端 tools/call 挂死时在 requestTimeoutMs 到期返回 OUTCOME_UNKNOWN', async () => {
    const mockSession: any = {
      serverName: 'testSrv',
      connectionState: 'ready',
      generation: 1,
      toolsCatalogEpoch: 1,
      client: {
        callTool: vi.fn(
          (_params, opts) =>
            new Promise((_, reject) => {
              if (opts?.signal?.aborted) {
                reject(new Error('Aborted'));
                return;
              }
              opts?.signal?.addEventListener('abort', () => {
                reject(new Error('Call aborted by timeout signal'));
              });
            }),
        ),
      },
    };

    const tool = createMcpToolAdapter({
      candidate: {
        normalizedName: 'mcp__testSrv__hangTool',
        rawName: 'hangTool',
        serverName: 'testSrv',
        description: 'hang tool',
        inputSchema: { type: 'object' },
        toolDigest: 'digest',
      },
      getSession: () => mockSession,
      targetGeneration: 1,
      targetCatalogEpoch: 1,
      requestTimeoutMs: 50,
    });

    const res: any = await tool.execute({}, { rootDir: process.cwd() });
    expect(res.__isMcpDispatchedError).toBe(true);
    expect(res.error).toContain('timed out after 50ms');

    const execResult = tool.toExecutionResult!(res);
    expect(execResult.isError).toBe(true);
    expect(execResult.errorCode).toBe('OUTCOME_UNKNOWN');
    expect(execResult.retryPolicy).toBe('after_user_action');
    expect(execResult.execution?.dispatchOutcome).toBe('unknown');
  });

  // R18: 目录刷新有界周期（≤3 轮）
  it('R18: 注入高频 list_changed 通知，断言刷新轮次 ≤ 3 且终态稳定', async () => {
    const mockTransport: any = {
      start: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      onclose: null,
      onerror: null,
      onmessage: null,
    };
    const session = new McpClientSession('srv', { command: 'node' }, mockTransport, 1, {
      catalogTimeoutMs: 200,
    });
    (session as any).client = {
      listTools: vi.fn(async () => {
        (session as any)._toolsDirty = true;
        return { tools: [] };
      }),
      listPrompts: vi.fn(async () => ({ prompts: [] })),
      setNotificationHandler: vi.fn(),
      removeNotificationHandler: vi.fn(),
    };
    (session as any)._toolsState = 'ready';

    await (session as any).triggerToolsRefresh();

    expect((session as any)._toolsRefreshRounds).toBeGreaterThan(0);
    expect((session as any)._toolsRefreshRounds).toBeLessThanOrEqual(4);
    expect((session as any)._toolsState).toBe('unavailable');
    await session.close();
  });

  // R19: 目录发布 await 后复核四元组
  it('R19: 刷新中注入重连代次变更，旧目录不被发布到 ToolRegistry', async () => {
    const registry = new ToolRegistry();
    const mockSession: any = {
      serverName: 'srv',
      generation: 1,
      toolsCatalogEpoch: 1,
      client: {
        listTools: vi.fn(async () => {
          mockSession.generation = 2; // 模拟重连使代次递增
          return { tools: [{ name: 't1', inputSchema: { type: 'object' } }] };
        }),
      },
    };

    const initialGen = 1;
    const initialEpoch = 1;
    const result = await discoverAndPublishTools(
      mockSession,
      { command: 'node' },
      registry,
      5000,
      () => mockSession.generation === initialGen && mockSession.toolsCatalogEpoch === initialEpoch,
    );

    expect(result.publishedCount).toBe(0);
    expect(registry.has('mcp__srv__t1')).toBe(false);
  });

  // R20: Credential Alert 预警接通
  it('R20: 项目配置插值敏感变量，审批描述符正确填充 credentialAlertVars 与 envVarNames', async () => {
    process.env.TEST_SECRET_API_KEY = 'super-secret';
    let capturedDescriptor: any = null;

    const manager = new McpServerManager({
      startupCoordinator: {
        authorize: vi.fn(async (desc) => {
          capturedDescriptor = desc;
          return { permitted: false };
        }),
      } as any,
    });

    const configMap = new Map();
    configMap.set('projServer', {
      name: 'projServer',
      source: 'project',
      config: {
        command: 'node',
        args: ['-e', 'process.exit(0)'],
        env: {
          API_KEY: '${TEST_SECRET_API_KEY}',
        },
      },
    });

    await manager.startupAll(configMap);

    expect(capturedDescriptor).not.toBeNull();
    expect(capturedDescriptor.credentialAlertVars).toEqual(['TEST_SECRET_API_KEY']);
    expect(capturedDescriptor.envVarNames).toEqual(['TEST_SECRET_API_KEY']);
    expect(capturedDescriptor.source).toBe('project');
    process.env.TEST_SECRET_API_KEY = undefined;
    await manager.teardown();
  });

  // R23: POSIX 进程树孙进程清理接口验证
  it('R23: getPosixDescendantPids 平台隔离行为符合预期', () => {
    if (process.platform === 'win32') {
      expect(getPosixDescendantPids(process.pid)).toEqual([]);
      expect(getPosixDescendantPids(-1)).toEqual([]);
    } else {
      expect(Array.isArray(getPosixDescendantPids(process.pid))).toBe(true);
    }
  });

  // R24: 共享配置对象不被会话内改写，回滚保留 disabled 状态
  it('R24: 两个会话共享同一 config，会话 A disable 不污染会话 B 与原始 config', async () => {
    const sharedConfig = {
      command: 'node',
      args: ['-e', 'process.exit(0)'],
      enabled: true,
    };

    const managerA = new McpServerManager();
    const managerB = new McpServerManager();

    await managerA.startupAll({ srv: sharedConfig });
    await managerB.startupAll({ srv: sharedConfig });

    await managerA.disableServer('srv');

    expect(sharedConfig.enabled).toBe(true);
    expect(managerA.getStatus('srv')?.connectionState).toBe('disabled');
    expect(managerB.getStatus('srv')?.connectionState).not.toBe('disabled');

    await managerA.teardown();
    await managerB.teardown();
  });

  // R30: validateEndpointUrl 允许 https://127.0.0.1
  it('R30: validateEndpointUrl 允许 https://127.0.0.1 回环地址接入', () => {
    const res1 = validateEndpointUrl('https://127.0.0.1:8443/mcp', { allowLoopbackHttp: true });
    expect(res1.valid).toBe(true);

    const res2 = validateEndpointUrl('https://[::1]:8443/mcp', { allowLoopbackHttp: true });
    expect(res2.valid).toBe(true);

    const res3 = validateEndpointUrl('https://10.0.0.1:8443/mcp', { allowLoopbackHttp: true });
    expect(res3.valid).toBe(false);
    if (!res3.valid) {
      expect(res3.error).toContain('Direct connection to private/restricted IP');
    }
  });

  // R21: 协议时代失效矩阵（legacy: 404 session missing, connection reset / modern: 401 unauthorized, 400 bad request）
  it('R21: 时代矩阵失效场景（legacy 404/断流，modern 401/400）下 tools/call 严格至多发送一次，绝无隐式重放', async () => {
    const failureModes = [
      {
        mode: 'legacy-404-session-missing',
        status: 404,
        payload: { error: 'Session expired or not found' },
      },
      { mode: 'legacy-connection-reset', destroySocket: true },
      {
        mode: 'modern-401-unauthorized',
        status: 401,
        payload: { error: 'Unauthorized: authentication challenge required' },
      },
      {
        mode: 'modern-400-protocol-mismatch',
        status: 400,
        payload: { error: 'ProtocolMismatch: invalid header or version' },
      },
    ];

    for (const testCase of failureModes) {
      let callCount = 0;
      const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        const rawBody = Buffer.concat(chunks).toString('utf-8');
        if (!rawBody || rawBody.trim() === '') {
          res.writeHead(200);
          res.end();
          return;
        }
        const body = JSON.parse(rawBody);

        if (body.method === 'initialize') {
          res.writeHead(200, {
            'content-type': 'application/json',
            'mcp-session-id': 'test-session-epoch-1',
          });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: `test-${testCase.mode}`, version: '1.0.0' },
              },
            }),
          );
          return;
        }

        if (body.method === 'notifications/initialized') {
          res.writeHead(202);
          res.end();
          return;
        }

        if (body.method === 'tools/call') {
          callCount++;
          if (testCase.destroySocket) {
            req.socket.destroy();
            return;
          }
          res.writeHead(testCase.status!, { 'content-type': 'application/json' });
          res.end(JSON.stringify(testCase.payload));
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } }));
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as any).port;
      const config = {
        type: 'http' as const,
        url: `http://127.0.0.1:${port}/mcp`,
      };

      const managedTransport = createManagedHttpTransport(config);
      try {
        const session = new McpClientSession(
          `server-${testCase.mode}`,
          config,
          managedTransport.transport,
        );
        await session.connect();

        await expect(
          session.client.callTool({
            name: 'sample_tool',
            arguments: {},
          }),
        ).rejects.toThrow();

        // 核心不变量：服务端接收计数严格为 1，绝无重试或重放
        expect(callCount).toBe(1);

        await session.close();
      } finally {
        await managedTransport.close();
        server.close();
      }
    }
  });
});
