import type { AgentSession } from '@kiturone/kapibala';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_CATALOG } from '../src/commands/catalog.js';
import { type CommandContext, CommandDispatcher } from '../src/commands/dispatcher.js';
import { mcpCommand } from '../src/commands/mcp.js';
import { promptCommand, promptsCommand } from '../src/commands/prompts.js';
import { CliInputCoordinator } from '../src/input-coordinator.js';
import {
  bindSessionMcpPlugin,
  createCliServerStartAuthorizer,
  resolveCliMcpOptions,
} from '../src/mcp.js';
import { formatToolInvocation } from '../src/ui/tool-presentation.js';

describe('CLI MCP commands and host integration', () => {
  let mockPlugin: any;
  let mockSession: any;
  let mockContext: CommandContext;
  let dispatcher: CommandDispatcher;
  let runPreparedTask: any;

  beforeEach(() => {
    runPreparedTask = vi.fn(async () => {});
    const prompts = [
      {
        stableId: 'doc-server/summarize',
        server: 'doc-server',
        name: 'summarize',
        description: '生成文档摘要',
        arguments: [
          { name: 'path', description: '文件路径', required: true },
          { name: 'format', description: '输出格式', required: false },
        ],
        serverGeneration: 1,
        catalogEpoch: 1,
        contentDigest: 'digest-12345678',
      },
    ];

    mockPlugin = {
      name: 'mcp-ecosystem',
      manager: {
        getAllStatuses: vi.fn(() => [
          {
            name: 'doc-server',
            connectionState: 'ready',
            toolsState: 'ready',
            promptsState: 'ready',
          },
          {
            name: 'calc-server',
            connectionState: 'disabled',
            toolsState: 'unsupported',
            promptsState: 'unsupported',
          },
        ]),
        getServerTools: vi.fn((server: string) =>
          server === 'doc-server'
            ? [
                {
                  name: 'mcp__doc-server__read_doc',
                  description: '读取文档内容',
                  metadata: { readOnlyHint: true },
                },
              ]
            : [],
        ),
        getServerSession: vi.fn((server: string) =>
          server === 'doc-server'
            ? {
                client: {
                  getPrompt: vi.fn(async () => ({
                    description: '摘要模板',
                    messages: [{ role: 'user', content: { type: 'text', text: '请处理此文件' } }],
                  })),
                },
              }
            : undefined,
        ),
        reconnectServer: vi.fn(async () => {}),
        enableServer: vi.fn(async () => {}),
        disableServer: vi.fn(async () => {}),
      },
      promptRegistry: {
        get: vi.fn((id: string) => prompts.find((p) => p.stableId === id)),
        search: vi.fn((query?: string) =>
          query ? prompts.filter((p) => p.stableId.includes(query)) : prompts,
        ),
        getPromptsByServer: vi.fn((server: string) => prompts.filter((p) => p.server === server)),
      },
    };

    mockSession = {
      conversationId: 'sess-123',
      isBusy: vi.fn(() => false),
      assertIdle: vi.fn(),
      use: vi.fn(async () => {}),
      tools: { register: vi.fn() },
      runPreparedTask: vi.fn(async function* () {}),
      getMode: vi.fn(() => 'Approval'),
      getPermissionRules: vi.fn(() => []),
    };

    bindSessionMcpPlugin(mockSession, mockPlugin);

    mockContext = {
      session: mockSession as unknown as AgentSession,
      settings: { defaultModel: 'x', profiles: [] },
      onModelSwitched: () => {},
      onExit: () => {},
      runPreparedTask,
    };

    dispatcher = new CommandDispatcher();
    for (const def of COMMAND_CATALOG) {
      if (def.name === 'mcp') dispatcher.registerDefinition(def, mcpCommand);
      if (def.name === 'prompts') dispatcher.registerDefinition(def, promptsCommand);
      if (def.name === 'prompt') dispatcher.registerDefinition(def, promptCommand);
    }
  });

  it('formats tool invocation for MCP tools with clear namespace and hides sensitive data', () => {
    const formatted = formatToolInvocation('mcp__doc-server__read_file', {
      path: '/docs/api.md',
      apiKey: 'secret-token-xyz',
    });
    expect(formatted).toContain('[MCP: doc-server] read_file');
    expect(formatted).toContain('path=/docs/api.md');
    expect(formatted).not.toContain('secret-token-xyz');
    expect(formatted).toContain('apiKey=[REDACTED]');
  });

  it('rejects server start in non-interactive environment without prior authorization', async () => {
    const coordinator = new CliInputCoordinator();
    const authorizer = createCliServerStartAuthorizer(coordinator, false);
    const decision = await authorizer({
      serverName: 'test-server',
      source: 'global',
      type: 'stdio',
      target: 'node',
      args: ['server.js'],
    });
    expect(decision).toBe('deny_once');
  });

  it('correctly resolves --no-mcp flag to host-disabled state and excludes untrusted project configs', () => {
    const disabled = resolveCliMcpOptions({
      projectRoot: process.cwd(),
      isProjectTrusted: true,
      noMcp: true,
    });
    expect(disabled.enabled).toBe(false);
    expect(disabled.disabledByFlag).toBe(true);

    const untrusted = resolveCliMcpOptions({
      projectRoot: process.cwd(),
      isProjectTrusted: false,
      noMcp: false,
    });
    expect(untrusted.disabledByFlag).toBe(false);
  });

  it('dispatches /mcp status and tools commands without mutation', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await dispatcher.dispatch('/mcp', mockContext);
      expect(mockPlugin.manager.getAllStatuses).toHaveBeenCalled();

      await dispatcher.dispatch('/mcp tools doc-server', mockContext);
      expect(mockPlugin.manager.getServerTools).toHaveBeenCalledWith('doc-server');

      await dispatcher.dispatch('/mcp tools unknown-server', mockContext);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('未知 MCP 服务'));
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('dispatches /mcp reconnect, enable and disable commands for active session', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await dispatcher.dispatch('/mcp reconnect doc-server', mockContext);
      expect(mockPlugin.manager.reconnectServer).toHaveBeenCalledWith('doc-server');

      await dispatcher.dispatch('/mcp disable doc-server', mockContext);
      expect(mockPlugin.manager.disableServer).toHaveBeenCalledWith('doc-server');

      await dispatcher.dispatch('/mcp enable calc-server', mockContext);
      expect(mockPlugin.manager.enableServer).toHaveBeenCalledWith('calc-server');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('rejects mutating commands when session is busy while allowing read-only /mcp query', async () => {
    const busySession = { ...mockSession, isBusy: vi.fn(() => true) };
    bindSessionMcpPlugin(busySession as any, mockPlugin);
    const busyContext: CommandContext = {
      ...mockContext,
      session: busySession as unknown as AgentSession,
    };

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // 只读命令允许执行
      await dispatcher.dispatch('/mcp', busyContext);
      expect(mockPlugin.manager.getAllStatuses).toHaveBeenCalled();

      // 变更命令被 dispatcher 阻断
      await dispatcher.dispatch('/mcp reconnect doc-server', busyContext);
      expect(mockPlugin.manager.reconnectServer).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('searches prompts via /prompts query without network requests', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await dispatcher.dispatch('/prompts summarize', mockContext);
      expect(mockPlugin.promptRegistry.search).toHaveBeenCalledWith('summarize');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('executes /prompt command via runPreparedTask with parsed arguments', async () => {
    await dispatcher.dispatch(
      '/prompt doc-server/summarize {"path": "/docs/readme.md"}',
      mockContext,
    );
    expect(runPreparedTask).toHaveBeenCalledWith(
      '/prompt doc-server/summarize',
      expect.any(Function),
    );
  });

  it('rejects /prompt when required arguments are missing or invalid JSON', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // 缺少必填参数 path
      await dispatcher.dispatch('/prompt doc-server/summarize {"format": "json"}', mockContext);
      expect(runPreparedTask).not.toHaveBeenCalled();

      // 非法 JSON 字符串
      await dispatcher.dispatch('/prompt doc-server/summarize {invalid}', mockContext);
      expect(runPreparedTask).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('rejects /prompt when session is in Plan mode', async () => {
    mockSession.getMode.mockReturnValue('Plan');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await dispatcher.dispatch(
        '/prompt doc-server/summarize {"path": "/docs/readme.md"}',
        mockContext,
      );
      expect(runPreparedTask).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('rejects /prompt when permission rules deny server or external calls', async () => {
    mockSession.getPermissionRules.mockReturnValue([
      { capability: 'external:call', action: 'deny' },
    ]);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await dispatcher.dispatch(
        '/prompt doc-server/summarize {"path": "/docs/readme.md"}',
        mockContext,
      );
      expect(runPreparedTask).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('R27 & R28: /mcp and /prompts strip ANSI in non-TTY mode and sanitize untrusted descriptions', async () => {
    const isTTYOrig = process.stdout.isTTY;
    (process.stdout as any).isTTY = false;
    const logs: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    try {
      mockPlugin.manager.getServerTools.mockReturnValue([
        {
          name: 'mcp__doc-server__evil',
          description: '\x1b[31;1mDanger\x1b[0m injected description',
          metadata: { readOnlyHint: false },
        },
      ]);

      await dispatcher.dispatch('/mcp tools doc-server', mockContext);
      await dispatcher.dispatch('/prompts', mockContext);

      const allOutput = logs.join('\n');
      expect(allOutput).not.toContain('\x1b[');
      expect(allOutput).not.toContain('\x1b]');
      expect(allOutput).toContain('Danger injected description');
    } finally {
      (process.stdout as any).isTTY = isTTYOrig;
      consoleSpy.mockRestore();
    }
  });
});
