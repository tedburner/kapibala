import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  PresentationState,
  ViewEvidence,
  ViewExternalSnapshot,
  ViewExternalTransport,
  ViewMessage,
} from '@kiturone/kapibala-host/view-model';
import * as React from 'react';
import { type FunctionComponent, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildExternalSessionKey,
  buildNativeSessionKey,
  parseSessionKey,
  projectExternalThread,
  projectNativeThread,
} from '../src/renderer/adapters/unified-thread.js';
import {
  buildDraftScopeKey,
  createSessionStore,
  createSettingsStore,
  createShellStore,
  createWorkspaceStore,
  selectEnabledHarnesses,
  selectInboxItems,
  selectSessionWorkbench,
  selectWorkspaceHierarchy,
} from '../src/renderer/stores/index.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.resolve(currentDir, '../src/renderer');

interface LoadedSurfaces {
  readonly AppShell: FunctionComponent<Record<string, unknown>>;
  readonly NavigationRail: FunctionComponent<Record<string, unknown>>;
  readonly InboxSection: FunctionComponent<Record<string, unknown>>;
  readonly WorkspaceTree: FunctionComponent<Record<string, unknown>>;
  readonly CommandPalette: FunctionComponent<Record<string, unknown>>;
  readonly LaunchpadView: FunctionComponent<Record<string, unknown>>;
  readonly dispatchAppShellShortcut: (
    event: {
      readonly key: string;
      readonly metaKey?: boolean;
      readonly ctrlKey?: boolean;
      readonly altKey?: boolean;
      readonly shiftKey?: boolean;
      readonly isEditableTarget?: boolean;
      readonly hasOpenNativeModalOrPopover?: boolean;
      preventDefault?: () => void;
    },
    ctx: {
      readonly viewportWidth: number;
      readonly activeSurface: 'workspace' | 'settings';
      readonly activeSessionKey: string | null;
      readonly topApproval?: {
        readonly id: string;
        readonly actions: readonly {
          readonly id: string;
          readonly shortcutHint?: 'Y' | 'S' | 'N';
        }[];
      };
      readonly onToggleCommandPalette: () => void;
      readonly onToggleSettings: () => void;
      readonly onToggleRail: (viewportWidth: number) => void;
      readonly onToggleWorkbench: (sessionKey: string) => void;
      readonly onNewConversation: () => void;
      readonly onActivateWorkbenchTab: (sessionKey: string, index: number) => void;
      readonly onApprovalShortcut?: (approvalId: string, actionId: string) => void;
      readonly onEscapeLayer: () => boolean;
    },
  ) => boolean;
  readonly resolveViewportTier: (width: number) => 'standard' | 'compact' | 'minimal';
}

let surfaces: LoadedSurfaces;

beforeAll(async () => {
  /* Node vitest 下挂载全局 React 绑定以供 esbuild classic JSX 编译的渲染层组件执行 SSR。 */
  (globalThis as Record<string, unknown>).React = React;
  const shellPath: string = '../src/renderer/surfaces/shell/index.js';
  const launchpadPath: string = '../src/renderer/surfaces/launchpad/index.js';
  const shellMod = (await import(shellPath)) as Omit<LoadedSurfaces, 'LaunchpadView'>;
  const launchpadMod = (await import(launchpadPath)) as Pick<LoadedSurfaces, 'LaunchpadView'>;
  surfaces = { ...shellMod, LaunchpadView: launchpadMod.LaunchpadView };
});

describe('UnifiedThread 适配器：本地与四类外部代理会话同构投影（017 §5.2）', () => {
  const sampleMessages: readonly ViewMessage[] = [
    {
      id: 'm-user-1',
      role: 'user',
      state: 'completed',
      persisted: true,
      blocks: [
        {
          id: 'b-skill',
          kind: 'text',
          text: '<skill_content>',
          state: 'completed',
          revision: 1,
          skillName: 'hunt',
        },
        {
          id: 'b-u1',
          kind: 'text',
          text: '修复权限网关并输出预览图',
          state: 'completed',
          revision: 1,
        },
      ],
    },
    {
      id: 'm-asst-1',
      role: 'assistant',
      state: 'completed',
      persisted: true,
      usage: { promptTokens: 1200, completionTokens: 300, totalTokens: 1500 },
      blocks: [
        {
          id: 'b-think-1',
          kind: 'thinking',
          text: '先修改 gate.ts 再生成 HTML 报告与委派单测',
          state: 'completed',
          revision: 2,
        },
        {
          id: 'b-tool-edit',
          kind: 'tool',
          text: '',
          state: 'completed',
          revision: 3,
          tool: {
            callId: 'call-edit-1',
            name: 'edit_file',
            displayName: '编辑文件',
            invocation: 'edit_file packages/core/src/gate.ts',
            verb: '编辑',
            chip: '/repo/kapibala/packages/core/src/gate.ts',
            mono: true,
            input: JSON.stringify({ path: '/repo/kapibala/packages/core/src/gate.ts' }),
            status: 'succeeded',
            durationMs: 45,
          },
        },
        {
          id: 'b-tool-html',
          kind: 'tool',
          text: '',
          state: 'completed',
          revision: 4,
          tool: {
            callId: 'call-html-1',
            name: 'write_file',
            displayName: '写入文件',
            invocation: 'write_file report.html',
            chip: '/repo/kapibala/docs/report.html',
            mono: true,
            input: JSON.stringify({
              path: '/repo/kapibala/docs/report.html',
              content: '<h1>Report</h1>',
            }),
            status: 'succeeded',
            durationMs: 30,
          },
        },
        {
          id: 'b-tool-img',
          kind: 'tool',
          text: '',
          state: 'completed',
          revision: 5,
          tool: {
            callId: 'call-img-1',
            name: 'generate_chart',
            displayName: '生成图表',
            invocation: 'generate_chart arch.png',
            input: '{}',
            status: 'succeeded',
            durationMs: 120,
            artifacts: [
              { kind: 'image', path: '/repo/kapibala/out/arch.png', ext: 'png', size: 2048 },
            ],
          },
        },
        {
          id: 'b-tool-delegate',
          kind: 'tool',
          text: '',
          state: 'completed',
          revision: 6,
          tool: {
            callId: 'call-spawn-1',
            name: 'spawn_agent',
            displayName: '委派任务',
            invocation: 'spawn_agent Sandbox Tester',
            input: JSON.stringify({ role: 'Sandbox Tester', description: '补齐沙箱单测' }),
            result: JSON.stringify({ childSessionId: 'conv-child-99' }),
            status: 'succeeded',
            durationMs: 600,
          },
        },
        {
          id: 'b-tool-cmd',
          kind: 'tool',
          text: '',
          state: 'completed',
          revision: 7,
          tool: {
            callId: 'call-cmd-1',
            name: 'run_command',
            displayName: '运行命令',
            invocation: 'pnpm test',
            chip: 'pnpm test',
            mono: true,
            input: JSON.stringify({ command: 'pnpm test' }),
            status: 'succeeded',
            durationMs: 850,
          },
        },
      ],
    },
    {
      id: 'm-asst-2',
      role: 'assistant',
      state: 'completed',
      persisted: true,
      usage: { promptTokens: 1600, completionTokens: 200, totalTokens: 1800 },
      turnMeta: {
        agentName: 'Kapibala',
        modelLabel: 'Claude Sonnet',
        effortLabel: 'High',
        modeLabel: 'Approval',
      },
      blocks: [
        {
          id: 'b-prose-1',
          kind: 'text',
          text: '已完成修复，示例组件如下：\n```html\n<div class="demo">OK</div>\n```',
          state: 'completed',
          revision: 8,
        },
      ],
    },
  ];

  const sampleEvidence: ViewEvidence = {
    summary: {
      additions: 42,
      deletions: 15,
      truncatedFiles: 0,
      missingFiles: 0,
      references: 1,
      mcpCalls: 0,
      mcpFailures: 0,
      runningDelegations: 0,
    },
    changes: [
      {
        path: '/repo/kapibala/packages/core/src/gate.ts',
        callId: 'call-edit-1',
        status: 'recorded',
        additions: 42,
        deletions: 15,
      },
    ],
    references: [],
    mcp: [],
    delegations: [
      {
        sessionId: 'conv-child-99',
        title: '补齐沙箱单测',
        taskName: 'Sandbox Tester',
        state: 'finished',
        summary: '全部通过',
        lastActivityAt: 1_700_000_100_000,
      },
    ],
  };

  it('projectNativeThread 准确归并思考与工具组、映射 Diff/Preview/Delegation/Inspector 目标并剥离审批首屏绝对路径', () => {
    const presentation: PresentationState = {
      identity: { conversationId: 'conv-1', branchId: 'main', viewEpoch: 1 },
      sequence: 12,
      messages: sampleMessages,
      pendingMessages: [],
      order: sampleMessages.map((m) => m.id),
      operation: { id: 'op-1', phase: 'running' },
      expanded: { 'b-think-1': true },
      notices: [],
      todos: {
        revision: 2,
        items: [
          { id: 't1', title: '重构网关', status: 'completed' },
          { id: 't2', title: '跑回归', status: 'in_progress' },
        ],
      },
      retryStatus: {
        step: 2,
        attempt: 1,
        maxRetries: 3,
        delayMs: 2000,
        nextRetryAt: 1_700_000_200_000,
        category: 'rate_limit',
        message: '触发限流，2s 后重试',
      },
    };

    const vm = projectNativeThread({
      workspaceId: 'ws-main',
      workspaceName: 'kapibala',
      workspaceRoot: '/repo/kapibala',
      sessionId: 'sess-native-1',
      conversationId: 'conv-1',
      title: '重构权限网关',
      presentation,
      evidence: sampleEvidence,
      activeWatchesCount: 2,
      worktree: { id: 'wt-1', branch: 'wt/auth', worktreePath: '/repo/kapibala.wt/auth' },
      approvals: [
        {
          workspaceId: 'ws-main',
          workspaceName: 'kapibala',
          workspaceRoot: '/repo/kapibala',
          sessionId: 'sess-native-1',
          conversationId: 'conv-1',
          approvalId: 'ap-native-1',
          runId: 'run-uuid-1234',
          toolName: 'run_command',
          capabilities: ['workspace-write'],
          description: 'pnpm --prefix /repo/kapibala/packages/core test',
          sessionAllowed: true,
          expiresAt: 1_700_000_500_000,
        },
        {
          workspaceId: 'ws-main',
          workspaceName: 'kapibala',
          workspaceRoot: '/repo/kapibala',
          sessionId: 'sess-child-1',
          conversationId: 'conv-child-99',
          approvalId: 'ap-sub-2',
          runId: 'run-uuid-5678',
          toolName: 'write_file',
          capabilities: ['workspace-write'],
          description: '/repo/kapibala/packages/core/tests/gate.test.ts',
          sessionAllowed: false,
          expiresAt: 1_700_000_600_000,
          subagentOrigin: {
            agentId: 'agent-99',
            role: 'Sandbox Tester',
            description: '补齐沙箱单测',
            childSessionId: 'conv-child-99',
            parentSessionId: 'sess-native-1',
          },
        },
      ],
    });

    expect(vm.sessionKey).toBe('native:ws-main:conv-1');
    expect(parseSessionKey(vm.sessionKey)).toEqual({
      kind: 'native',
      workspaceId: 'ws-main',
      conversationId: 'conv-1',
    });
    expect(vm.phase).toBe('waiting_approval');
    expect(vm.harness.kind).toBe('native');
    expect(vm.harness.worktreeBranch).toBe('wt/auth');
    expect(vm.diffSummary).toEqual({ additions: 42, deletions: 15 });
    expect(vm.activeWatchesCount).toBe(2);
    expect(vm.retryStatus?.attempt).toBe(1);
    expect(vm.todos?.items).toHaveLength(2);

    expect(vm.turns).toHaveLength(1);
    const turn = vm.turns[0]!;
    expect(turn.turnOrdinal).toBe(1);
    expect(turn.userMessage?.skillNames).toEqual(['hunt']);
    expect(turn.usage).toEqual({ promptTokens: 2800, completionTokens: 500, totalTokens: 3300 });
    expect(turn.turnMetaBadge).toBe('Kapibala · Claude Sonnet · High · Approval');
    expect(turn.proseBlocks[0]?.previewableCodeBlocks).toHaveLength(1);
    expect(turn.proseBlocks[0]?.previewableCodeBlocks[0]?.sandboxDocument).toContain(
      'Content-Security-Policy',
    );

    const toolGroup = turn.processSteps.find((s) => s.kind === 'tool_group');
    expect(toolGroup?.kind).toBe('tool_group');
    if (toolGroup?.kind === 'tool_group') {
      expect(toolGroup.tools).toHaveLength(5);
      expect(toolGroup.tools[0]?.targetLabel).toBe('packages/core/src/gate.ts');
      expect(toolGroup.tools[0]?.primaryTarget).toMatchObject({
        kind: 'diff',
        callId: 'call-edit-1',
        filePath: 'packages/core/src/gate.ts',
        additions: 42,
        deletions: 15,
      });
      expect(toolGroup.tools[1]?.primaryTarget).toMatchObject({
        kind: 'preview',
        previewKind: 'html',
        label: 'HTML 文件预览',
      });
      expect(toolGroup.tools[2]?.primaryTarget).toMatchObject({
        kind: 'preview',
        previewKind: 'image',
        label: 'arch.png',
      });
      expect(toolGroup.tools[3]?.primaryTarget).toEqual({
        kind: 'delegation',
        callId: 'call-spawn-1',
        childSessionId: 'conv-child-99',
        taskName: 'Sandbox Tester',
      });
      expect(toolGroup.tools[4]?.primaryTarget).toEqual({
        kind: 'inspector',
        callId: 'call-cmd-1',
      });
    }

    /* 验证直接审批与子代理冒泡审批：首屏脱敏相对路径，快捷键 Y/S/N 齐全，原始路径留存 Inspector。 */
    expect(vm.approvals).toHaveLength(2);
    expect(vm.approvals[0]?.source).toBe('native');
    expect(vm.approvals[0]?.summaryCode).toBe('pnpm --prefix packages/core test');
    expect(vm.approvals[0]?.summaryCode).not.toContain('/repo/kapibala');
    expect(vm.approvals[0]?.actions.map((a) => `${a.label}:${a.shortcutHint}`)).toEqual([
      '拒绝:N',
      '本会话允许相同调用:S',
      '批准一次:Y',
    ]);
    expect(vm.approvals[0]?.inspectorPayload.workspaceRoot).toBe('/repo/kapibala');

    expect(vm.approvals[1]?.source).toBe('delegation');
    expect(vm.approvals[1]?.title).toContain('Sandbox Tester');
    expect(vm.approvals[1]?.subagentBadge?.childSessionId).toBe('conv-child-99');
    expect(vm.approvals[1]?.summaryCode).toBe('packages/core/tests/gate.test.ts');
  });

  it('projectExternalThread 将 acp / claude-cli / codex-app-server / pi-rpc 四类外部会话映射为完全一致的 UnifiedThreadViewModel', () => {
    const transports: ReadonlyArray<{
      readonly transport: ViewExternalTransport;
      readonly expectedBadge: 'ACP' | 'CLI' | 'App-Server' | 'RPC';
      readonly name: string;
    }> = [
      { transport: 'acp', expectedBadge: 'ACP', name: 'Gemini CLI' },
      { transport: 'claude-cli', expectedBadge: 'CLI', name: 'Claude Code' },
      { transport: 'codex-app-server', expectedBadge: 'App-Server', name: 'Codex' },
      { transport: 'pi-rpc', expectedBadge: 'RPC', name: 'Pi Agent' },
    ];

    for (const entry of transports) {
      const snapshot: ViewExternalSnapshot = {
        session: {
          id: `ext-${entry.transport}`,
          harnessId: entry.transport,
          harnessName: entry.name,
          transport: entry.transport,
          workspaceRoot: '/repo/kapibala',
          title: '核查跨平台垫片',
          status: 'idle',
          resumable: entry.transport !== 'pi-rpc',
          canContinue: entry.transport !== 'pi-rpc',
          hasArchive: true,
          pendingApprovalCount: 1,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_050_000,
        },
        sequence: 5,
        messages: sampleMessages,
        approvals: [
          {
            approvalId: `ext-ap-${entry.transport}`,
            sessionId: `ext-${entry.transport}`,
            toolCallId: 'tc-1',
            toolTitle: 'Bash',
            target: '/repo/kapibala/scripts/dev.mjs --verify-only',
            warning: '将执行外部构建脚本',
            expiresAt: 1_700_000_900_000,
            options: [
              { optionId: 'allow_once', label: '允许本次', kind: 'allow_once' },
              { optionId: 'allow_session', label: '本会话允许', kind: 'allow_always' },
            ],
          },
        ],
        plan: {
          revision: 1,
          items: [{ id: 'p1', title: '核查环境变量', status: 'in_progress' }],
        },
        notices: [],
        configOptions: [
          {
            id: 'model',
            name: '模型',
            category: 'model',
            currentValue: 'sonnet',
            options: [{ value: 'sonnet', name: 'Sonnet' }],
          },
          {
            id: 'mode',
            name: '模式',
            category: 'mode',
            currentValue: 'ask',
            options: [{ value: 'ask', name: 'Ask' }],
          },
        ],
      };

      const vm = projectExternalThread({
        workspaceId: 'ws-main',
        workspaceName: 'kapibala',
        snapshot,
        worktree: { id: 'wt-ext', branch: 'wt/shim', worktreePath: '/repo/kapibala.wt/shim' },
        diffSummary: { additions: 9, deletions: 3 },
      });

      expect(vm.sessionKey).toBe(buildExternalSessionKey(`ext-${entry.transport}`));
      expect(parseSessionKey(vm.sessionKey)).toEqual({
        kind: 'external',
        sessionId: `ext-${entry.transport}`,
      });
      expect(vm.phase).toBe('waiting_approval');
      expect(vm.harness).toEqual({
        kind: 'external',
        id: entry.transport,
        label: entry.name,
        transportLabel: entry.expectedBadge,
        resumable: entry.transport !== 'pi-rpc',
        worktreeBranch: 'wt/shim',
      });
      expect(vm.turns).toHaveLength(1);
      expect(vm.turns[0]?.canRegenerate).toBe(false);
      expect(vm.turns[0]?.canRestoreCheckpoint).toBe(false);
      expect(vm.todos?.items[0]?.title).toBe('核查环境变量');
      expect(vm.diffSummary).toEqual({ additions: 9, deletions: 3 });
      expect(vm.capabilities).toEqual({
        canContinue: entry.transport !== 'pi-rpc',
        canSwitchRole: false,
        canSwitchPermissionMode: true,
        canForkOrCheckpoint: false,
        externalConfigCategories: ['model', 'mode'],
      });
      expect(vm.approvals[0]?.source).toBe('external');
      expect(vm.approvals[0]?.summaryCode).toBe('scripts/dev.mjs --verify-only');
      expect(vm.approvals[0]?.actions.map((a) => a.shortcutHint)).toEqual(['N', 'Y', 'S']);
    }
  });
});

describe('四域 Zustand Stores 与全局快捷键契约（017 §2.3 & §5.1）', () => {
  it('WorkspaceStore：selectInboxItems 严格排序且空闲返回空，selectWorkspaceHierarchy 挂载 ↳ 委派子会话并隐藏空临时组', () => {
    const store = createWorkspaceStore();
    store.getState().setSpaces([
      {
        id: 'ws-1',
        kind: 'project',
        name: 'kapibala',
        root: '/repo/kapibala',
        trusted: true,
        trustToken: 'tok-1',
        gitCapable: true,
      },
    ]);

    expect(selectInboxItems(store.getState())).toHaveLength(0);

    store.getState().setWorkspaceHistory('ws-1', {
      page: 1,
      pages: 1,
      total: 3,
      items: [
        {
          conversationId: 'conv-parent',
          sessionId: 'sess-parent',
          title: '重构权限网关',
          messageCount: 6,
          lastActivityAt: 2000,
          worktree: { id: 'wt-1', branch: 'wt/auth', worktreePath: '/repo/wt/auth' },
        },
        {
          conversationId: 'conv-child',
          title: '子会话标题',
          messageCount: 4,
          lastActivityAt: 2500,
          delegation: {
            parentSessionId: 'sess-parent',
            parentTitle: '重构权限网关',
            taskName: '补齐沙箱单测',
          },
        },
        {
          conversationId: 'conv-pinned',
          title: '置顶架构基线',
          messageCount: 2,
          lastActivityAt: 1000,
          pinned: true,
        },
      ],
    });

    const idleHierarchy = selectWorkspaceHierarchy(store.getState(), 'ws-1');
    expect(idleHierarchy.showTemporaryGroup).toBe(false);
    expect(idleHierarchy.temporaryNodes).toHaveLength(0);
    expect(idleHierarchy.rootNodes.map((n) => n.id)).toEqual(['conv-pinned', 'conv-parent']);
    expect(idleHierarchy.rootNodes[1]?.children).toHaveLength(1);
    expect(idleHierarchy.rootNodes[1]?.children[0]?.delegationTaskName).toBe('补齐沙箱单测');

    store.getState().upsertLiveStatus({
      sessionKey: buildNativeSessionKey('ws-1', 'conv-watch'),
      workspaceId: 'ws-1',
      conversationId: 'conv-watch',
      title: '端口监听回归',
      status: 'watch_triggered',
      updatedAt: 5000,
    });
    store.getState().upsertLiveStatus({
      sessionKey: buildNativeSessionKey('ws-1', 'conv-run'),
      workspaceId: 'ws-1',
      conversationId: 'conv-run',
      title: '编译桌面包',
      status: 'running',
      updatedAt: 4000,
    });
    store.getState().upsertLiveStatus({
      sessionKey: buildNativeSessionKey('ws-1', 'conv-parent'),
      workspaceId: 'ws-1',
      conversationId: 'conv-parent',
      title: '重构权限网关',
      status: 'waiting_approval',
      approvalCount: 2,
      updatedAt: 3000,
    });

    const inbox = selectInboxItems(store.getState());
    expect(inbox.map((i) => `${i.status}:${i.badgeLabel}`)).toEqual([
      'waiting_approval:待审批 2',
      'running:运行中',
      'watch_triggered:监视已触发',
    ]);
  });

  it('ShellStore：按会话记忆并去重工作台标签，支持 ⌘J / ⌘1..5 与栈式 Esc 关闭', () => {
    const shell = createShellStore();
    const s1 = 'native:ws-1:c1';
    const s2 = 'external:ext-1';

    shell.getState().openWorkbenchTab(s1, {
      kind: 'diff',
      targetKey: 'src/gate.ts',
      title: 'gate.ts',
    });
    shell.getState().openWorkbenchTab(s1, {
      kind: 'diff',
      targetKey: 'src/gate.ts',
      title: 'gate.ts (+42)',
    });
    expect(selectSessionWorkbench(shell.getState(), s1).tabs).toHaveLength(1);
    expect(selectSessionWorkbench(shell.getState(), s1).tabs[0]?.title).toBe('gate.ts (+42)');

    shell.getState().openWorkbenchTab(s1, { kind: 'preview', targetKey: 'report.html' });
    expect(selectSessionWorkbench(shell.getState(), s1).tabs).toHaveLength(2);
    expect(selectSessionWorkbench(shell.getState(), s2).open).toBe(false);

    /* ⌘J 收起再展开，记忆上次激活标签。 */
    const rememberedActive = selectSessionWorkbench(shell.getState(), s1).activeTabId;
    shell.getState().toggleWorkbench(s1);
    expect(selectSessionWorkbench(shell.getState(), s1).open).toBe(false);
    shell.getState().toggleWorkbench(s1);
    expect(selectSessionWorkbench(shell.getState(), s1).open).toBe(true);
    expect(selectSessionWorkbench(shell.getState(), s1).activeTabId).toBe(rememberedActive);

    /* ⌘4 激活第 4 槽位（terminal）。 */
    shell.getState().activateTabByIndex(s1, 3);
    const afterShortcut = selectSessionWorkbench(shell.getState(), s1);
    expect(afterShortcut.tabs.find((t) => t.id === afterShortcut.activeTabId)?.kind).toBe(
      'terminal',
    );

    /* 验证 Esc 栈顶逐层关闭顺序：命令面板 -> 窄屏抽屉 -> 窄屏覆盖工作台 -> 设置页返回工作台。 */
    shell.getState().openSettings('external');
    shell.getState().setNarrowRailDrawerOpen(true);
    shell.getState().setCommandPaletteOpen(true);

    expect(shell.getState().closeTopmostLayerOnEscape({ sessionKey: s1, viewportWidth: 900 })).toBe(
      true,
    );
    expect(shell.getState().commandPaletteOpen).toBe(false);
    expect(shell.getState().narrowRailDrawerOpen).toBe(true);

    expect(shell.getState().closeTopmostLayerOnEscape({ sessionKey: s1, viewportWidth: 900 })).toBe(
      true,
    );
    expect(shell.getState().narrowRailDrawerOpen).toBe(false);

    expect(shell.getState().closeTopmostLayerOnEscape({ sessionKey: s1, viewportWidth: 900 })).toBe(
      true,
    );
    expect(selectSessionWorkbench(shell.getState(), s1).open).toBe(false);

    expect(shell.getState().closeTopmostLayerOnEscape({ sessionKey: s1, viewportWidth: 900 })).toBe(
      true,
    );
    expect(shell.getState().activeSurface).toBe('workspace');
  });

  it('SessionStore / SettingsStore / dispatchAppShellShortcut 完整覆盖草稿历史召回与 Y/S/N 单键审批', async () => {
    const replied: Array<{ approvalId: string; actionId: string }> = [];
    const sessionStore = createSessionStore({
      replyApproval: async ({ approvalId, actionId }) => {
        replied.push({ approvalId, actionId });
      },
    });
    const scope = buildDraftScopeKey(null, 'ws-1');
    sessionStore.getState().recordSubmittedPrompt(scope, '第一条历史指令');
    sessionStore.getState().setDraft(scope, '未提交草稿');

    expect(sessionStore.getState().recallPromptHistory(scope, -1)).toEqual({
      consumed: true,
      value: '第一条历史指令',
    });
    expect(sessionStore.getState().recallPromptHistory(scope, 1)).toEqual({
      consumed: true,
      value: '未提交草稿',
    });

    sessionStore.getState().addReferenceChip(scope, {
      id: 'ref-1',
      kind: 'file',
      label: 'gate.ts',
      target: 'packages/core/src/gate.ts',
    });
    expect(sessionStore.getState().referencesByKey[scope]).toHaveLength(1);

    const settingsStore = createSettingsStore({
      probeHarness: async () => ({ available: true, status: 'ready', loadSupported: true }),
    });
    settingsStore.getState().setExternalCatalog([
      {
        id: 'claude-cli',
        name: 'Claude Code',
        transport: 'claude-cli',
        command: 'claude',
        args: [],
        envFrom: [],
        builtin: true,
        hasOverride: false,
        enabled: true,
      },
      {
        id: 'disabled-acp',
        name: 'Disabled',
        transport: 'acp',
        command: 'x',
        args: [],
        envFrom: [],
        builtin: false,
        hasOverride: false,
        enabled: false,
      },
    ]);
    expect(selectEnabledHarnesses(settingsStore.getState())).toHaveLength(1);
    await settingsStore.getState().probeHarness('claude-cli');
    expect(settingsStore.getState().harnesses[0]?.probe?.status).toBe('ready');

    /* 验证焦点不在输入框时按 Y 触发批准，在输入框内按 Y 不误触。 */
    const onApproval = vi.fn();
    const ctx = {
      viewportWidth: 1280,
      activeSurface: 'workspace' as const,
      activeSessionKey: 'native:ws-1:c1',
      topApproval: {
        id: 'ap-1',
        actions: [
          { id: 'deny_once', shortcutHint: 'N' as const },
          { id: 'allow_once', shortcutHint: 'Y' as const },
        ],
      },
      onToggleCommandPalette: vi.fn(),
      onToggleSettings: vi.fn(),
      onToggleRail: vi.fn(),
      onToggleWorkbench: vi.fn(),
      onNewConversation: vi.fn(),
      onActivateWorkbenchTab: vi.fn(),
      onApprovalShortcut: onApproval,
      onEscapeLayer: () => false,
    };

    expect(surfaces.dispatchAppShellShortcut({ key: 'y', isEditableTarget: true }, ctx)).toBe(
      false,
    );
    expect(onApproval).not.toHaveBeenCalled();

    expect(surfaces.dispatchAppShellShortcut({ key: 'y', isEditableTarget: false }, ctx)).toBe(
      true,
    );
    expect(onApproval).toHaveBeenCalledWith('ap-1', 'allow_once');
    expect(surfaces.resolveViewportTier(1440)).toBe('standard');
    expect(surfaces.resolveViewportTier(1100)).toBe('compact');
    expect(surfaces.resolveViewportTier(820)).toBe('minimal');
  });
});

describe('Stage 2 Shell & Launchpad SSR 可访问名契约与 450 行体积防线（017 §7 & §8）', () => {
  it('NavigationRail、InboxSection、WorkspaceTree、CommandPalette 与 LaunchpadView 精确匹配 E2E 可访问名契约', () => {
    const emptyInboxHtml = renderToStaticMarkup(
      createElement(surfaces.InboxSection, {
        items: [],
        onSelectSession: () => {},
      }),
    );
    expect(emptyInboxHtml).toBe('');

    const spaces = [
      {
        id: 'ws-1',
        kind: 'project' as const,
        name: 'kapibala',
        root: '/repo/kapibala',
        trusted: true,
        trustToken: 'tok-1',
      },
    ];
    const hierarchies = {
      'ws-1': {
        workspaceId: 'ws-1',
        temporaryNodes: [],
        showTemporaryGroup: false,
        rootNodes: [
          {
            sessionKey: 'native:ws-1:c1',
            kind: 'native' as const,
            workspaceId: 'ws-1',
            id: 'c1',
            title: '重构权限网关超长会话标题防挤压验证',
            pinned: false,
            lastActivityAt: Date.now() - 120_000,
            worktree: { id: 'wt-1', branch: 'wt/auth', worktreePath: '/repo/wt/auth' },
            diffSummary: { additions: 42, deletions: 15 },
            canArchive: true,
            canPin: true,
            canRename: true,
            children: [
              {
                sessionKey: 'native:ws-1:c-sub',
                kind: 'native' as const,
                workspaceId: 'ws-1',
                id: 'c-sub',
                title: '子会话',
                delegationTaskName: '补齐沙箱单测',
                statusText: '✓ 完成',
                pinned: false,
                lastActivityAt: Date.now(),
                canArchive: true,
                canPin: false,
                canRename: true,
                children: [],
              },
            ],
          },
        ],
      },
    };

    const railHtml = renderToStaticMarkup(
      createElement(surfaces.NavigationRail, {
        platform: 'darwin',
        inboxItems: [
          {
            sessionKey: 'native:ws-1:c1',
            workspaceId: 'ws-1',
            workspaceName: 'kapibala',
            title: '重构权限网关',
            status: 'waiting_approval',
            badgeLabel: '待审批',
            approvalCount: 1,
            updatedAt: Date.now(),
          },
        ],
        spaces,
        hierarchies,
        activeWorkspaceId: 'ws-1',
        activeSessionKey: 'native:ws-1:c1',
        onNewConversation: () => {},
        onToggleRail: () => {},
        onOpenCommandPalette: () => {},
        onOpenSettings: () => {},
        onToggleWorkspace: () => {},
        onSelectWorkspace: () => {},
        onSelectInboxSession: () => {},
        onSelectTreeSession: () => {},
      }),
    );

    expect(railHtml).toContain('<aside aria-label="空间与会话"');
    expect(railHtml).toContain('aria-label="新建对话"');
    expect(railHtml).toContain('aria-label="展开或收起侧栏"');
    expect(railHtml).toContain('aria-label="搜索或运行命令"');
    expect(railHtml).toContain('aria-label="打开设置"');
    expect(railHtml).toContain('待审批');
    expect(railHtml).toContain('↳ 补齐沙箱单测');
    expect(railHtml).toContain('⎇ wt/auth');
    expect(railHtml).not.toContain('暂无临时对话');

    const collapsedRailHtml = renderToStaticMarkup(
      createElement(surfaces.NavigationRail, {
        collapsed: true,
        inboxItems: [],
        spaces,
        hierarchies,
        onNewConversation: () => {},
        onToggleRail: () => {},
        onOpenCommandPalette: () => {},
        onOpenSettings: () => {},
        onToggleWorkspace: () => {},
        onSelectWorkspace: () => {},
        onSelectInboxSession: () => {},
        onSelectTreeSession: () => {},
      }),
    );
    expect(collapsedRailHtml).toContain('data-collapsed="true"');
    expect(collapsedRailHtml).toContain('aria-label="展开或收起侧栏"');

    const paletteHtml = renderToStaticMarkup(
      createElement(surfaces.CommandPalette, {
        open: true,
        onOpenChange: () => {},
        recentSessions: hierarchies['ws-1'].rootNodes,
        onOpenSettingsTab: () => {},
      }),
    );
    expect(paletteHtml).toContain('<dialog');
    expect(paletteHtml).toContain('closedby="any"');
    expect(paletteHtml).toContain('命令面板');
    expect(paletteHtml).toContain('type="search"');
    expect(paletteHtml).toContain('aria-label="搜索会话或命令"');

    const launchpadHtml = renderToStaticMarkup(
      createElement(surfaces.LaunchpadView, {
        spaces,
        activeWorkspaceId: 'ws-1',
        worktreeEnabled: true,
      }),
    );
    expect(launchpadHtml).toContain('在 kapibala 开始新任务');
    expect(launchpadHtml).toContain('独立工作树');
    expect(launchpadHtml).toContain('aria-label="发送消息"');
    expect(launchpadHtml).toContain('aria-label="发送"');
  });

  it('adapters / stores / surfaces / shell.css 全量模块严格 <= 450 行、零硬编码色值且零越权依赖导入', () => {
    const targetDirs = [
      path.join(rendererDir, 'adapters'),
      path.join(rendererDir, 'stores'),
      path.join(rendererDir, 'surfaces/shell'),
      path.join(rendererDir, 'surfaces/launchpad'),
    ];

    for (const dir of targetDirs) {
      const files = fs.readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        const rel = path.relative(rendererDir, fullPath).replaceAll('\\', '/');
        const source = fs.readFileSync(fullPath, 'utf8');
        const lineCount = source.split(/\r?\n/).length;

        expect(lineCount, `${rel} 超过 450 行上限（当前 ${lineCount} 行）`).toBeLessThanOrEqual(
          450,
        );
        expect(
          /#(?:[0-9a-fA-F]{3}){1,2}\b|\b(?:rgb|hsl|oklch)a?\(/.test(source),
          `${rel} 含硬编码色值字面量`,
        ).toBe(false);
        expect(
          /transition-all|transition:\s*all|@keyframes|\banimate-[a-z]/.test(source),
          `${rel} 含未受限动效`,
        ).toBe(false);
        expect(source.includes('@cloudflare/kumo'), `${rel} 导入了 Kumo`).toBe(false);
        expect(
          source.includes('@phosphor-icons/react'),
          `${rel} 绕过 ui/icon.tsx 直接导入 Phosphor`,
        ).toBe(false);
        expect(
          /dangerouslySetInnerHTML|localStorage|sessionStorage/.test(source),
          `${rel} 使用了不安全 DOM 或浏览器持久化存储`,
        ).toBe(false);
      }
    }

    const shellCss = fs.readFileSync(path.join(rendererDir, 'styles/shell.css'), 'utf8');
    expect(/#(?:[0-9a-fA-F]{3}){1,2}\b|\b(?:rgb|hsl|oklch)a?\(/.test(shellCss)).toBe(false);
    expect(/transition-all|transition:\s*all|@keyframes/.test(shellCss)).toBe(false);
  });
});
