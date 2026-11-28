import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { type FunctionComponent, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const settingsDir = path.resolve(currentDir, '../src/renderer/surfaces/settings');
const dialogsDir = path.resolve(currentDir, '../src/renderer/surfaces/dialogs');
const settingsCssPath = path.resolve(currentDir, '../src/renderer/styles/settings.css');

/** Node 环境下动态加载渲染层设置与模态框模块的类型投影（避开 `tsconfig.node.json` 无 `--jsx` 限制）。 */
interface LoadedSettingsModule {
  readonly SettingsStage: FunctionComponent<Record<string, unknown>>;
  readonly GeneralPage: FunctionComponent<Record<string, unknown>>;
  readonly ProvidersPage: FunctionComponent<Record<string, unknown>>;
  readonly ProviderModelModal: FunctionComponent<Record<string, unknown>>;
  readonly RoutingPage: FunctionComponent<Record<string, unknown>>;
  readonly ExternalHarnessesPage: FunctionComponent<Record<string, unknown>>;
  readonly ExternalCustomSection: FunctionComponent<Record<string, unknown>>;
  readonly PermissionsPage: FunctionComponent<Record<string, unknown>>;
  readonly ResourcesPage: FunctionComponent<Record<string, unknown>>;
  readonly McpServerModal: FunctionComponent<Record<string, unknown>>;
  readonly SkillImportPanel: FunctionComponent<Record<string, unknown>>;
  readonly AppearancePage: FunctionComponent<Record<string, unknown>>;
  readonly ArchivesPage: FunctionComponent<Record<string, unknown>>;
  readonly ArchivePreviewModal: FunctionComponent<Record<string, unknown>>;
  readonly DiagnosticsPage: FunctionComponent<Record<string, unknown>>;
  readonly SETTINGS_NAV_ITEMS: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly normalizeSettingsTab: (raw?: string | null) => string;
  readonly parseEnvNames: (text: string) => { readonly names: string[]; readonly error?: string };
  readonly parseArgsLines: (text: string) => string[];
  readonly suggestHarnessId: (name: string, occupied?: ReadonlySet<string>) => string;
  readonly describeHarnessCache: (item: Record<string, unknown>) => {
    readonly cached: boolean;
    readonly modelCount: number;
    readonly summary: string;
  };
}

interface LoadedDialogsModule {
  readonly ProjectDialog: FunctionComponent<Record<string, unknown>>;
  readonly WorkspaceTrustDialog: FunctionComponent<Record<string, unknown>>;
  readonly FullAccessConfirmDialog: FunctionComponent<Record<string, unknown>>;
  readonly SessionRenameDialog: FunctionComponent<Record<string, unknown>>;
  readonly SessionArchiveDialog: FunctionComponent<Record<string, unknown>>;
  readonly SessionDeleteDialog: FunctionComponent<Record<string, unknown>>;
  readonly ExternalSessionDeleteDialog: FunctionComponent<Record<string, unknown>>;
  readonly sanitizeInitialProjectName: (raw: string) => string;
}

let settingsMod: LoadedSettingsModule;
let dialogsMod: LoadedDialogsModule;

const sampleCatalog = {
  noAuthEnv: 'KPBL_NO_AUTH',
  defaultModel: 'deepseek-chat',
  routing: { planning: 'claude-sonnet' },
  permissionMode: 'Approval' as const,
  projectOverride: false,
  providers: [
    {
      key: 'deepseek',
      name: 'DeepSeek',
      description: 'DeepSeek 官方推理与通用对话模型。',
      custom: false,
    },
    {
      key: 'custom',
      name: '自定义端点',
      description: '兼容 OpenAI / Anthropic 的自建网关。',
      custom: true,
    },
  ],
  profiles: [
    {
      id: 'deepseek-chat',
      name: 'DeepSeek V3',
      provider: 'openai-compatible' as const,
      providerKey: 'deepseek',
      modelName: 'deepseek-chat',
      baseURL: 'https://api.deepseek.com/v1',
      effectiveBaseURL: 'https://api.deepseek.com/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      builtin: true,
      disabled: false,
      scope: 'global' as const,
      contextWindow: 128_000,
      supportsThinking: true,
      credential: {
        configured: true,
        source: 'inline' as const,
        group: 'deepseek',
        env: 'DEEPSEEK_API_KEY',
      },
    },
    {
      id: 'claude-sonnet',
      name: 'Claude Sonnet',
      provider: 'anthropic' as const,
      providerKey: 'custom',
      modelName: 'claude-sonnet-4-5',
      baseURL: 'https://api.example.com/v1',
      effectiveBaseURL: 'https://api.example.com/v1',
      apiKeyEnv: 'CUSTOM_API_KEY',
      builtin: false,
      disabled: false,
      scope: 'global' as const,
      contextWindow: 200_000,
      credential: {
        configured: true,
        source: 'inline' as const,
        group: 'custom',
      },
    },
  ],
};

beforeAll(async () => {
  (globalThis as Record<string, unknown>).React = React;
  const settingsPath = '../src/renderer/surfaces/settings/index.js';
  const dialogsPath = '../src/renderer/surfaces/dialogs/index.js';
  settingsMod = (await import(settingsPath)) as LoadedSettingsModule;
  dialogsMod = (await import(dialogsPath)) as LoadedDialogsModule;
});

describe('SettingsStage 壳内设置中心顶层结构与八大导航标签契约', () => {
  it('渲染 <section aria-label="设置中心">、返回工作台按钮及首栏「常规」在内的 8 个分组标签', () => {
    expect(settingsMod.SETTINGS_NAV_ITEMS.map((i) => i.label)).toEqual([
      '常规',
      '模型与服务商',
      '默认模型与路由',
      '外部代理',
      '权限审批',
      '资源管理',
      '会话归档',
      '诊断',
    ]);

    const generalStageHtml = renderToStaticMarkup(
      createElement(settingsMod.SettingsStage, {
        tab: 'general',
        catalog: sampleCatalog,
      }),
    );
    expect(generalStageHtml).toContain('恢复默认设置');
    expect(generalStageHtml).toContain('aria-label="配色模式"');

    const html = renderToStaticMarkup(
      createElement(settingsMod.SettingsStage, {
        tab: 'providers',
        catalog: sampleCatalog,
        hostDown: true,
      }),
    );

    expect(html).toContain('<section aria-label="设置中心"');
    expect(html).toContain('aria-label="返回工作台"');
    expect(html).toContain('返回工作台');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="设置分类"');
    expect(html).toContain('data-wide="true"');
    expect(html).toContain('执行 Host 未连接');
    expect(html).toContain('重新连接');

    for (const label of [
      '常规',
      '模型与服务商',
      '默认模型与路由',
      '外部代理',
      '权限审批',
      '资源管理',
      '会话归档',
      '诊断',
    ]) {
      expect(html).toContain(label);
    }

    const standardHtml = renderToStaticMarkup(
      createElement(settingsMod.SettingsStage, {
        tab: 'routing',
        catalog: sampleCatalog,
      }),
    );
    expect(standardHtml).not.toContain('data-wide="true"');
    expect(standardHtml).toContain('全局默认模型');
    expect(standardHtml).toContain('规划角色');
    expect(standardHtml).toContain('摘要角色');
  });

  it('normalizeSettingsTab 兼容历史分类别名（appearance -> general）并默认回退至 general', () => {
    expect(settingsMod.normalizeSettingsTab('appearance')).toBe('general');
    expect(settingsMod.normalizeSettingsTab('general')).toBe('general');
    expect(settingsMod.normalizeSettingsTab('models')).toBe('providers');
    expect(settingsMod.normalizeSettingsTab('permission')).toBe('permissions');
    expect(settingsMod.normalizeSettingsTab('archived')).toBe('archives');
    expect(settingsMod.normalizeSettingsTab('external')).toBe('external');
    expect(settingsMod.normalizeSettingsTab('unknown-tab')).toBe('general');
  });
});

describe('八大设置分组页 SSR 语义与 E2E 可访问名契约', () => {
  it('ProvidersPage 与 ProviderModelModal 输出共享凭证、测试连接、碳素墨开关与单层模态表单', () => {
    const pageHtml = renderToStaticMarkup(
      createElement(settingsMod.ProvidersPage, { catalog: sampleCatalog }),
    );
    expect(pageHtml).toContain('aria-label="搜索提供商或模型"');
    expect(pageHtml).toContain('新增自定义模型');
    expect(pageHtml).toContain('aria-label="服务商共享 API Key"');
    expect(pageHtml).toContain('保存密钥');
    expect(pageHtml).toContain('aria-label="测试连接 DeepSeek V3"');
    expect(pageHtml).toContain('role="switch"');
    expect(pageHtml).toContain('aria-label="停用模型 DeepSeek V3"');

    const modalHtml = renderToStaticMarkup(
      createElement(settingsMod.ProviderModelModal, {
        open: true,
        onOpenChange: () => {},
        isCustomGroup: true,
        onSaved: async () => {},
      }),
    );
    expect(modalHtml).toContain('<dialog');
    expect(modalHtml).toContain('新增自定义模型');
    expect(modalHtml).toContain('Base URL（必填）');
    expect(modalHtml).toContain('API Key（必填）');
    expect(modalHtml).toContain('获取模型列表');
    expect(modalHtml).toContain('模型名（必填）');
    expect(modalHtml).toContain('高级设置');
    expect(modalHtml).toContain('128k');
    expect(modalHtml).toContain('8k');
    expect(modalHtml).toContain('保存到本地');
  });

  it('ExternalHarnessesPage 完整保留内置外部代理双行布局、MiddleTruncate 命令与自定义握手契约', () => {
    const html = renderToStaticMarkup(
      createElement(settingsMod.ExternalHarnessesPage, {
        initialHarnesses: [
          {
            id: 'claude-code',
            name: 'Claude Code',
            transport: 'claude-cli',
            command: '/usr/local/share/global/node_modules/.bin/claude',
            args: ['--output-format', 'stream-json'],
            envFrom: ['HTTPS_PROXY'],
            builtin: true,
            hasOverride: true,
            enabled: true,
            probe: {
              available: true,
              status: 'ready',
              version: '1.2.0',
              loadSupported: true,
            },
            cachedConfigOptions: [
              {
                id: 'model',
                name: 'Model',
                category: 'model',
                options: [{ value: 'sonnet', name: 'Sonnet' }],
              },
            ],
          },
          {
            id: 'gemini',
            name: 'Gemini CLI',
            transport: 'acp',
            command: 'gemini',
            args: ['--acp'],
            envFrom: [],
            builtin: true,
            hasOverride: false,
            enabled: false,
          },
        ],
      }),
    );

    expect(html).toContain('内置外部代理');
    expect(html).toContain('Claude Code');
    expect(html).toContain('原生 CLI 直连');
    expect(html).toContain('就绪 · 1.2.0');
    expect(html).toContain('模型缓存：已缓存 1 个模型');
    expect(html).toContain('aria-label="检测 Claude Code 连接"');
    expect(html).toContain('aria-label="刷新 Claude Code 模型缓存"');
    expect(html).toContain('aria-label="配置 Claude Code 覆盖项"');
    expect(html).toContain('aria-label="启用 Gemini CLI"');
    expect(html).toContain('从 ACP 目录选择模板');
    expect(html).toContain('添加自定义 ACP 代理');

    const customFormHtml = renderToStaticMarkup(
      createElement(settingsMod.ExternalCustomSection, {
        allHarnessIds: new Set(['claude-code']),
        customHarnesses: [],
        templates: [],
        probes: {},
        customDraft: {
          id: 'e2e-acp',
          idLocked: false,
          idTouched: true,
          name: '本地验收 ACP',
          command: 'node',
          argsText: 'agent.mjs',
          envFromText: '',
          enabled: true,
        },
        draftProbe: {
          available: true,
          status: 'ready',
          agentName: 'custom-generic-agent',
          version: '1.0.0',
          loadSupported: false,
        },
        testingDraft: false,
        refreshingAllCaches: false,
        busy: false,
        hostDown: false,
        onChangeDraft: () => {},
        onApplyTemplate: () => {},
        onStartBlankCustom: () => {},
        onEditCustom: () => {},
        onProbeDraft: () => {},
        onSaveDraft: () => {},
        onRunProbe: () => {},
        onRefreshCache: () => {},
        onToggleEnabled: () => {},
        onRemoveCustom: () => {},
      }),
    );
    expect(customFormHtml).toContain('aria-label="自定义代理显示名称"');
    expect(customFormHtml).toContain('aria-label="自定义代理标识 ID"');
    expect(customFormHtml).toContain('aria-label="自定义代理可执行命令"');
    expect(customFormHtml).toContain('aria-label="自定义代理启动参数"');
    expect(customFormHtml).toContain('握手成功：custom-generic-agent · 1.0.0');
    expect(customFormHtml).toContain('测试握手');
    expect(customFormHtml).toContain('保存代理');

    expect(settingsMod.parseEnvNames('OPENAI_API_KEY=secret').error).toContain('不应包含 "="');
    expect(settingsMod.parseEnvNames('sk-1234567890abcdef').error).toContain('密钥明文');
    expect(settingsMod.parseEnvNames('HTTPS_PROXY, OPENAI_API_KEY').names).toEqual([
      'HTTPS_PROXY',
      'OPENAI_API_KEY',
    ]);
    expect(settingsMod.parseArgsLines('  --acp \n\n --verbose ')).toEqual(['--acp', '--verbose']);
    expect(settingsMod.suggestHarnessId('本地代理', new Set(['custom-acp']))).toBe('custom-acp-2');
  });

  it('PermissionsPage、ResourcesPage、AppearancePage、ArchivesPage 与 DiagnosticsPage 完整渲染核心控制项', () => {
    const permHtml = renderToStaticMarkup(
      createElement(settingsMod.PermissionsPage, {
        catalog: sampleCatalog,
        spaces: [
          {
            id: 'proj-1',
            kind: 'project',
            name: 'kapibala-repo',
            root: '/workspace/kapibala',
            trusted: true,
            trustToken: 'tok-1',
          },
        ],
      }),
    );
    expect(permHtml).toContain('变更前确认');
    expect(permHtml).toContain('自主模式');
    expect(permHtml).toContain('启用完全访问');
    expect(permHtml).toContain('aria-label="撤销信任 kapibala-repo"');
    expect(permHtml).toContain('.git');
    expect(permHtml).toContain('.env*');
    expect(permHtml).toContain('.kapibala/**');

    const resEmptyHtml = renderToStaticMarkup(
      createElement(settingsMod.ResourcesPage, { workspaceId: 'ws-default' }),
    );
    expect(resEmptyHtml).toContain('未配置任何 MCP 服务器。');
    expect(resEmptyHtml).toContain('新增服务器');
    expect(resEmptyHtml).toContain('aria-label="从其它工具导入 MCP"');
    expect(resEmptyHtml).toContain('启用技能功能');

    const skillImportHtml = renderToStaticMarkup(
      createElement(settingsMod.SkillImportPanel, {
        projectTrusted: true,
        scope: 'global',
        busy: false,
        selectedKeys: new Set(['claude-code:ext-review']),
        scan: {
          partial: false,
          sources: [
            {
              harness: 'claude-code',
              label: 'Claude Code',
              roots: [],
              candidates: 1,
              partial: false,
              truncated: 0,
            },
          ],
          diagnostics: [],
          candidates: [
            {
              harness: 'claude-code',
              name: 'ext-review',
              directoryName: 'ext-review',
              description: '跨工具审查技能',
              sourceRef: '/home/.claude/skills/ext-review',
              origin: 'global',
              files: 2,
              bytes: 512,
              hasScripts: false,
              strippedFields: [],
              conflict: 'exists-enabled',
            },
          ],
        },
        onClose: () => {},
        onScopeChange: () => {},
        onToggleKey: () => {},
        onSelectAll: () => {},
        onClearSelection: () => {},
        onRunImport: () => {},
      }),
    );
    expect(skillImportHtml).toContain('aria-label="从其它工具导入技能"');
    expect(skillImportHtml).toContain('aria-label="目标作用域"');
    expect(skillImportHtml).toContain('已存在（将跳过）');

    const generalHtml = renderToStaticMarkup(
      createElement(settingsMod.GeneralPage, {
        initialTheme: 'dark',
        initialUpdateCheck: {
          status: 'update-available',
          currentVersion: '0.1.5',
          latestVersion: '0.1.6',
          installer: {
            name: 'Kapibala-0.1.6-arm64.dmg',
            url: 'https://github.com/example/release.dmg',
            size: 84 * 1024 * 1024,
          },
        },
      }),
    );
    expect(settingsMod.AppearancePage).toBe(settingsMod.GeneralPage);
    expect(generalHtml).toContain('aria-label="配色模式"');
    expect(generalHtml).toContain('跟随系统');
    expect(generalHtml).toContain('浅色');
    expect(generalHtml).toContain('深色');
    expect(generalHtml).toContain('aria-label="界面语言"');
    expect(generalHtml).toContain('aria-label="时间格式"');
    expect(generalHtml).toContain('aria-label="界面与阅读字体"');
    expect(generalHtml).toContain('aria-label="代码与终端等宽字体"');
    expect(generalHtml).toContain('aria-label="对话阅读字号"');
    expect(generalHtml).toContain('aria-label="终端字号"');
    expect(generalHtml).toContain('aria-label="启用代码连字"');
    expect(generalHtml).toContain('aria-label="代码块默认自动折行"');
    expect(generalHtml).toContain('aria-label="发送消息快捷键"');
    expect(generalHtml).toContain('aria-label="后台桌面通知"');
    expect(generalHtml).toContain('aria-label="删除确认"');
    expect(generalHtml).toContain('aria-label="归档确认"');
    expect(generalHtml).toContain('aria-label="终端关闭确认"');
    expect(generalHtml).toContain('aria-label="首选终端 Shell"');
    expect(generalHtml).toContain('检查更新');
    expect(generalHtml).toContain('下载安装包');
    expect(generalHtml).toContain('xattr -cr /Applications/Kapibala.app');

    const sampleSpace = {
      id: 'ws-1',
      kind: 'default' as const,
      name: '默认空间',
      root: '/tmp/default',
      trusted: true,
      trustToken: 't1',
    };

    const archivesHtml = renderToStaticMarkup(
      createElement(settingsMod.ArchivesPage, {
        initialArchivedGroups: [
          {
            space: sampleSpace,
            list: {
              page: 1,
              pages: 1,
              total: 1,
              items: [
                {
                  conversationId: 'conv-1',
                  title: '旧架构调研记录',
                  messageCount: 12,
                  lastActivityAt: 1_700_000_000_000,
                },
              ],
            },
          },
        ],
        managedWorktrees: [
          {
            id: 'wt-1',
            branch: 'wt/ui-v2',
            worktreePath: '/tmp/worktrees/ui-v2',
            workspaceName: 'kapibala',
            sessionTitle: '重构设置页',
            prunable: true,
          },
        ],
      }),
    );
    expect(archivesHtml).toContain('aria-label="搜索已归档会话"');
    expect(archivesHtml).toContain('旧架构调研记录');
    expect(archivesHtml).toContain('aria-label="查看内容 旧架构调研记录"');
    expect(archivesHtml).toContain('查看内容');
    expect(archivesHtml).toContain('恢复');
    expect(archivesHtml).toContain('永久删除');
    expect(archivesHtml).toContain('wt/ui-v2');
    expect(archivesHtml).toContain('清理孤立 Worktree');

    const previewModalHtml = renderToStaticMarkup(
      createElement(settingsMod.ArchivePreviewModal, {
        target: {
          space: sampleSpace,
          conversationId: 'conv-1',
          title: '旧架构调研记录',
        },
        preview: {
          conversationId: 'conv-1',
          title: '旧架构调研记录',
          gitBranch: 'v0.1.6',
          truncated: false,
          totalRecords: 3,
          items: [
            {
              id: 'turn-u1',
              role: 'user',
              text: '请总结设置重构方案',
              timestamp: 1_700_000_000_000,
              toolSummaries: [],
            },
            {
              id: 'turn-a1',
              role: 'assistant',
              text: '已合并至 **常规** 首栏。',
              timestamp: 1_700_000_005_000,
              toolSummaries: [{ name: 'read_file', summary: 'GeneralPage.tsx', isError: false }],
            },
          ],
        },
        onClose: () => {},
        onRestoreOnly: () => {},
        onRestoreAndOpen: () => {},
      }),
    );
    expect(previewModalHtml).toContain('归档对话预览 · 旧架构调研记录');
    expect(previewModalHtml).toContain('请总结设置重构方案');
    expect(previewModalHtml).toContain('read_file · GeneralPage.tsx');
    expect(previewModalHtml).toContain('恢复并打开对话');

    const archiveConfirmHtml = renderToStaticMarkup(
      createElement(dialogsMod.SessionArchiveDialog, {
        target: { workspaceId: 'ws-1', conversationId: 'conv-1', title: '待归档会话' },
        onCancel: () => {},
        onConfirm: () => {},
      }),
    );
    expect(archiveConfirmHtml).toContain('归档会话？');
    expect(archiveConfirmHtml).toContain('待归档会话');

    const diagHtml = renderToStaticMarkup(
      createElement(settingsMod.DiagnosticsPage, {
        appInfo: {
          name: 'Kapibala',
          version: '0.1.6',
          testBuild: true,
          hostInstanceId: 'host-xyz',
          controlEpoch: 3,
          platform: 'win32',
          runtimes: { electron: '45.0.0', node: '22.14.0', chrome: '156.0.0' },
          notifications: true,
          tray: true,
        },
        activeTerminalsCount: 2,
      }),
    );
    expect(diagHtml).toContain('Host 已连接');
    expect(diagHtml).toContain('host-xyz');
    expect(diagHtml).toContain('本地协议 v2');
    expect(diagHtml).toContain('活跃终端 2');
    expect(diagHtml).toContain('重新连接');
    expect(diagHtml).toContain('重载界面');
    expect(diagHtml).toContain('复制应用诊断');
    expect(diagHtml).toContain('停止任务并退出');
  });
});

describe('surfaces/dialogs 原生 <ModalDialog> 业务弹窗可访问名契约', () => {
  it('完整保留 创建项目、信任此文件夹吗？、启用完全访问？、重命名会话、删除会话？ 且零冗余 role', () => {
    const createHtml = renderToStaticMarkup(
      createElement(dialogsMod.ProjectDialog, {
        open: true,
        onOpenChange: () => {},
        onCreated: async () => {},
      }),
    );
    expect(createHtml).toContain('<dialog');
    expect(createHtml).toContain('创建项目');
    expect(createHtml).toContain('项目名称');
    expect(createHtml).toContain('在此电脑上添加文件夹');
    expect(createHtml).toContain('aria-label="选择文件夹"');
    expect(createHtml).not.toContain('role="dialog"');
    expect(createHtml).not.toContain('aria-modal');

    const trustSwitchHtml = renderToStaticMarkup(
      createElement(dialogsMod.ProjectDialog, {
        open: true,
        initialConfirmTrust: true,
        initialSelected: {
          id: 'ws-p',
          kind: 'project',
          name: 'demo',
          root: '/projects/demo',
          trusted: false,
          trustToken: 'tok',
        },
        onOpenChange: () => {},
        onCreated: async () => {},
      }),
    );
    expect(trustSwitchHtml).toContain('信任此文件夹吗？');
    expect(trustSwitchHtml).toContain('信任文件夹并创建');
    expect(trustSwitchHtml).toContain('/projects/demo');
    expect((trustSwitchHtml.match(/<dialog\b/g) ?? []).length).toBe(1);

    const fullAccessHtml = renderToStaticMarkup(
      createElement(dialogsMod.FullAccessConfirmDialog, {
        open: true,
        onOpenChange: () => {},
        onConfirm: () => {},
      }),
    );
    expect(fullAccessHtml).toContain('启用完全访问？');
    expect(fullAccessHtml).toContain('aria-label="取消完全访问"');
    expect(fullAccessHtml).toContain('确认启用本会话完全访问');

    const renameHtml = renderToStaticMarkup(
      createElement(dialogsMod.SessionRenameDialog, {
        target: { workspaceId: 'ws-1', conversationId: 'c-1', title: '初始标题' },
        onCancel: () => {},
        onConfirm: () => {},
      }),
    );
    expect(renameHtml).toContain('重命名会话');
    expect(renameHtml).toContain('标题');
    expect(renameHtml).toContain('取消');
    expect(renameHtml).toContain('保存');

    const deleteHtml = renderToStaticMarkup(
      createElement(dialogsMod.SessionDeleteDialog, {
        target: { workspaceId: 'ws-1', conversationId: 'c-1', title: '待删对话' },
        onCancel: () => {},
        onConfirm: () => {},
      }),
    );
    expect(deleteHtml).toContain('删除会话？');
    expect(deleteHtml).toContain('待删对话');
    expect(deleteHtml).toContain('取消');
    expect(deleteHtml).toContain('永久删除');
    expect(dialogsMod.sanitizeInitialProjectName('my\u0000project\u007f')).toBe('myproject');
  });
});

describe('M6 设置与业务弹窗静态防线审计（<= 450 行 / 0 硬编码色值 / 0 Kumo / 0 越界图标）', () => {
  it('surfaces/{settings,dialogs}/ 与 styles/settings.css 全量满足 017 §8 门禁', () => {
    const targets = [
      ...fs
        .readdirSync(settingsDir)
        .filter((name) => /\.(ts|tsx)$/.test(name))
        .map((name) => ({
          label: `surfaces/settings/${name}`,
          fullPath: path.join(settingsDir, name),
        })),
      ...fs
        .readdirSync(dialogsDir)
        .filter((name) => /\.(ts|tsx)$/.test(name))
        .map((name) => ({
          label: `surfaces/dialogs/${name}`,
          fullPath: path.join(dialogsDir, name),
        })),
      { label: 'styles/settings.css', fullPath: settingsCssPath },
    ];

    expect(targets.length).toBeGreaterThanOrEqual(14);

    for (const { label, fullPath } of targets) {
      const source = fs.readFileSync(fullPath, 'utf8');
      const lineCount = source.split(/\r?\n/).length;
      expect(lineCount, `${label} 行数 ${lineCount} 超过 450 行硬上限`).toBeLessThanOrEqual(450);
      expect(
        /#(?:[0-9a-fA-F]{3}){1,2}\b|\b(?:rgb|hsl|oklch)a?\(/.test(source),
        `${label} 出现硬编码颜色字面量`,
      ).toBe(false);
      expect(
        /transition-all|transition:\s*all|@keyframes|\banimate-[a-z]|!important/.test(source),
        `${label} 出现违禁动效或 !important`,
      ).toBe(false);
      expect(
        /dangerouslySetInnerHTML|localStorage|sessionStorage/.test(source),
        `${label} 出现不安全渲染或浏览器存储`,
      ).toBe(false);
      expect(source.includes('@cloudflare/kumo'), `${label} 残留 Kumo 导入`).toBe(false);
      expect(
        source.includes('@phosphor-icons/react'),
        `${label} 绕过 ui/icon.tsx 直接导入 Phosphor 图标`,
      ).toBe(false);
    }
  });

  it('[M-5] 英文语言下 SettingsStage 与 LaunchpadView 起手卡标题及提示词完整切换为英文', async () => {
    const settingsStorePath = '../src/renderer/stores/settings-store.js';
    const launchpadPath = '../src/renderer/surfaces/launchpad/index.js';
    const { useSettingsStore } = (await import(settingsStorePath)) as {
      readonly useSettingsStore: {
        readonly getState: () => {
          readonly hydratePreferences: (prefs: Record<string, unknown>) => void;
          readonly resetGeneralPreferences: () => Promise<void>;
        };
      };
    };
    const { LaunchpadView } = (await import(launchpadPath)) as {
      readonly LaunchpadView: FunctionComponent<Record<string, unknown>>;
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
          codeLigatures: false,
        },
        general: {
          timeFormat: 'relative',
          sendShortcut: 'enter',
          codeWordWrap: false,
          desktopNotifications: true,
          preferredShell: 'auto',
        },
        confirmations: {
          deleteSession: true,
          archiveSession: false,
          closeActiveTerminal: true,
        },
      });

      const stageEnHtml = renderToStaticMarkup(
        createElement(settingsMod.SettingsStage, { tab: 'general', catalog: sampleCatalog }),
      );
      expect(stageEnHtml).toContain('aria-label="Settings Center"');
      expect(stageEnHtml).toContain('Back to Workspace');
      expect(stageEnHtml).toContain('Reset to Defaults');
      expect(stageEnHtml).toContain('Models &amp; Providers');

      let capturedStarterPrompt = '';
      const launchpadEnHtml = renderToStaticMarkup(
        createElement(LaunchpadView, {
          spaces: [],
          draft: 'typing check',
          onSelectStarter: (s: { readonly prompt: string }) => {
            capturedStarterPrompt = s.prompt;
          },
        }),
      );
      expect(launchpadEnHtml).toContain('What would you like to build today?');
      expect(launchpadEnHtml).toContain('Map Architecture');
      expect(launchpadEnHtml).toContain('Review Uncommitted Diff');
      expect(launchpadEnHtml).toContain('Hunt Bug &amp; Add Tests');
      expect(capturedStarterPrompt).toBe('');
    } finally {
      await useSettingsStore.getState().resetGeneralPreferences();
    }
  });
});
