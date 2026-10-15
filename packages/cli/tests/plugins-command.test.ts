import type { AgentPlugin, AgentSession } from '@kiturone/kapibala';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_CATALOG } from '../src/commands/catalog.js';
import { type CommandContext, CommandDispatcher } from '../src/commands/dispatcher.js';
import { pluginsCommand } from '../src/commands/plugins.js';
import { bindSessionMcpPlugin } from '../src/mcp.js';

describe('CLI /plugins command and extension contributions', () => {
  let mockSession: any;
  let mockContext: CommandContext;
  let dispatcher: CommandDispatcher;
  let loggedLines: string[];

  beforeEach(() => {
    loggedLines = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      loggedLines.push(args.join(' '));
    });

    const plugins: AgentPlugin[] = [];

    mockSession = {
      isBusy: () => false,
      getPlugins: () => plugins,
    } as unknown as AgentSession;

    mockContext = {
      session: mockSession,
      settings: {} as any,
      onExit: vi.fn(),
      onModelSwitched: vi.fn(),
    };

    dispatcher = new CommandDispatcher();
    const definition = COMMAND_CATALOG.find((c) => c.name === 'plugins')!;
    dispatcher.registerDefinition(definition, pluginsCommand);
  });

  it('提示当前会话未挂载任何插件', async () => {
    await dispatcher.dispatch('/plugins', mockContext);
    expect(loggedLines.some((l) => l.includes('未挂载任何扩展插件'))).toBe(true);
  });

  it('展示已挂载插件列表及其贡献的命令与状态', async () => {
    const fixturePlugin: AgentPlugin = {
      name: 'mcp-ecosystem',
      version: '0.0.6',
      description: 'Model Context Protocol (MCP) ecosystem integration',
      contributes: {
        commands: [
          {
            name: 'mcp',
            description: '查看 MCP 服务状态',
            usage: '/mcp [tools <server>]',
          },
          {
            name: 'prompts',
            description: '搜索提示词模板',
            usage: '/prompts [query]',
          },
        ],
        skillsRoots: ['/path/to/custom-skills'],
      },
      setup: vi.fn(),
    };

    const mockMcpPluginInstance = {
      ...fixturePlugin,
      manager: {
        getAllStatuses: vi.fn(() => [
          {
            name: 'doc-server',
            connectionState: 'ready',
            toolsState: 'ready',
            promptsState: 'ready',
          },
        ]),
        getServerTools: vi.fn(() => [{ name: 'mcp__doc__read' }]),
      },
      promptRegistry: {
        getPromptsByServer: vi.fn(() => []),
      },
    };

    mockSession.getPlugins = () => [fixturePlugin];
    bindSessionMcpPlugin(mockSession, mockMcpPluginInstance as any);

    await dispatcher.dispatch('/plugins', mockContext);

    expect(loggedLines.some((l) => l.includes('当前会话已挂载扩展插件清单'))).toBe(true);
    expect(loggedLines.some((l) => l.includes('mcp-ecosystem'))).toBe(true);
    expect(loggedLines.some((l) => l.includes('/mcp, /prompts'))).toBe(true);
    expect(loggedLines.some((l) => l.includes('1 个 MCP 服务'))).toBe(true);
  });

  it('支持 /plugin 别名并查看特定插件详情', async () => {
    const fixturePlugin: AgentPlugin = {
      name: 'git-tools',
      version: '1.2.0',
      description: 'Advanced git version control workflow tools',
      contributes: {
        commands: [
          {
            name: 'git-status',
            description: '查看当前仓库状态',
            usage: '/git-status',
          },
        ],
        skillsRoots: ['/workspace/skills/git'],
      },
      setup: vi.fn(),
    };

    mockSession.getPlugins = () => [fixturePlugin];

    // 使用 /plugin 别名调用详情
    await dispatcher.dispatch('/plugin git-tools', mockContext);

    expect(
      loggedLines.some(
        (l) => l.includes('扩展插件详情') && l.includes('git-tools') && l.includes('v1.2.0'),
      ),
    ).toBe(true);
    expect(
      loggedLines.some((l) => l.includes('/git-status') && l.includes('查看当前仓库状态')),
    ).toBe(true);
    expect(loggedLines.some((l) => l.includes('/workspace/skills/git'))).toBe(true);
  });

  it('查询未知插件时输出友好提示', async () => {
    mockSession.getPlugins = () => [{ name: 'known-plugin', setup: vi.fn() }];

    await dispatcher.dispatch('/plugins nonexistent', mockContext);

    expect(loggedLines.some((l) => l.includes("未找到扩展插件: 'nonexistent'"))).toBe(true);
  });
});
