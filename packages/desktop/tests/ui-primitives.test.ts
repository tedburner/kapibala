import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { type FunctionComponent, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const stylesDir = path.resolve(currentDir, '../src/renderer/styles');
const uiDir = path.resolve(currentDir, '../src/renderer/ui');

/**
 * Node 测试环境加载渲染层原语桶的最小契约投影：
 * `tsconfig.node.json` 不启用 `--jsx`，故测试侧不直接静态 import `.tsx` 模块，
 * 渲染层严格类型校验由 `tsconfig.renderer.json` 完整覆盖。
 */
interface LoadedUiPrimitives {
  readonly AgentActivityGlyph: FunctionComponent<Record<string, unknown>>;
  readonly AGENT_ACTIVITY_KINDS: readonly string[];
  readonly resolveToolActivityKind: (toolName: string | undefined) => string;
  readonly computeActivityGlyphFrame: (
    kind: string,
    size: number,
    tSec: number,
  ) => Record<string, unknown>;
  readonly Button: FunctionComponent<Record<string, unknown>>;
  readonly IconButton: FunctionComponent<Record<string, unknown>>;
  readonly TextField: FunctionComponent<Record<string, unknown>>;
  readonly TextArea: FunctionComponent<Record<string, unknown>>;
  readonly SearchField: FunctionComponent<Record<string, unknown>>;
  readonly SecretField: FunctionComponent<Record<string, unknown>>;
  readonly Switch: FunctionComponent<Record<string, unknown>>;
  readonly Segmented: FunctionComponent<Record<string, unknown>>;
  readonly ModalDialog: FunctionComponent<Record<string, unknown>>;
  readonly AnchoredPopover: FunctionComponent<Record<string, unknown>>;
  readonly ActionMenu: FunctionComponent<Record<string, unknown>>;
  readonly Select: FunctionComponent<Record<string, unknown>>;
  readonly Combobox: FunctionComponent<Record<string, unknown>>;
  readonly Badge: FunctionComponent<Record<string, unknown>>;
  readonly HarnessBadge: FunctionComponent<Record<string, unknown>>;
  readonly StatusDot: FunctionComponent<Record<string, unknown>>;
  readonly Kbd: FunctionComponent<Record<string, unknown>>;
  readonly BrandMark: FunctionComponent<Record<string, unknown>>;
  readonly MiddleTruncate: FunctionComponent<Record<string, unknown>>;
  readonly SplitPane: FunctionComponent<Record<string, unknown>>;
  readonly SettingSection: FunctionComponent<Record<string, unknown>>;
  readonly SettingRow: FunctionComponent<Record<string, unknown>>;
  readonly EmptyState: FunctionComponent<Record<string, unknown>>;
  readonly ToastViewport: FunctionComponent<Record<string, unknown>>;
  readonly SPLIT_DEFAULT_RATIO: number;
  readonly computePopoverPosition: (
    anchor: {
      readonly top: number;
      readonly bottom: number;
      readonly left: number;
      readonly right: number;
      readonly width: number;
      readonly height: number;
    },
    floating: { readonly width: number; readonly height: number },
    viewport: { readonly width: number; readonly height: number },
    placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end',
  ) => { readonly top: number; readonly left: number; readonly resolvedPlacement: string };
  readonly truncateMiddle: (
    value: string,
    maxChars?: number,
    minTailChars?: number,
  ) => {
    readonly truncated: boolean;
    readonly display: string;
    readonly head: string;
    readonly tail: string;
  };
  readonly clampSplitRatio: (ratio: number, containerWidth?: number) => number;
  readonly appendToast: <T extends { readonly id: string; readonly title: string }>(
    current: readonly T[],
    incoming: T,
    maxItems?: number,
  ) => T[];
  readonly dismissToast: <T extends { readonly id: string }>(
    current: readonly T[],
    id: string,
  ) => T[];
}

let ui: LoadedUiPrimitives;

beforeAll(async () => {
  /* 根 vitest.config.ts 在纯 Node 环境下使用 esbuild 默认 classic JSX 转换（输出 React.createElement），
   * 注入全局 React 绑定以供动态加载的渲染层 .tsx 组件执行 SSR。 */
  (globalThis as Record<string, unknown>).React = React;
  const modulePath: string = '../src/renderer/ui/index.js';
  ui = (await import(modulePath)) as LoadedUiPrimitives;
});

describe('Zero-Kumo 原生基础控件 SSR 语义与无障碍契约', () => {
  it('Button 与 IconButton 默认锁定 type="button"，并正确输出尺寸、变体、加载态与必填 aria-label', () => {
    const buttonHtml = renderToStaticMarkup(
      createElement(ui.Button, { variant: 'solid', size: 'sm', leadingIcon: 'plus' }, '新建会话'),
    );
    expect(buttonHtml).toContain('type="button"');
    expect(buttonHtml).toContain('data-variant="solid"');
    expect(buttonHtml).toContain('data-size="sm"');
    expect(buttonHtml).toContain('新建会话');

    const loadingHtml = renderToStaticMarkup(createElement(ui.Button, { loading: true }, '连接中'));
    expect(loadingHtml).toContain('disabled=""');
    expect(loadingHtml).toContain('aria-busy="true"');

    const iconBtnHtml = renderToStaticMarkup(
      createElement(ui.IconButton, {
        icon: 'sidebar',
        'aria-label': '展开或收起侧栏',
        active: true,
      }),
    );
    expect(iconBtnHtml).toContain('type="button"');
    expect(iconBtnHtml).toContain('aria-label="展开或收起侧栏"');
    expect(iconBtnHtml).toContain('title="展开或收起侧栏"');
    expect(iconBtnHtml).toContain('data-active="true"');
  });

  it('TextField / TextArea / SearchField / SecretField 自动关联 label、说明与校验错误', () => {
    const fieldHtml = renderToStaticMarkup(
      createElement(ui.TextField, {
        label: '模型端点',
        description: '填写兼容 OpenAI 的基础 URL',
        error: '端点格式无效',
        mono: true,
        defaultValue: 'https://api.example.com',
      }),
    );
    expect(fieldHtml).toContain('<label for=');
    expect(fieldHtml).toContain('aria-invalid="true"');
    expect(fieldHtml).toContain('aria-describedby=');
    expect(fieldHtml).toContain('role="alert"');
    expect(fieldHtml).toContain('data-mono="true"');

    const areaHtml = renderToStaticMarkup(
      createElement(ui.TextArea, {
        label: '系统指令',
        rows: 4,
        defaultValue: '保持简洁',
      }),
    );
    expect(areaHtml).toContain('<textarea');
    expect(areaHtml).toContain('rows="4"');

    const searchHtml = renderToStaticMarkup(
      createElement(ui.SearchField, {
        'aria-label': '搜索会话或命令',
        value: 'mcp',
        onValueChange: () => {},
      }),
    );
    expect(searchHtml).toContain('type="search"');
    expect(searchHtml).toContain('aria-label="清空搜索"');

    const secretHtml = renderToStaticMarkup(
      createElement(ui.SecretField, {
        label: 'API 密钥',
        configured: true,
      }),
    );
    expect(secretHtml).toContain('type="password"');
    expect(secretHtml).toContain('placeholder="已配置密钥（留空保持不变）"');
    expect(secretHtml).toContain('aria-label="显示密钥"');
  });

  it('Switch 输出原生 button[role="switch"] 与 aria-checked 状态，Segmented 输出 radiogroup 漫游焦点', () => {
    const checkedSwitch = renderToStaticMarkup(
      createElement(ui.Switch, { checked: true, label: '启用外部代理' }),
    );
    expect(checkedSwitch).toContain('type="button"');
    expect(checkedSwitch).toContain('role="switch"');
    expect(checkedSwitch).toContain('aria-checked="true"');
    expect(checkedSwitch).toContain('data-state="checked"');
    expect(checkedSwitch).toContain('启用外部代理');

    const uncheckedSwitch = renderToStaticMarkup(
      createElement(ui.Switch, { checked: false, 'aria-label': '自动重试' }),
    );
    expect(uncheckedSwitch).toContain('aria-checked="false"');
    expect(uncheckedSwitch).toContain('data-state="unchecked"');

    const segmentedHtml = renderToStaticMarkup(
      createElement(ui.Segmented, {
        'aria-label': '外观模式',
        value: 'dark',
        onValueChange: () => {},
        options: [
          { value: 'light', label: '浅色', icon: 'sun' },
          { value: 'dark', label: '深色', icon: 'moon' },
        ],
      }),
    );
    expect(segmentedHtml).toContain('role="radiogroup"');
    expect(segmentedHtml).toContain('role="radio"');
    expect(segmentedHtml).toContain('aria-checked="true"');
    expect(segmentedHtml).toContain('tabindex="0"');
    expect(segmentedHtml).toContain('tabindex="-1"');
  });

  it('ModalDialog 使用原生 <dialog> 且不冗余注入 role="dialog" 或 aria-modal', () => {
    const dialogHtml = renderToStaticMarkup(
      createElement(
        ui.ModalDialog,
        {
          open: true,
          onOpenChange: () => {},
          title: '信任此文件夹吗？',
          description: '授权后代理可在工作区内执行工具。',
          closedBy: 'any',
        },
        createElement('p', null, '项目路径确认'),
      ),
    );
    expect(dialogHtml).toContain('<dialog');
    expect(dialogHtml).toContain('closedby="any"');
    expect(dialogHtml).toContain('信任此文件夹吗？');
    expect(dialogHtml).not.toContain('role="dialog"');
    expect(dialogHtml).not.toContain('aria-modal');
  });

  it('AnchoredPopover、ActionMenu、Select 与 Combobox 区分弹层、菜单与列表框语义，并支持边缘翻转', () => {
    const plainPopoverHtml = renderToStaticMarkup(
      createElement(
        ui.AnchoredPopover,
        {
          open: true,
          onOpenChange: () => {},
          trigger: createElement(ui.Button, null, '任务清单'),
        },
        createElement('div', null, '清单内容'),
      ),
    );
    expect(plainPopoverHtml).toContain('popover="auto"');
    expect(plainPopoverHtml).not.toContain('role="menu"');

    const menuHtml = renderToStaticMarkup(
      createElement(ui.ActionMenu, {
        label: '会话操作',
        open: true,
        items: [
          { id: 'pin', label: '置顶会话', icon: 'push-pin', onSelect: () => {} },
          { type: 'separator', id: 'sep-1' },
          { id: 'del', label: '删除会话', danger: true, shortcut: '⌫', onSelect: () => {} },
        ],
        renderTrigger: (props: {
          readonly toggle: () => void;
          readonly 'aria-haspopup': 'menu';
          readonly 'aria-expanded': boolean;
        }) =>
          createElement(ui.IconButton, {
            icon: 'dots-three',
            'aria-label': '会话操作',
            'aria-haspopup': props['aria-haspopup'],
            'aria-expanded': props['aria-expanded'],
            onClick: props.toggle,
          }),
      }),
    );
    expect(menuHtml).toContain('role="menu"');
    expect(menuHtml).toContain('role="menuitem"');
    expect(menuHtml).toContain('data-danger="true"');
    expect(menuHtml).toContain('<kbd');

    const flipped = ui.computePopoverPosition(
      { top: 560, bottom: 588, left: 680, right: 780, width: 100, height: 28 },
      { width: 220, height: 180 },
      { width: 800, height: 600 },
      'bottom-start',
    );
    expect(flipped.resolvedPlacement).toBe('top-start');
    expect(flipped.top).toBeLessThan(560);
    expect(flipped.left).toBeLessThanOrEqual(800 - 220 - 8);

    const selectHtml = renderToStaticMarkup(
      createElement(ui.Select, {
        'aria-label': '权限模式',
        value: 'confirm',
        onValueChange: () => {},
        options: [
          { value: 'confirm', label: '变更前确认' },
          { value: 'auto', label: '工作区自动写入' },
        ],
      }),
    );
    expect(selectHtml).toContain('role="combobox"');
    expect(selectHtml).toContain('aria-haspopup="listbox"');
    expect(selectHtml).toContain('变更前确认');

    const comboHtml = renderToStaticMarkup(
      createElement(ui.Combobox, {
        'aria-label': '选择模型或代理',
        value: 'deepseek-flash',
        onValueChange: () => {},
        options: [
          { value: 'deepseek-flash', label: 'DeepSeek Flash', group: '本地模型' },
          { value: 'claude-cli', label: 'Claude Code', group: '外部代理', badge: 'CLI' },
        ],
      }),
    );
    expect(comboHtml).toContain('DeepSeek Flash');
    expect(comboHtml).toContain('aria-haspopup="listbox"');
  });

  it('Badge / HarnessBadge / StatusDot / Kbd 完整携带无障碍状态词，绝不仅靠颜色表达状态', () => {
    const harnessHtml = renderToStaticMarkup(
      createElement(ui.HarnessBadge, {
        kind: 'external',
        label: 'Claude Code',
        transportLabel: 'CLI',
        worktreeBranch: 'wt/auth',
      }),
    );
    expect(harnessHtml).toContain('Claude Code · CLI');
    expect(harnessHtml).toContain('wt/auth');

    const dotHiddenLabelHtml = renderToStaticMarkup(
      createElement(ui.StatusDot, { status: 'waiting_approval' }),
    );
    expect(dotHiddenLabelHtml).toContain('data-status="waiting_approval"');
    expect(dotHiddenLabelHtml).toContain('class="kpbl-sr-only">待审批</span>');

    const dotVisibleHtml = renderToStaticMarkup(
      createElement(ui.StatusDot, { status: 'running', showLabel: true }),
    );
    expect(dotVisibleHtml).toContain('运行中');

    const brandHtml = renderToStaticMarkup(
      createElement(ui.BrandMark, { decorative: false, label: 'Kapibala 标识' }),
    );
    expect(brandHtml).toContain('role="img"');
    expect(brandHtml).toContain('var(--kpbl-pulse)');
    expect(brandHtml).toContain('var(--kpbl-ink-strong)');
  });

  it('AgentActivityGlyph 覆盖 8 类语义墨线动效，零硬编码色值且遵循无障碍状态词与小尺寸点阵自适应', () => {
    expect(ui.AGENT_ACTIVITY_KINDS).toEqual([
      'thinking',
      'reading',
      'searching',
      'writing',
      'checking',
      'sending',
      'on_hold',
      'waiting',
    ]);
    expect(ui.resolveToolActivityKind('read_file')).toBe('reading');
    expect(ui.resolveToolActivityKind('grep')).toBe('searching');
    expect(ui.resolveToolActivityKind('edit_file')).toBe('writing');
    expect(ui.resolveToolActivityKind('run_command')).toBe('checking');
    expect(ui.resolveToolActivityKind('spawn_agent')).toBe('sending');
    expect(ui.resolveToolActivityKind('Bash')).toBe('checking');
    expect(ui.resolveToolActivityKind('custom_unknown_tool')).toBe('waiting');

    for (const kind of ui.AGENT_ACTIVITY_KINDS) {
      const html = renderToStaticMarkup(createElement(ui.AgentActivityGlyph, { kind, size: 16 }));
      expect(html).toContain(`data-activity="${kind}"`);
      expect(html).toContain('var(--kpbl-pulse)');
      expect(html).toContain('class="kpbl-sr-only"');
      expect(/#(?:[0-9a-fA-F]{3}){1,2}\b|\b(?:rgb|hsl|oklch)a?\(/.test(html)).toBe(false);
    }

    const visibleLabelHtml = renderToStaticMarkup(
      createElement(ui.AgentActivityGlyph, {
        kind: 'on_hold',
        size: 16,
        showLabel: true,
        label: '等待人工审批确认…',
      }),
    );
    expect(visibleLabelHtml).toContain('等待人工审批确认…');
    expect(visibleLabelHtml).not.toContain('kpbl-sr-only');

    const decorativeHtml = renderToStaticMarkup(
      createElement(ui.AgentActivityGlyph, { kind: 'thinking', size: 14, decorative: true }),
    );
    expect(decorativeHtml.startsWith('<svg')).toBe(true);
    expect(decorativeHtml).toContain('aria-hidden="true"');

    const smallSearch = ui.computeActivityGlyphFrame('searching', 16, 1.65) as {
      searching: { dots: readonly unknown[] };
    };
    const largeSearch = ui.computeActivityGlyphFrame('searching', 36, 1.65) as {
      searching: { dots: readonly unknown[] };
    };
    expect(smallSearch.searching.dots).toHaveLength(9);
    expect(largeSearch.searching.dots).toHaveLength(16);
  });

  it('MiddleTruncate 保留路径首段与末尾文件名，安全处理 Emoji 与多字节码点并附带完整 title', () => {
    const shortPart = ui.truncateMiddle('src/App.tsx', 32);
    expect(shortPart.truncated).toBe(false);
    expect(shortPart.display).toBe('src/App.tsx');

    const longPath = 'packages/desktop/src/renderer/surfaces/workbench/WorkbenchInspectorStage.tsx';
    const truncated = ui.truncateMiddle(longPath, 42);
    expect(truncated.truncated).toBe(true);
    expect(truncated.tail).toBe('/WorkbenchInspectorStage.tsx');
    expect(truncated.display.endsWith('/WorkbenchInspectorStage.tsx')).toBe(true);

    const emojiSafe = ui.truncateMiddle('🦫🌊🍊Kapibala工作台超长命令参数回显测试段', 16);
    expect(emojiSafe.truncated).toBe(true);
    expect(emojiSafe.display.includes('\uFFFD')).toBe(false);

    const html = renderToStaticMarkup(
      createElement(ui.MiddleTruncate, { text: longPath, maxChars: 42, mono: true }),
    );
    expect(html).toContain(`title="${longPath}"`);
    expect(html).toContain('/WorkbenchInspectorStage.tsx');
  });

  it('SplitPane 遵守左最小 420px、右 360px..60% 比例夹逼并输出可聚焦 separator 滑块属性', () => {
    /* 1200px 容器：左最小 420px => 右最大 780/1200 = 0.65，再受 0.60 上限约束 => max = 0.60；右最小 360/1200 = 0.30。 */
    expect(ui.clampSplitRatio(0.1, 1200)).toBeCloseTo(0.3, 4);
    expect(ui.clampSplitRatio(0.85, 1200)).toBeCloseTo(0.6, 4);
    expect(ui.clampSplitRatio(Number.NaN, 1200)).toBeCloseTo(ui.SPLIT_DEFAULT_RATIO, 4);

    /* 900px 紧凑容器：左最小 420px => 右最大 (900 - 420)/900 = 0.5333；右最小 360/900 = 0.40。 */
    expect(ui.clampSplitRatio(0.6, 900)).toBeCloseTo(480 / 900, 4);
    expect(ui.clampSplitRatio(0.2, 900)).toBeCloseTo(0.4, 4);

    const closedHtml = renderToStaticMarkup(
      createElement(ui.SplitPane, {
        rightOpen: false,
        left: createElement('div', null, '对话主列'),
        right: createElement('div', null, '工作台'),
      }),
    );
    expect(closedHtml).toContain('对话主列');
    expect(closedHtml).not.toContain('role="separator"');
    expect(closedHtml).not.toContain('工作台');

    const openHtml = renderToStaticMarkup(
      createElement(ui.SplitPane, {
        rightOpen: true,
        ratio: 0.45,
        left: createElement('div', null, '对话主列'),
        right: createElement('div', null, '工作台'),
      }),
    );
    expect(openHtml).toContain('role="separator"');
    expect(openHtml).toContain('aria-valuenow="45"');
    expect(openHtml).toContain('工作台');
  });

  it('SettingSection / SettingRow / EmptyState 与 ToastViewport 符合单层布局及通知角色分级', () => {
    const settingsHtml = renderToStaticMarkup(
      createElement(
        ui.SettingSection,
        { title: '外部代理', description: '管理 CLI 与 ACP 连接器' },
        createElement(
          ui.SettingRow,
          {
            title: 'Claude Code',
            description: 'claude --output-format stream-json',
            control: createElement(ui.Switch, { checked: true, 'aria-label': '启用 Claude Code' }),
          },
          createElement('div', null, '路径覆盖详情'),
        ),
      ),
    );
    expect(settingsHtml).toContain('<section');
    expect(settingsHtml).toContain('aria-labelledby=');
    expect(settingsHtml).toContain('路径覆盖详情');

    const emptyToastHtml = renderToStaticMarkup(
      createElement(ui.ToastViewport, { toasts: [], onDismiss: () => {} }),
    );
    expect(emptyToastHtml).toBe('');

    const queue = ui.appendToast([{ id: 't1', level: 'info', title: '旧消息' }], {
      id: 't1',
      level: 'info',
      title: '刷新后的消息',
    });
    expect(queue).toHaveLength(1);
    expect(queue[0]?.title).toBe('刷新后的消息');
    expect(ui.dismissToast(queue, 't1')).toHaveLength(0);

    const toastHtml = renderToStaticMarkup(
      createElement(ui.ToastViewport, {
        toasts: [
          { id: 'ok', level: 'success', title: '连接成功' },
          { id: 'err', level: 'error', title: '探针超时' },
        ],
        onDismiss: () => {},
      }),
    );
    expect(toastHtml).toContain('role="status"');
    expect(toastHtml).toContain('role="alert"');
    expect(toastHtml).toContain('aria-label="关闭通知：探针超时"');
  });
});

describe('UI 2.0 静态行数防线、零硬编码色值与双主题令牌完整性审计', () => {
  it('src/renderer/ui/ 下全部模块单文件 <= 450 行、零色值字面量、零 Kumo 导入且图标进口唯一收束', () => {
    const entries = fs
      .readdirSync(uiDir)
      .filter((name) => /\.(ts|tsx)$/.test(name))
      .sort();
    expect(entries).toEqual([
      'activity-glyph-clock.ts',
      'activity-glyph-frames.ts',
      'activity-glyph.tsx',
      'badges.tsx',
      'button.tsx',
      'dialog.tsx',
      'fields.tsx',
      'icon.tsx',
      'index.ts',
      'popover.tsx',
      'segmented.tsx',
      'select.tsx',
      'settings-kit.tsx',
      'split-pane.tsx',
      'switch.tsx',
      'toast.tsx',
      'truncate.tsx',
    ]);

    for (const name of entries) {
      const source = fs.readFileSync(path.join(uiDir, name), 'utf8');
      const lineCount = source.split(/\r?\n/).length;
      expect(lineCount, `${name} 超过 450 行上限`).toBeLessThanOrEqual(450);
      expect(
        /#(?:[0-9a-fA-F]{3}){1,2}\b|\b(?:rgb|hsl|oklch)a?\(/.test(source),
        `${name} 出现硬编码颜色字面量`,
      ).toBe(false);
      expect(
        /transition-all|transition:\s*all|@keyframes|\banimate-[a-z]/.test(source),
        `${name} 出现违禁未受限动效`,
      ).toBe(false);
      expect(source.includes('@cloudflare/kumo'), `${name} 残留 Kumo 依赖`).toBe(false);
      if (name !== 'icon.tsx') {
        expect(
          source.includes('@phosphor-icons/react'),
          `${name} 绕过 ui/icon.tsx 直接导入 Phosphor 图标`,
        ).toBe(false);
      }
    }
  });

  it('styles/ 五层文件完备定义浅色与深色语义令牌及 Shiki 语法令牌，且非令牌样式表零硬编码色值', () => {
    const tokensCss = fs.readFileSync(path.join(stylesDir, 'tokens.css'), 'utf8');
    const shikiCss = fs.readFileSync(path.join(stylesDir, 'shiki.css'), 'utf8');
    const baseCss = fs.readFileSync(path.join(stylesDir, 'base.css'), 'utf8');
    const proseCss = fs.readFileSync(path.join(stylesDir, 'prose.css'), 'utf8');
    const workbenchCss = fs.readFileSync(path.join(stylesDir, 'workbench.css'), 'utf8');
    const indexCss = fs.readFileSync(path.join(stylesDir, 'index.css'), 'utf8');

    expect(indexCss).toContain(
      '@layer reset, tokens, base, prose, shiki, primitives, workbench, utilities;',
    );
    expect(tokensCss).toContain(':root[data-mode="light"]');
    expect(tokensCss).toContain('color-scheme: only light;');
    expect(tokensCss).toContain(':root[data-mode="dark"]');
    expect(tokensCss).toContain('color-scheme: only dark;');

    /* 深色左栏严禁退化为 #000000 纯黑（017 §3.1）。 */
    const darkBlock = tokensCss.slice(tokensCss.indexOf(':root[data-mode="dark"]'));
    expect(darkBlock).toContain('--kpbl-bg-rail: #111214;');

    const requiredSemanticTokens = [
      '--kpbl-bg-rail',
      '--kpbl-bg-canvas',
      '--kpbl-bg-surface',
      '--kpbl-bg-elevated',
      '--kpbl-bg-subtle',
      '--kpbl-bg-active',
      '--kpbl-ink-strong',
      '--kpbl-ink-default',
      '--kpbl-ink-subtle',
      '--kpbl-ink-faint',
      '--kpbl-control-solid',
      '--kpbl-control-on-solid',
      '--kpbl-pulse',
      '--kpbl-pulse-soft',
      '--kpbl-line-subtle',
      '--kpbl-line-default',
      '--kpbl-line-strong',
      '--kpbl-status-success',
      '--kpbl-status-success-soft',
      '--kpbl-status-warning',
      '--kpbl-status-warning-soft',
      '--kpbl-status-danger',
      '--kpbl-status-danger-soft',
      '--kpbl-status-info',
      '--kpbl-status-info-soft',
      '--kpbl-shadow-popover',
      '--kpbl-shadow-dialog',
    ];
    for (const token of requiredSemanticTokens) {
      expect(tokensCss, `浅色块缺失 ${token}`).toContain(`${token}:`);
      expect(darkBlock, `深色块缺失 ${token}`).toContain(`${token}:`);
    }

    for (const scaleToken of [
      '--kpbl-r-xs: 4px;',
      '--kpbl-r-sm: 6px;',
      '--kpbl-r-md: 10px;',
      '--kpbl-r-lg: 14px;',
      '--kpbl-r-full: 9999px;',
      '--kpbl-control-xs: 24px;',
      '--kpbl-control-sm: 28px;',
      '--kpbl-control-md: 32px;',
      '--kpbl-control-lg: 36px;',
    ]) {
      expect(tokensCss).toContain(scaleToken);
    }

    const shikiDarkBlock = shikiCss.slice(shikiCss.indexOf(':root[data-mode="dark"]'));
    for (const syntaxToken of [
      '--kpbl-code-fg',
      '--kpbl-code-keyword',
      '--kpbl-code-function',
      '--kpbl-code-string',
      '--kpbl-code-type',
      '--kpbl-code-number',
      '--kpbl-code-comment',
    ]) {
      expect(shikiCss, `Shiki 浅色缺失 ${syntaxToken}`).toContain(`${syntaxToken}:`);
      expect(shikiDarkBlock, `Shiki 深色缺失 ${syntaxToken}`).toContain(`${syntaxToken}:`);
    }
    expect(shikiCss).toContain('font-style: normal;');
    expect(shikiCss).toContain('font-size: var(--kpbl-text-code, var(--kpbl-text-md));');
    expect(shikiCss).toContain(':root[data-code-ligatures="true"]');

    const shellCss = fs.readFileSync(path.join(stylesDir, 'shell.css'), 'utf8');
    expect(shellCss).not.toContain('--kpbl-duration-normal');

    const dialogSource = fs.readFileSync(path.join(uiDir, 'dialog.tsx'), 'utf8');
    expect(dialogSource).toContain('[popover]:popover-open');
    expect(dialogSource).toContain('hidePopover');
    const popoverSource = fs.readFileSync(path.join(uiDir, 'popover.tsx'), 'utf8');
    expect(popoverSource).toContain('wasOpenRef');
    expect(popoverSource).toContain('data-open="true"');

    expect(baseCss).toContain('isolation: isolate;');
    expect(baseCss).toContain('prefers-reduced-motion: reduce');
    expect(baseCss).toContain('transition-duration: 0s !important;');
    expect(proseCss).toContain('content-visibility: visible;');

    for (const [label, css] of [
      ['base.css', baseCss],
      ['prose.css', proseCss],
      ['workbench.css', workbenchCss],
      ['index.css', indexCss],
    ] as const) {
      expect(
        /#(?:[0-9a-fA-F]{3}){1,2}\b|\b(?:rgb|hsl|oklch)a?\(/.test(css),
        `${label} 不得包含原始色值字面量`,
      ).toBe(false);
    }
  });
});
