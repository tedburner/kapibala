import { Button } from '@cloudflare/kumo';
import { ArrowBendDownLeftIcon } from '@phosphor-icons/react';
import { cjk } from '@streamdown/cjk';
import { code as shikiCodePlugin } from '@streamdown/code';
import { createMathPlugin } from '@streamdown/math';
import { mermaid as mermaidPlugin } from '@streamdown/mermaid';
import {
  Component,
  type ComponentProps,
  type ErrorInfo,
  type ReactNode,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import remarkGfm from 'remark-gfm';
import {
  CodeBlock,
  CodeBlockCopyButton,
  type Components,
  type ControlsConfig,
  Streamdown,
  type StreamdownTranslations,
  defaultComponents,
  defaultRemarkPlugins,
  defaultUrlTransform,
  useIsCodeFenceIncomplete,
} from 'streamdown';
import { PlainCodeBlock } from './code-display.js';
import { clipForDisplay } from './display-budget.js';
import { HtmlPreview, HtmlPreviewButton } from './html-preview.js';
import { classifyImageSource } from './markdown-image-model.js';
import { MarkdownImage } from './markdown-image.js';
import { codePreviewKind, prepareMarkdownText } from './message-markdown-model.js';

type Pluggable = NonNullable<ComponentProps<typeof Streamdown>['remarkPlugins']>[number];

/**
 * 禁用单波浪线删除线（`~a~`）：模型输出 Windows 8.3 短路径（`ADMINI~1`）或数值区间（`~10ms 到 ~20ms`）
 * 时，`remark-gfm` 与 `@streamdown/cjk` 默认开启的 `singleTilde` 会把中间整段文字误判为删除线；
 * 双波浪线 `~~删除~~` 保持不变。
 */
function withSingleTildeDisabled(plugin: Pluggable): Pluggable {
  if (Array.isArray(plugin)) {
    const [attacher, options] = plugin;
    return [
      attacher,
      {
        ...(typeof options === 'object' && options !== null ? options : {}),
        singleTilde: false,
      },
    ];
  }
  return typeof plugin === 'function' ? [plugin, { singleTilde: false }] : plugin;
}

// `@streamdown/cjk` 的 remarkPluginsAfter 末项即 remark-cjk-friendly-gfm-strikethrough，同步关闭单波浪线。
const cjkAfterPlugins = cjk.remarkPluginsAfter.map((plugin, index) =>
  index === cjk.remarkPluginsAfter.length - 1 ? withSingleTildeDisabled(plugin) : plugin,
);

const CJK_PLUGIN = {
  ...cjk,
  remarkPluginsAfter: cjkAfterPlugins,
  remarkPlugins: [...cjk.remarkPluginsBefore, ...cjkAfterPlugins],
};

const MATH_PLUGIN = createMathPlugin({
  singleDollarTextMath: true,
  errorColor: 'var(--text-color-kumo-subtle)',
});

/** 正文全功能插件集：引用固定在模块级，避免 Streamdown 因插件对象身份变化丢弃块级缓存。 */
const BODY_PLUGINS = {
  cjk: CJK_PLUGIN,
  code: shikiCodePlugin,
  math: MATH_PLUGIN,
  mermaid: mermaidPlugin,
};

/** 思考块紧凑模式插件集：保留 CJK、行内/块级公式与轻量代码框，不在折叠思考流里渲染交互式 Mermaid 画布。 */
const COMPACT_PLUGINS = {
  cjk: CJK_PLUGIN,
  code: shikiCodePlugin,
  math: MATH_PLUGIN,
};

const REMARK_PLUGINS: NonNullable<ComponentProps<typeof Streamdown>['remarkPlugins']> = [
  [remarkGfm, { singleTilde: false }],
  defaultRemarkPlugins.codeMeta,
];

/** 显式传入空 rehype 列表配合 skipHtml：禁止模型原始 HTML 进入宿主 DOM，公式由 MATH_PLUGIN 内部追加。 */
const EMPTY_REHYPE_PLUGINS: NonNullable<ComponentProps<typeof Streamdown>['rehypePlugins']> = [];

/** 统一接管外链安全门禁（交由自定义 `a` 组件调主进程 openExternal），禁用内置 window.open 弹窗。 */
const LINK_SAFETY = { enabled: false } as const;

/**
 * 控件裁剪：只开放剪贴板复制与 Mermaid 缩放/全屏；关闭所有基于 `blob:` 触发的文件下载与表格全屏，
 * 保持桌面主进程 `onBeforeRequest` 的最小放行边界，同时避免小表格顶栏堆叠过多图标。
 */
const STREAMDOWN_CONTROLS: ControlsConfig = {
  code: { copy: true, download: false },
  table: { copy: true, download: false, fullscreen: false },
  mermaid: { copy: true, download: false, fullscreen: true, panZoom: true },
  image: { download: false },
};

/** 中文无障碍标签；其中 `copyCode: '复制代码'` 是桌面端 E2E 选择器契约，改动必须同步 e2e。 */
const STREAMDOWN_TRANSLATIONS: Partial<StreamdownTranslations> = {
  close: '关闭',
  copied: '已复制',
  copyCode: '复制代码',
  copyLink: '复制链接',
  copyTable: '复制表格',
  copyTableAsCsv: '复制为 CSV',
  copyTableAsMarkdown: '复制为 Markdown',
  copyTableAsTsv: '复制为 TSV',
  errorMermaid: 'Mermaid 图表渲染失败',
  exitFullscreen: '退出全屏',
  imageNotAvailable: '图片不可用',
  mermaidAriaLabel: 'Mermaid 图表',
  resetView: '重置缩放与位置',
  tableFormatCsv: 'CSV',
  tableFormatMarkdown: 'Markdown',
  tableFormatTsv: 'TSV',
  viewFullscreen: '全屏查看',
  zoomIn: '放大',
  zoomOut: '缩小',
};

const SHIKI_THEMES: [string, string] = ['github-light', 'github-dark'];

const themeSubscribers = new Set<() => void>();
let themeObserver: MutationObserver | undefined;

function subscribeDocumentTheme(listener: () => void): () => void {
  if (typeof document !== 'undefined' && !themeObserver) {
    themeObserver = new MutationObserver(() => {
      for (const notify of themeSubscribers) notify();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-mode'],
    });
  }
  themeSubscribers.add(listener);
  return () => {
    themeSubscribers.delete(listener);
    if (themeSubscribers.size === 0 && themeObserver) {
      themeObserver.disconnect();
      themeObserver = undefined;
    }
  };
}

function getDocumentTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.dataset.mode === 'dark' ? 'dark' : 'light';
}

function useDocumentTheme(): 'light' | 'dark' {
  return useSyncExternalStore(subscribeDocumentTheme, getDocumentTheme, () => 'light');
}

function extractText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(extractText).join('');
  if (isValidElement<{ children?: ReactNode }>(children))
    return extractText(children.props.children);
  return '';
}

const LANGUAGE_CLASS = /(?:^|\s)language-([^\s]+)/;

/**
 * 围栏代码块统一出口：Streamdown Shiki 按需高亮、长行折行开关、一键复制，以及 html/svg 沙箱预览。
 *
 * 超过 {@link clipForDisplay} 展示预算的内容直接降级为 {@link PlainCodeBlock}，避免超大代码块进入
 * Shiki 分词阻塞主线程；预算内统一复用单层卡片顶栏，消除高亮块与无语言块之间的样式割裂。
 */
function FencedCodeBlock({
  code,
  language,
  compact,
}: {
  code: string;
  language: string;
  compact: boolean;
}) {
  const isIncomplete = useIsCodeFenceIncomplete();
  const clip = clipForDisplay(code);
  const [preview, setPreview] = useState(false);
  const [wrapped, setWrapped] = useState(false);
  const normalized = language.trim().toLowerCase();
  const previewKind = isIncomplete ? undefined : codePreviewKind(normalized, code.length, compact);
  if (clip.truncated) {
    return <PlainCodeBlock code={code} ariaLabel="复制代码" />;
  }
  const lineCount = code.split('\n').length;
  return (
    <div className="kapibala-code-shell min-w-0" data-code-wrap={wrapped ? 'true' : undefined}>
      <CodeBlock
        code={code}
        language={normalized || 'text'}
        isIncomplete={isIncomplete}
        lineNumbers={!compact && lineCount >= 5}
      >
        {!compact && (
          <>
            {previewKind && (
              <HtmlPreviewButton
                open={preview}
                onClick={() => setPreview((open) => !open)}
                kind={previewKind}
              />
            )}
            <Button
              className="kapibala-action kapibala-code-wrap-btn"
              variant="ghost"
              size="sm"
              shape="square"
              aria-label={wrapped ? '取消自动换行' : '自动换行'}
              aria-pressed={wrapped}
              title={wrapped ? '取消自动换行' : '自动换行'}
              onClick={() => setWrapped((value) => !value)}
            >
              <ArrowBendDownLeftIcon size={14} />
            </Button>
            <CodeBlockCopyButton code={code} />
          </>
        )}
      </CodeBlock>
      {preview && previewKind && (
        <div className="mt-2">
          <HtmlPreview html={code} label={`${previewKind} 代码预览`} />
        </div>
      )}
    </div>
  );
}

interface BoundaryProps {
  resetKey: string;
  fallbackText: string;
  className: string;
  children: ReactNode;
}

interface BoundaryState {
  failed: boolean;
}

/**
 * 单消息级 Markdown 渲染错误边界：畸形语法或第三方插件异常时就地退化为可复制纯文本，
 * 防止单条坏消息击穿会话列表上升到根级错误页；当消息内容或流式阶段更新时自动尝试恢复。
 */
class MarkdownErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.warn('[kapibala] 单条 Markdown 渲染失败，已降级为纯文本', error, info.componentStack);
  }

  override componentDidUpdate(previous: BoundaryProps): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className={`${this.props.className} whitespace-pre-wrap break-words`}>
          {this.props.fallbackText}
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * 消息正文与思考过程共用的 Markdown 渲染器（基于 Streamdown）。
 *
 * 约束与安全边界：
 * - 原始 HTML 一律跳过（`skipHtml` + 空 `rehypePlugins`），HTML/SVG 需经显式沙箱 iframe 预览；
 * - 流式阶段（`streaming = true`）启用未闭合语法自愈与块级增量缓存，完成态固定走 `static` 模式；
 * - 流式期间暂缓本地相对路径图片读取，避免半截路径触发无效 IPC 报错，流结束后一次性解析；
 * - 超出展示预算（`clipForDisplay`）的超长正文先裁剪渲染并提示用户，完整原文仍可通过「复制正文」获取；
 * - `variant="compact"` 用于折叠思考块，采用次级墨色、压平标题字阶与紧凑块间距。
 */
function MermaidErrorFallback({ chart }: { error: string; chart: string; retry: () => void }) {
  return (
    <div className="my-2 rounded-lg border border-kumo-line bg-kumo-recessed p-3 text-xs text-kumo-subtle">
      <p className="font-medium text-kumo-default">Mermaid 图表语法无法解析，已保留源码：</p>
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-kumo-default">
        {chart}
      </pre>
    </div>
  );
}

/**
 * 统一处理页内锚点跳转与受控外链打开；严禁修改 `location.hash` 或触发主框架导航。
 */
function handleMarkdownHref(rawHref: string, report: (message: string) => void): void {
  const href = rawHref.trim();
  if (!href) return;
  if (href.startsWith('#')) {
    const rawId = href.slice(1);
    if (!rawId) return;
    let targetId = rawId;
    try {
      targetId = decodeURIComponent(rawId);
    } catch {
      /* 非法百分号序列保持原字面量查找。 */
    }
    const target =
      document.getElementById(targetId) ?? document.getElementById(`user-content-${targetId}`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  if (/^(?:https?:|mailto:)/i.test(href)) {
    void window.kapibala.app
      .openExternal(href)
      .catch((error: unknown) => report(error instanceof Error ? error.message : '打开链接失败。'));
  }
}

let activeMarkdownConsumers = 0;
let latestReport: (message: string) => void = () => {};

function onDocumentClickCapture(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest('a');
  if (!anchor) return;
  const inProse = anchor.closest('.kapibala-prose') !== null;
  const inMermaidFullscreen = anchor.closest('[data-streamdown="mermaid-fullscreen"]') !== null;
  if (!inProse && !inMermaidFullscreen) return;
  const inMermaidSvg =
    inMermaidFullscreen || anchor.closest('[data-streamdown="mermaid"]') !== null;
  const href =
    anchor.getAttribute('href') ??
    anchor.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ??
    anchor.getAttribute('xlink:href') ??
    '';
  // Mermaid 图内 SVG 链接（如 `click A "#details"`）与页内 `#` 锚点必须在捕获阶段拦截，
  // 防止浏览器执行原生导航或篡改主框架 URL。
  if (inMermaidSvg || href.trim().startsWith('#')) {
    event.preventDefault();
    event.stopPropagation();
    handleMarkdownHref(href, latestReport);
  }
}

export const MessageMarkdown = memo(function MessageMarkdown({
  text,
  root,
  streaming = false,
  variant = 'body',
  report,
}: {
  text: string;
  /** 当前工作区根路径；相对路径的本地图片以它为基准解析，缺省时本地图片退化为占位。 */
  root?: string;
  /** 当前文本块是否仍处于流式追加阶段；流结束后切回静态整篇渲染自愈跨块引用。 */
  streaming?: boolean;
  /** 排版密度：`body` 为正式回答，`compact` 为思考过程等次级内容。 */
  variant?: 'body' | 'compact';
  report(message: string): void;
}) {
  const theme = useDocumentTheme();
  const compact = variant === 'compact';
  const clip = useMemo(() => clipForDisplay(text), [text]);
  const prepared = useMemo(() => prepareMarkdownText(clip.text), [clip.text]);
  const proseClass = compact ? 'kapibala-prose kapibala-prose-compact' : 'kapibala-prose';

  latestReport = report;
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (activeMarkdownConsumers === 0) {
      document.addEventListener('click', onDocumentClickCapture, true);
    }
    activeMarkdownConsumers++;
    return () => {
      activeMarkdownConsumers--;
      if (activeMarkdownConsumers === 0) {
        document.removeEventListener('click', onDocumentClickCapture, true);
      }
    };
  }, []);

  const mermaidConfig = useMemo(
    () => ({
      config: {
        // 浅色采用 neutral 单色灰阶与 PI 纸面风格对齐，深色跟随 dark；strict 禁止图内脚本执行。
        theme: theme === 'dark' ? 'dark' : 'neutral',
        securityLevel: 'strict' as const,
      },
      errorComponent: MermaidErrorFallback,
    }),
    [theme],
  );

  const urlTransform = useMemo(
    () => (url: string, key: string, node: Parameters<typeof defaultUrlTransform>[2]) => {
      if (key !== 'src') return defaultUrlTransform(url, key, node);
      // 流式输出中本地路径可能只写出前半截（如 `./docs/arch`），等流结束再发起本地读取。
      if (streaming && classifyImageSource(url).kind === 'local') return '';
      return url;
    },
    [streaming],
  );

  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => (
        <a
          href={href}
          onClick={(event) => {
            event.preventDefault();
            if (href) handleMarkdownHref(href, report);
          }}
        >
          {children}
        </a>
      ),
      strong: ({ children, className, node: _node, ...rest }) => (
        <strong data-streamdown="strong" className={className} {...rest}>
          {children}
        </strong>
      ),
      img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} root={root} report={report} />,
      code: (codeProps) => {
        const { children, className, node: _node, ...rest } = codeProps;
        const isBlock = 'data-block' in codeProps;
        if (!isBlock) {
          return (
            <code data-streamdown="inline-code" className={className} {...rest}>
              {children}
            </code>
          );
        }
        const language = LANGUAGE_CLASS.exec(className ?? '')?.[1] ?? '';
        if (!compact && language.trim().toLowerCase() === 'mermaid') {
          const DefaultCode = defaultComponents.code;
          return <DefaultCode {...codeProps} />;
        }
        const rawCode = extractText(children).replace(/\n$/, '');
        return <FencedCodeBlock code={rawCode} language={language} compact={compact} />;
      },
    }),
    [compact, report, root],
  );

  const resetKey = `${streaming ? 'stream' : 'static'}:${variant}:${clip.text.length}`;

  return (
    <MarkdownErrorBoundary resetKey={resetKey} fallbackText={clip.text} className={proseClass}>
      <div className={proseClass}>
        <Streamdown
          mode={streaming ? 'streaming' : 'static'}
          parseIncompleteMarkdown={streaming}
          isAnimating={streaming}
          animated={false}
          skipHtml
          linkSafety={LINK_SAFETY}
          controls={compact ? false : STREAMDOWN_CONTROLS}
          translations={STREAMDOWN_TRANSLATIONS}
          shikiTheme={SHIKI_THEMES}
          codeBlockMaxHeight={0}
          tableMaxHeight={0}
          mermaid={mermaidConfig}
          plugins={compact ? COMPACT_PLUGINS : BODY_PLUGINS}
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={EMPTY_REHYPE_PLUGINS}
          urlTransform={urlTransform}
          components={components}
        >
          {prepared}
        </Streamdown>
        {clip.truncated && (
          <p className="mt-2 text-xs text-kumo-subtle">
            正文超过展示预算，已截断显示；可通过下方「复制正文」获取完整内容。
          </p>
        )}
      </div>
    </MarkdownErrorBoundary>
  );
});
