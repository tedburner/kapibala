import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ViewCheckpointItem,
  ViewEvidence,
  ViewFileDiff,
  ViewMergePreview,
  ViewTool,
} from '@kiturone/kapibala-host/view-model';
import * as React from 'react';
import { type FunctionComponent, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const workbenchDir = path.resolve(currentDir, '../src/renderer/surfaces/workbench');
const workbenchCssPath = path.resolve(currentDir, '../src/renderer/styles/workbench-tabs.css');

interface LoadedDiffRow {
  readonly id: string;
  readonly kind: 'context' | 'add' | 'del' | 'meta';
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly sign: ' ' | '+' | '-' | '\\';
  readonly content: string;
}

interface LoadedDiffHunk {
  readonly id: string;
  readonly header: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly sectionHint?: string;
  readonly rows: readonly LoadedDiffRow[];
}

interface LoadedWorkbenchModule {
  readonly WorkbenchStage: FunctionComponent<Record<string, unknown>>;
  readonly DiffTab: FunctionComponent<Record<string, unknown>>;
  readonly PreviewTab: FunctionComponent<Record<string, unknown>>;
  readonly FilesTab: FunctionComponent<Record<string, unknown>>;
  readonly TerminalTab: FunctionComponent<Record<string, unknown>>;
  readonly InspectorTab: FunctionComponent<Record<string, unknown>>;
  readonly MAX_SESSION_TERMINALS: number;
  readonly parseUnifiedDiffPatch: (patch: string) => readonly LoadedDiffHunk[];
  readonly buildSplitDiffRows: (hunk: LoadedDiffHunk) => readonly {
    readonly id: string;
    readonly left: LoadedDiffRow | null;
    readonly right: LoadedDiffRow | null;
  }[];
  readonly resolveDiffStatusBadge: (file: {
    readonly status: 'added' | 'modified' | 'deleted' | 'renamed';
    readonly binary: boolean;
  }) => { readonly label: string; readonly tone: string };
  readonly buildWorktreeConflictResolutionPrompt: (
    branch: string,
    baseRef: string,
    conflictedFiles: readonly string[],
  ) => string;
  readonly resolveXtermThemeFromTokens: () => Readonly<Record<string, string | undefined>>;
  readonly subscribeTerminalStreamData: (
    sessionKey: string,
    terminalId: string,
    listener: (chunk: string) => void,
  ) => () => void;
  readonly emitTerminalStreamData: (sessionKey: string, terminalId: string, chunk: string) => void;
}

interface LoadedShellStoreModule {
  readonly createShellStore: () => {
    readonly getState: () => {
      readonly openWorkbenchTab: (
        sessionKey: string,
        input: {
          readonly kind: 'diff' | 'preview' | 'files' | 'terminal' | 'inspector';
          readonly targetKey?: string;
          readonly payload?: Readonly<Record<string, unknown>>;
        },
      ) => void;
      readonly activateTabByIndex: (sessionKey: string, index: number) => void;
      readonly closeWorkbenchTab: (sessionKey: string, tabId: string) => void;
      readonly setWorkbenchOpen: (sessionKey: string, open: boolean) => void;
    };
  };
}

let wb: LoadedWorkbenchModule;
let stores: LoadedShellStoreModule;

beforeAll(async () => {
  (globalThis as Record<string, unknown>).React = React;
  const workbenchModulePath: string = '../src/renderer/surfaces/workbench/index.js';
  const shellStorePath: string = '../src/renderer/stores/shell-store.js';
  wb = (await import(workbenchModulePath)) as LoadedWorkbenchModule;
  stores = (await import(shellStorePath)) as LoadedShellStoreModule;
});

describe('Unified / Split Diff 补丁解析器（diff-parser）', () => {
  const samplePatch = [
    'diff --git a/src/gate.ts b/src/gate.ts',
    'index 1111111..2222222 100644',
    '--- a/src/gate.ts',
    '+++ b/src/gate.ts',
    '@@ -10,4 +10,5 @@ export function checkAccess() {',
    '   const ready = true;',
    '-  return false;',
    '+  const audited = ready;',
    '+  return audited;',
    ' }',
    '\\ No newline at end of file',
  ].join('\r\n');

  it('精确解析 @@ 块头、CRLF 行尾、新旧行号及文件末尾无换行元信息', () => {
    const hunks = wb.parseUnifiedDiffPatch(samplePatch);
    expect(hunks).toHaveLength(1);
    const hunk = hunks[0]!;
    expect(hunk.oldStart).toBe(10);
    expect(hunk.oldCount).toBe(4);
    expect(hunk.newStart).toBe(10);
    expect(hunk.newCount).toBe(5);
    expect(hunk.sectionHint).toBe('export function checkAccess() {');

    expect(hunk.rows.map((r) => [r.kind, r.oldLine, r.newLine, r.content])).toEqual([
      ['context', 10, 10, '  const ready = true;'],
      ['del', 11, null, '  return false;'],
      ['add', null, 11, '  const audited = ready;'],
      ['add', null, 12, '  return audited;'],
      ['context', 12, 13, '}'],
      ['meta', null, null, 'No newline at end of file'],
    ]);
  });

  it('buildSplitDiffRows 将连续删除行与新增行按序并排配对，上下文双栏对齐', () => {
    const hunk = wb.parseUnifiedDiffPatch(samplePatch)[0]!;
    const pairs = wb.buildSplitDiffRows(hunk);
    expect(pairs).toHaveLength(5);

    expect(pairs[0]?.left?.oldLine).toBe(10);
    expect(pairs[0]?.right?.newLine).toBe(10);

    expect(pairs[1]?.left?.kind).toBe('del');
    expect(pairs[1]?.left?.oldLine).toBe(11);
    expect(pairs[1]?.right?.kind).toBe('add');
    expect(pairs[1]?.right?.newLine).toBe(11);

    expect(pairs[2]?.left).toBeNull();
    expect(pairs[2]?.right?.kind).toBe('add');
    expect(pairs[2]?.right?.newLine).toBe(12);

    expect(pairs[3]?.left?.oldLine).toBe(12);
    expect(pairs[3]?.right?.newLine).toBe(13);

    expect(pairs[4]?.left?.kind).toBe('meta');
    expect(pairs[4]?.right).toBeNull();
  });

  it('resolveDiffStatusBadge 正确映射新增、修改、删除、重命名与二进制徽标', () => {
    expect(wb.resolveDiffStatusBadge({ status: 'added', binary: false }).label).toBe('新增');
    expect(wb.resolveDiffStatusBadge({ status: 'modified', binary: false }).label).toBe('修改');
    expect(wb.resolveDiffStatusBadge({ status: 'deleted', binary: false }).label).toBe('删除');
    expect(wb.resolveDiffStatusBadge({ status: 'renamed', binary: false }).label).toBe('重命名');
    expect(wb.resolveDiffStatusBadge({ status: 'modified', binary: true }).label).toBe('二进制');
  });
});

describe('WorkbenchStage 无障碍选择器契约与 TerminalTab 跨标签保活（017 §7 & 018 §6.2）', () => {
  it('严格输出 complementary[name="工作台面板"]、五大精确标签无障碍名与关闭工作台按钮', () => {
    const shellStore = stores.createShellStore();
    const sessionKey = 'native:ws-1:conv-1';
    shellStore.getState().setWorkbenchOpen(sessionKey, true);

    const html = renderToStaticMarkup(createElement(wb.WorkbenchStage, { sessionKey, shellStore }));

    expect(html).toContain('<aside aria-label="工作台面板"');
    expect(html).toContain('role="tablist"');
    for (const tabName of ['变更', '预览', '文件', '终端', '详情与证据']) {
      expect(html).toContain(`role="tab" aria-label="${tabName}"`);
      expect(html).toContain(`<span>${tabName}</span>`);
    }
    expect(html).toContain('aria-label="关闭工作台"');
  });

  it('打开终端标签后切回「变更」标签时，TerminalTab 保持挂载并通过 hidden 属性隐藏而不卸载', () => {
    const shellStore = stores.createShellStore();
    const sessionKey = 'native:ws-1:conv-keepalive';

    shellStore.getState().openWorkbenchTab(sessionKey, { kind: 'terminal' });
    const activeTermHtml = renderToStaticMarkup(
      createElement(wb.WorkbenchStage, {
        sessionKey,
        shellStore,
        terminalProps: {
          repoLabel: 'kapibala',
          terminals: [
            {
              id: 'pty-1',
              cwdLabel: 'kapibala',
              status: 'running',
              replayBuffer: 'KPBL_PTY_LIVE_OUTPUT',
            },
          ],
        },
      }),
    );
    expect(activeTermHtml).toContain('data-keepalive="terminal"');
    expect(activeTermHtml).toContain('KPBL_PTY_LIVE_OUTPUT');
    expect(activeTermHtml).not.toMatch(/<div[^>]*data-keepalive="terminal"[^>]*hidden=""/);

    /* 切换到索引 0（「变更」标签）：DiffTab 激活渲染，同时 TerminalTab 仍留在 DOM 内且带 hidden=""。 */
    shellStore.getState().activateTabByIndex(sessionKey, 0);
    const switchedDiffHtml = renderToStaticMarkup(
      createElement(wb.WorkbenchStage, {
        sessionKey,
        shellStore,
        terminalProps: {
          repoLabel: 'kapibala',
          terminals: [
            {
              id: 'pty-1',
              cwdLabel: 'kapibala',
              status: 'running',
              replayBuffer: 'KPBL_PTY_LIVE_OUTPUT',
            },
          ],
        },
      }),
    );
    expect(switchedDiffHtml).toContain('当前范围暂无磁盘变更');
    expect(switchedDiffHtml).toContain('KPBL_PTY_LIVE_OUTPUT');
    expect(switchedDiffHtml).toMatch(/<div[^>]*hidden=""[^>]*data-keepalive="terminal"/);

    /* 显式关闭终端标签后，保活面板才卸载释放。 */
    shellStore.getState().closeWorkbenchTab(sessionKey, 'terminal');
    const afterCloseHtml = renderToStaticMarkup(
      createElement(wb.WorkbenchStage, { sessionKey, shellStore }),
    );
    expect(afterCloseHtml).not.toContain('data-keepalive="terminal"');
  });
});

describe('DiffTab 范围切换、检查点手动修改冲突确认与 Worktree 合并审阅', () => {
  const sampleDiffFiles: readonly ViewFileDiff[] = [
    {
      path: 'packages/core/src/security/sandbox.ts',
      status: 'modified',
      additions: 12,
      deletions: 3,
      binary: false,
      truncated: false,
      patch: '@@ -1,2 +1,3 @@\n const a = 1;\n+const b = 2;\n-const c = 3;',
    },
  ];

  const sampleCheckpoints: readonly ViewCheckpointItem[] = [
    {
      ordinal: 2,
      createdAt: 1_700_000_000_000,
      startTree: 'aaa',
      endTree: 'bbb',
      additions: 12,
      deletions: 3,
      changedFilesCount: 1,
      label: '加固沙箱路径校验',
    },
  ];

  it('渲染三档范围切换、文件统计徽标与手动修改冲突 ModalDialog（安全按钮与危险强制覆盖）', () => {
    const html = renderToStaticMarkup(
      createElement(wb.DiffTab, {
        files: sampleDiffFiles,
        checkpoints: sampleCheckpoints,
        worktree: {
          id: 'wt-1',
          branch: 'kpbl/fix-sandbox-a3f9',
          worktreePath: '/tmp/wt/kapibala',
          baseRef: 'main',
        },
        defaultScope: 'checkpoint',
        defaultViewMode: 'split',
        initialRestoreConflicts: ['packages/core/src/security/sandbox.ts'],
        onRestoreCheckpoint: () => ({ status: 'restored' }),
      }),
    );

    expect(html).toContain('当前会话累计');
    expect(html).toContain('按轮次检查点');
    expect(html).toContain('相对基线分支');
    expect(html).toContain('统一视图');
    expect(html).toContain('并排对比');
    expect(html).toContain('还原选中检查点');
    expect(html).toContain('+12');
    expect(html).toContain('−3');
    expect(html).toContain('kpbl-diff-split-row');

    /* 冲突确认框采用原生 <dialog>，列出冲突文件并提供「取消」与「强制覆盖还原」。 */
    expect(html).toContain('<dialog');
    expect(html).toContain('检测到手动修改冲突');
    expect(html).toContain('取消');
    expect(html).toContain('强制覆盖还原');
  });

  it('Worktree 合并面板正确展示领先/落后提交、主工作区脏警告、冲突隔离横幅及一键助手解冲突提示词', () => {
    const cleanPreview: ViewMergePreview = {
      worktreeId: 'wt-1',
      branch: 'kpbl/ui-workbench-7c12',
      baseRef: 'v0.1.6',
      aheadCount: 3,
      behindCount: 1,
      worktreeDirty: true,
      mainDirty: false,
      previewToken: 'tok-clean',
      changedFiles: [{ path: 'src/index.ts', status: 'modified', additions: 8, deletions: 2 }],
    };

    const previewHtml = renderToStaticMarkup(
      createElement(wb.DiffTab, {
        files: sampleDiffFiles,
        worktree: {
          id: 'wt-1',
          branch: 'kpbl/ui-workbench-7c12',
          worktreePath: '/tmp/wt/kapibala',
          baseRef: 'v0.1.6',
        },
        mergePreview: cleanPreview,
        onPreviewMerge: () => cleanPreview,
        onApplyMerge: () => ({ status: 'merged' }),
      }),
    );
    expect(previewHtml).toContain('预览合并到主分支');
    expect(previewHtml).toContain('领先 3 · 落后 1');
    expect(previewHtml).toContain('确认合并回主工作区');
    expect(previewHtml).toContain('确认合并时将在工作树分支内自动创建提交');

    const conflictHtml = renderToStaticMarkup(
      createElement(wb.DiffTab, {
        files: sampleDiffFiles,
        worktree: {
          id: 'wt-1',
          branch: 'kpbl/ui-workbench-7c12',
          worktreePath: '/tmp/wt/kapibala',
          baseRef: 'v0.1.6',
        },
        mergePreview: { ...cleanPreview, mainDirty: true },
        initialMergeConflicts: ['packages/desktop/src/renderer/App.tsx'],
        onResolveConflictWithAgent: () => {},
      }),
    );
    expect(conflictHtml).toContain('主工作区存在未提交脏改动');
    expect(conflictHtml).toContain('工作树内存在合并冲突');
    expect(conflictHtml).toContain('让助手在工作树中解决冲突');

    const prompt = wb.buildWorktreeConflictResolutionPrompt('kpbl/ui-7c12', 'v0.1.6', [
      'src/a.ts',
      'src/b.ts',
    ]);
    expect(prompt).toContain('kpbl/ui-7c12');
    expect(prompt).toContain('v0.1.6');
    expect(prompt).toContain('- src/a.ts');
    expect(prompt).toContain('- src/b.ts');
  });
});

describe('PreviewTab 沙箱隔离与 URL 白名单分类渲染（embed_loopback / open_external / blocked）', () => {
  it('HTML 沙箱仅开启 allow-scripts（不含 allow-same-origin），支持源码切换与重载按钮', () => {
    const sandboxHtml = renderToStaticMarkup(
      createElement(wb.PreviewTab, {
        html: '<main><h1>Kapibala Sandbox</h1></main>',
        htmlLabel: 'HTML 文件预览',
        initialSandboxUrl: 'kpbl-preview://preview/doc-1',
      }),
    );
    expect(sandboxHtml).toContain('src="kpbl-preview://preview/doc-1"');
    expect(sandboxHtml).toContain('sandbox="allow-scripts"');
    expect(sandboxHtml).not.toContain('allow-same-origin');
    expect(sandboxHtml).toContain('查看源码');
    expect(sandboxHtml).toContain('aria-label="重新加载沙箱预览"');
  });

  it('embed_loopback 挂载本地服务预览 iframe，open_external 渲染外链引导卡，blocked 严禁渲染任何 iframe', () => {
    const loopbackHtml = renderToStaticMarkup(
      createElement(wb.PreviewTab, {
        initialUrl: 'http://localhost:5173/dashboard',
      }),
    );
    expect(loopbackHtml).toContain('<iframe');
    expect(loopbackHtml).toContain('title="本地服务预览"');
    expect(loopbackHtml).toContain('src="http://localhost:5173/dashboard"');
    expect(loopbackHtml).toContain('sandbox="allow-scripts allow-forms allow-same-origin"');
    expect(loopbackHtml).toContain('aria-label="刷新本地服务预览"');
    expect(loopbackHtml).toContain('在系统浏览器中打开');

    const externalHtml = renderToStaticMarkup(
      createElement(wb.PreviewTab, {
        initialUrl: 'https://example.com/docs',
      }),
    );
    expect(externalHtml).not.toContain('<iframe');
    expect(externalHtml).toContain('外部网页安全隔离');
    expect(externalHtml).toContain('在系统浏览器中打开');

    for (const dangerousUrl of [
      'file:///etc/passwd',
      'http://192.168.1.20:3000',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost',
    ]) {
      const blockedHtml = renderToStaticMarkup(
        createElement(wb.PreviewTab, { initialUrl: dangerousUrl }),
      );
      expect(blockedHtml, `${dangerousUrl} 绝不允许渲染 iframe`).not.toContain('<iframe');
      expect(blockedHtml).toContain('role="alert"');
    }
  });

  it('图片产物模式展示尺寸元数据与缩放控件，超上限大图拒绝解码', () => {
    const okImageHtml = renderToStaticMarkup(
      createElement(wb.PreviewTab, {
        artifact: { kind: 'image', path: 'artifacts/diagram.svg', ext: 'svg', size: 2048 },
        initialImageDataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      }),
    );
    expect(okImageHtml).toContain('<img');
    expect(okImageHtml).toContain('SVG');
    expect(okImageHtml).toContain('2.0 KB');
    expect(okImageHtml).toContain('aria-label="放大图片"');

    const hugeImageHtml = renderToStaticMarkup(
      createElement(wb.PreviewTab, {
        artifact: { kind: 'image', path: 'artifacts/raw.png', ext: 'png', size: 12 * 1024 * 1024 },
      }),
    );
    expect(hugeImageHtml).not.toContain('<img');
    expect(hugeImageHtml).toContain('超过 8.0 MB 上限');
  });
});

describe('FilesTab、TerminalTab 与 InspectorTab 核心交互契约', () => {
  it('FilesTab 提供搜索框、行号源码只读视图、二进制安全提示及 @文件 引用/复制动作', () => {
    const textHtml = renderToStaticMarkup(
      createElement(wb.FilesTab, {
        files: ['src/index.ts', 'src/utils.ts'],
        selectedPath: 'src/index.ts',
        fileContent: {
          path: 'src/index.ts',
          content: 'export const version = 1;\nexport const ready = true;',
          byteLength: 52,
        },
      }),
    );
    expect(textHtml).toContain('aria-label="搜索工作区文件"');
    expect(textHtml).toContain('52 B');
    expect(textHtml).toContain('插入 @文件 引用');
    expect(textHtml).toContain('复制文件内容');
    expect(textHtml).toContain('export const version = 1;');
    expect(textHtml).toContain('kpbl-code-lineno');

    const binaryHtml = renderToStaticMarkup(
      createElement(wb.FilesTab, {
        files: ['assets/icon.png'],
        selectedPath: 'assets/icon.png',
        fileContent: {
          path: 'assets/icon.png',
          content: '',
          byteLength: 4096,
          binary: true,
        },
      }),
    );
    expect(binaryHtml).toContain('二进制文件不支持文本预览');
  });

  it('TerminalTab 强控单会话 3 终端上限、进程退出重拉横幅、TERMINAL_UNAVAILABLE 降级与自定义视口适配', () => {
    expect(wb.MAX_SESSION_TERMINALS).toBe(3);

    const exitedAndFullHtml = renderToStaticMarkup(
      createElement(wb.TerminalTab, {
        sessionKey: 'native:ws:s1',
        repoLabel: 'kapibala',
        shells: [
          { id: 'pwsh', label: 'PowerShell 7' },
          { id: 'cmd', label: 'Command Prompt' },
        ],
        terminals: [
          { id: 't1', status: 'exited', exitCode: 130, replayBuffer: 'SIGINT' },
          { id: 't2', status: 'running', replayBuffer: '' },
          { id: 't3', status: 'running', replayBuffer: '' },
        ],
        activeTerminalId: 't1',
        onRestartTerminal: () => {},
      }),
    );
    expect(exitedAndFullHtml).toContain('终端 1 · kapibala');
    expect(exitedAndFullHtml).toContain('进程已退出 (code 130)');
    expect(exitedAndFullHtml).toContain('重新启动');
    expect(exitedAndFullHtml).toContain('aria-label="选择终端 Shell"');
    expect(exitedAndFullHtml).toContain('清屏');
    expect(exitedAndFullHtml).toContain('关闭终端');
    expect(exitedAndFullHtml).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*\+ 新建终端/);

    const unavailableHtml = renderToStaticMarkup(
      createElement(wb.TerminalTab, {
        sessionKey: 'native:ws:s2',
        unavailableReason: 'node-pty 原生模块在当前沙箱未启用',
      }),
    );
    expect(unavailableHtml).toContain('TERMINAL_UNAVAILABLE');
    expect(unavailableHtml).toContain('node-pty 原生模块在当前沙箱未启用');

    const customAdapterHtml = renderToStaticMarkup(
      createElement(wb.TerminalTab, {
        sessionKey: 'native:ws:s3',
        terminals: [{ id: 'xt-1', status: 'running' }],
        renderXtermViewport: ({ terminal }: { readonly terminal: { readonly id: string } }) =>
          createElement('div', { 'data-xterm-mounted': terminal.id }, 'XTERM_ADAPTER_READY'),
      }),
    );
    expect(customAdapterHtml).toContain('data-xterm-mounted="xt-1"');
    expect(customAdapterHtml).toContain('XTERM_ADAPTER_READY');
  });

  it('InspectorTab 支持工具详情、审批环境详情切换与四维会话证据看板（含打开委派会话）', () => {
    const sampleTool: ViewTool = {
      callId: 'call-42',
      name: 'run_command',
      displayName: '运行命令',
      invocation: 'pnpm test',
      input: '{"command":"pnpm test"}',
      status: 'succeeded',
      durationMs: 380,
      outputBytes: 128,
      result: 'All 12 tests passed.',
    };

    const sampleEvidence: ViewEvidence = {
      summary: {
        additions: 24,
        deletions: 6,
        truncatedFiles: 0,
        missingFiles: 1,
        references: 1,
        mcpCalls: 3,
        mcpFailures: 1,
        runningDelegations: 1,
      },
      changes: [
        { path: 'src/stage.tsx', callId: 'c1', status: 'recorded', additions: 24, deletions: 6 },
        {
          path: 'src/legacy.ts',
          callId: 'c2',
          status: 'missing',
          additions: null,
          deletions: null,
        },
      ],
      references: [
        {
          sessionId: 'sess-prev',
          recordId: 'rec-9',
          role: 'assistant',
          timestamp: 1_700_000_000_000,
          title: '架构评审纪要',
        },
      ],
      mcp: [{ server: 'github', calls: 3, failed: 1 }],
      delegations: [
        {
          sessionId: 'child-sess-1',
          title: '补齐工作台单测',
          taskName: '补齐工作台单测',
          state: 'running',
          summary: '正在验证保活逻辑',
          lastActivityAt: 1_700_000_000_000,
        },
      ],
    };

    const toolInspectorHtml = renderToStaticMarkup(
      createElement(wb.InspectorTab, {
        selectedTool: sampleTool,
        evidence: sampleEvidence,
        onOpenDelegationSession: () => {},
      }),
    );
    expect(toolInspectorHtml).toContain('运行命令');
    expect(toolInspectorHtml).toContain('380 ms');
    expect(toolInspectorHtml).toContain('All 12 tests passed.');
    expect(toolInspectorHtml).toContain('+24 −6');
    expect(toolInspectorHtml).toContain('未记录');
    expect(toolInspectorHtml).toContain('架构评审纪要');
    expect(toolInspectorHtml).toContain('github');
    expect(toolInspectorHtml).toContain('1 次失败');
    expect(toolInspectorHtml).toContain('打开委派会话');

    const approvalInspectorHtml = renderToStaticMarkup(
      createElement(wb.InspectorTab, {
        selectedApproval: {
          id: 'appr-1',
          source: 'delegation',
          title: '子代理（implementer）请求运行终端命令',
          riskLabel: 'workspace-write',
          summaryCode: 'pnpm test',
          actions: [],
          inspectorPayload: {
            workspaceRoot: '/repo/kapibala',
            executionRoot: '/home/.kapibala/worktrees/a3f9/kapibala',
            runId: 'run-99',
            conversationId: 'conv-root',
          },
        },
      }),
    );
    expect(approvalInspectorHtml).toContain('委派子代理审批');
    expect(approvalInspectorHtml).toContain('/repo/kapibala');
    expect(approvalInspectorHtml).toContain('/home/.kapibala/worktrees/a3f9/kapibala');
    expect(approvalInspectorHtml).toContain('run-99');
  });
});

describe('M5 Workbench 静态防线审计（<= 450 行、零色值字面量、零越权导入）', () => {
  it('surfaces/workbench/* 与 workbench-tabs.css 全部满足行数、语义令牌与零 Kumo/Phosphor 直连约束', () => {
    const tsEntries = fs
      .readdirSync(workbenchDir)
      .filter((name) => /\.(ts|tsx)$/.test(name))
      .sort();
    expect(tsEntries.length).toBeGreaterThanOrEqual(7);

    for (const name of tsEntries) {
      const source = fs.readFileSync(path.join(workbenchDir, name), 'utf8');
      const lineCount = source.split(/\r?\n/).length;
      expect(lineCount, `${name} 超过 450 行红线（当前 ${lineCount} 行）`).toBeLessThanOrEqual(450);
      expect(
        /#(?:[0-9a-fA-F]{3}){1,2}\b|\b(?:rgb|hsl|oklch)a?\(/.test(source),
        `${name} 存在硬编码颜色字面量`,
      ).toBe(false);
      expect(
        /transition-all|transition:\s*all|@keyframes|\banimate-[a-z]/.test(source),
        `${name} 存在未受限动效规则`,
      ).toBe(false);
      expect(
        /dangerouslySetInnerHTML|localStorage|sessionStorage/.test(source),
        `${name} 存在不安全渲染或浏览器私有存储`,
      ).toBe(false);
      expect(source.includes('@cloudflare/kumo'), `${name} 禁止导入 Kumo`).toBe(false);
      expect(
        source.includes('@phosphor-icons/react'),
        `${name} 禁止绕过 ui/index.js 直接导入 Phosphor`,
      ).toBe(false);
    }

    const cssSource = fs.readFileSync(workbenchCssPath, 'utf8');
    expect(cssSource).toContain('var(--kpbl-text-code');
    expect(cssSource).toContain('data-code-wrap="true"');
    expect(
      /#(?:[0-9a-fA-F]{3}){1,2}\b|\b(?:rgb|hsl|oklch)a?\(/.test(cssSource),
      'workbench-tabs.css 存在硬编码颜色字面量',
    ).toBe(false);
    expect(
      /transition-all|transition:\s*all|@keyframes|\banimate-[a-z]|!important/.test(cssSource),
      'workbench-tabs.css 存在违禁动效或 !important',
    ).toBe(false);
  });
});

describe('C-1 / H-10 / H-12 / M-5 工作台终端主题采样、焦点守卫、自动折行与英文双语回归测试', () => {
  function extractModeVarsFromTokensCss(mode: 'light' | 'dark'): Record<string, string> {
    const tokensCss = fs.readFileSync(
      path.resolve(currentDir, '../src/renderer/styles/tokens.css'),
      'utf8',
    );
    const marker = mode === 'dark' ? ':root[data-mode="dark"]' : ':root[data-mode="light"]';
    const startIdx = tokensCss.indexOf(marker);
    const braceStart = tokensCss.indexOf('{', startIdx);
    const braceEnd = tokensCss.indexOf('}', braceStart);
    const block = tokensCss.slice(braceStart + 1, braceEnd);
    const vars: Record<string, string> = {};
    for (const line of block.split(/\r?\n/)) {
      const m = /^\s*(--kpbl-[a-z0-9-]+)\s*:\s*([^;]+);/i.exec(line);
      if (m?.[1] && m[2]) vars[m[1]] = m[2].trim();
    }
    return vars;
  }

  function parseCssColorForCanvasMock(raw: string): [number, number, number, number] {
    const hexMatch = /^#([0-9a-fA-F]{6})$/.exec(raw.trim());
    if (hexMatch?.[1]) {
      const d = hexMatch[1];
      return [
        Number.parseInt(d.slice(0, 2), 16),
        Number.parseInt(d.slice(2, 4), 16),
        Number.parseInt(d.slice(4, 6), 16),
        1,
      ];
    }
    const mixMatch =
      /color-mix\([^,]+,\s*#([0-9a-fA-F]{6})\s+([0-9.]+)%\s*,\s*transparent\s*\)/i.exec(raw);
    if (mixMatch?.[1] && mixMatch[2]) {
      const d = mixMatch[1];
      return [
        Number.parseInt(d.slice(0, 2), 16),
        Number.parseInt(d.slice(2, 4), 16),
        Number.parseInt(d.slice(4, 6), 16),
        Math.max(0, Math.min(1, Number(mixMatch[2]) / 100)),
      ];
    }
    return [0, 0, 0, 0];
  }

  it('[C-1] resolveXtermThemeFromTokens 基于真实 tokens.css 采样浅/深双主题，且半透明选区叠底合成绝不退化为黑块', () => {
    const prevDoc = (globalThis as Record<string, unknown>).document;
    const prevGetComputedStyle = (globalThis as Record<string, unknown>).getComputedStyle;
    try {
      let currentMode: 'light' | 'dark' = 'light';
      const lightVars = extractModeVarsFromTokensCss('light');
      const darkVars = extractModeVarsFromTokensCss('dark');

      let pixel: [number, number, number, number] = [0, 0, 0, 0];
      let currentFill = '#000000';
      const ctxMock = {
        get fillStyle() {
          return currentFill;
        },
        set fillStyle(val: string) {
          currentFill = val;
        },
        clearRect: () => {
          pixel = [0, 0, 0, 0];
        },
        fillRect: () => {
          const [sr, sg, sb, sa] = parseCssColorForCanvasMock(currentFill);
          if (sa <= 0) return;
          if (sa >= 1 || pixel[3] === 0) {
            pixel = [sr, sg, sb, Math.round(sa * 255)];
            return;
          }
          const da = pixel[3] / 255;
          const outA = sa + da * (1 - sa);
          pixel = [
            Math.round((sr * sa + pixel[0] * da * (1 - sa)) / outA),
            Math.round((sg * sa + pixel[1] * da * (1 - sa)) / outA),
            Math.round((sb * sa + pixel[2] * da * (1 - sa)) / outA),
            Math.round(outA * 255),
          ];
        },
        getImageData: () => ({ data: new Uint8ClampedArray(pixel) }),
      };

      const rootEl = {
        get dataset() {
          return { mode: currentMode };
        },
      };
      (globalThis as Record<string, unknown>).document = {
        documentElement: rootEl,
        createElement: () => ({
          width: 1,
          height: 1,
          getContext: () => ctxMock,
        }),
      };
      (globalThis as Record<string, unknown>).getComputedStyle = () => ({
        getPropertyValue: (name: string) =>
          (currentMode === 'dark' ? darkVars : lightVars)[name] ?? '',
      });

      const lightTheme = wb.resolveXtermThemeFromTokens();
      expect(lightTheme.background).toBe('#f7f6f3');
      expect(lightTheme.foreground).toBe('#262523');
      expect(lightTheme.cursor).toBe('#c26b33');
      expect(lightTheme.brightBlack).toBe('#66645e');
      expect(lightTheme.black).toBe('#141413');
      expect(lightTheme.brightWhite).toBe('#141413');
      expect(lightTheme.selectionBackground).toBeDefined();
      expect(lightTheme.selectionBackground).not.toBe('#181816');
      const selR = Number.parseInt(lightTheme.selectionBackground!.slice(1, 3), 16);
      expect(selR).toBeGreaterThan(210);

      currentMode = 'dark';
      const darkTheme = wb.resolveXtermThemeFromTokens();
      expect(darkTheme.background).toBe('#15171a');
      expect(darkTheme.background).not.toBe('#000000');
      expect(darkTheme.foreground).toBe('#e2e0da');
      expect(darkTheme.cursor).toBe('#e58b52');
      expect(darkTheme.black).toBe('#111214');
      expect(darkTheme.brightWhite).toBe('#f4f3ee');
      expect(darkTheme.selectionBackground).toBeDefined();
      expect(darkTheme.selectionBackground).not.toBe('#f4f3ee');
      const darkSelR = Number.parseInt(darkTheme.selectionBackground!.slice(1, 3), 16);
      expect(darkSelR).toBeLessThan(60);
    } finally {
      (globalThis as Record<string, unknown>).document = prevDoc;
      (globalThis as Record<string, unknown>).getComputedStyle = prevGetComputedStyle;
    }
  });

  it('[H-10 & M-7] 终端增量流订阅零丢包，且焦点位于 .kpbl-terminal-pane / .xterm 时屏蔽单键审批快捷键', async () => {
    const received: string[] = [];
    const off = wb.subscribeTerminalStreamData('native:ws:t1', 'pty-init', (chunk) => {
      received.push(chunk);
    });
    wb.emitTerminalStreamData('native:ws:t1', 'pty-init', 'PS F:\\repo> ');
    off();
    wb.emitTerminalStreamData('native:ws:t1', 'pty-init', 'ignored');
    expect(received).toEqual(['PS F:\\repo> ']);

    const shortcutsPath = '../src/renderer/surfaces/shell/shell-shortcuts.js';
    const shortcuts = (await import(shortcutsPath)) as {
      readonly isEditableElement: (target: unknown) => boolean;
    };
    const fakeTermDiv = {
      tagName: 'DIV',
      isContentEditable: false,
      closest: (sel: string) => (sel.includes('.kpbl-terminal-pane') ? {} : null),
      getAttribute: () => null,
    };
    expect(shortcuts.isEditableElement(fakeTermDiv)).toBe(true);
    const plainDiv = {
      tagName: 'DIV',
      isContentEditable: false,
      closest: () => null,
      getAttribute: () => null,
    };
    expect(shortcuts.isEditableElement(plainDiv)).toBe(false);
  });

  it('[H-12 & M-5] FilesTab 响应 codeWordWrap 自动折行属性，且英文语言下工作台全标签完整英文化', async () => {
    const settingsStorePath = '../src/renderer/stores/settings-store.js';
    const { useSettingsStore } = (await import(settingsStorePath)) as {
      readonly useSettingsStore: {
        readonly getState: () => {
          readonly hydratePreferences: (prefs: Record<string, unknown>) => void;
          readonly resetGeneralPreferences: () => Promise<void>;
        };
      };
    };
    try {
      useSettingsStore.getState().hydratePreferences({
        theme: 'light',
        locale: 'en',
        resolvedLocale: 'en',
        typography: {
          uiFontFamily: 'system',
          codeFontFamily: 'system',
          chatFontSize: 15,
          terminalFontSize: 13,
          codeLigatures: true,
        },
        general: {
          timeFormat: 'relative',
          sendShortcut: 'enter',
          codeWordWrap: true,
          desktopNotifications: true,
          preferredShell: 'auto',
        },
        confirmations: {
          deleteSession: true,
          archiveSession: false,
          closeActiveTerminal: true,
        },
      });

      const shellStore = stores.createShellStore();
      const sessionKey = 'native:ws:en-wb';
      shellStore.getState().setWorkbenchOpen(sessionKey, true);
      const stageEnHtml = renderToStaticMarkup(
        createElement(wb.WorkbenchStage, { sessionKey, shellStore }),
      );
      expect(stageEnHtml).toContain('aria-label="Workbench Panel"');
      for (const tabLabel of ['Diff', 'Preview', 'Files', 'Terminal', 'Inspector']) {
        expect(stageEnHtml).toContain(`aria-label="${tabLabel}"`);
      }

      const filesWrapHtml = renderToStaticMarkup(
        createElement(wb.FilesTab, {
          files: ['src/long.ts'],
          selectedPath: 'src/long.ts',
          fileContent: { path: 'src/long.ts', content: 'const line = 1;', byteLength: 15 },
        }),
      );
      expect(filesWrapHtml).toContain('data-code-wrap="true"');
      expect(filesWrapHtml).toContain('Insert @File Ref');
      expect(filesWrapHtml).toContain('Copy File');
    } finally {
      await useSettingsStore.getState().resetGeneralPreferences();
    }
  });
});
