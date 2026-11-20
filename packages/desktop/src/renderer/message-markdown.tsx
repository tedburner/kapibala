import { CodeHighlighted, normalizeLanguage } from '@cloudflare/kumo/code';
import { Children, isValidElement, useState } from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly';
import remarkGfm from 'remark-gfm';
import { PlainCodeBlock } from './code-display.js';
import { clipForDisplay } from './display-budget.js';
import { HTML_PREVIEW_LIMIT } from './html-preview-model.js';
import { HtmlPreview, HtmlPreviewButton } from './html-preview.js';
import { MarkdownImage } from './markdown-image.js';

/**
 * 代码块统一出口：高亮、复制与 html/svg 代码块的沙箱预览。
 *
 * 高亮由 Kumo 的 Shiki 组件负责；五行以上的块补行号，长行保持横向滚动而不折行。
 * 预览默认不挂载，用户点开才创建 iframe；内容超过 {@link HTML_PREVIEW_LIMIT}
 * 时不给预览入口，避免把超大文档复制进渲染进程。无法识别语言或超限内容走纯文本
 * 回退，完整原文仍以会话历史为准。
 */
function CodeBlock({ code, language }: { code: string; language: string }) {
  const clip = clipForDisplay(code);
  const [preview, setPreview] = useState(false);
  // html 与 svg 都能在沙箱 iframe 里安全预览：svg 经裸片段包装后 SMIL 动画照常播放。
  const previewKind =
    (language === 'html' || language === 'svg') && code.length <= HTML_PREVIEW_LIMIT
      ? language === 'svg'
        ? 'SVG'
        : 'HTML'
      : undefined;
  return (
    <div className="min-w-0">
      {previewKind && (
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-xs text-kumo-subtle">{previewKind}</span>
          <HtmlPreviewButton
            open={preview}
            onClick={() => setPreview(!preview)}
            kind={previewKind}
          />
        </div>
      )}
      {!language || clip.truncated ? (
        <PlainCodeBlock code={code} ariaLabel="复制代码内容" />
      ) : (
        <CodeHighlighted
          code={code}
          lang={language}
          showLineNumbers={code.split('\n').length >= 5}
          showCopyButton
          labels={{ copy: '复制代码', copied: '已复制' }}
        />
      )}
      {preview && previewKind && (
        <div className="mt-2">
          <HtmlPreview html={code} label={`${previewKind} 代码预览`} />
        </div>
      )}
    </div>
  );
}

/** Markdown 仅解析公开文本；原始 HTML 需经显式沙箱预览，图片只渲染远程与 data:image。 */
export function MessageMarkdown({
  text,
  root,
  report,
}: {
  text: string;
  /** 当前工作区根路径；相对路径的本地图片以它为基准解析，缺省时本地图片退化为占位。 */
  root?: string;
  report(message: string): void;
}) {
  return (
    <div className="kapibala-prose">
      <Markdown
        remarkPlugins={[remarkGfm, remarkCjkFriendly]}
        skipHtml
        // 图片地址交给 MarkdownImage 分类：默认 urlTransform 会剥掉 data:image，
        // 这里只对 src 放行，href 仍走默认协议白名单。
        urlTransform={(url, key) => (key === 'src' ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (href)
                  void window.kapibala.app
                    .openExternal(href)
                    .catch((error) => report(error.message));
              }}
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} root={root} report={report} />,
          pre: ({ children }) => {
            const child = Children.toArray(children)[0];
            if (!isValidElement<{ className?: string; children?: unknown }>(child))
              return <pre>{children}</pre>;
            const code = String(child.props.children ?? '').replace(/\n$/, '');
            const language =
              normalizeLanguage(child.props.className?.replace(/^language-/, '') ?? '') ?? '';
            return <CodeBlock code={code} language={language} />;
          },
          table: ({ children }) => (
            <div className="max-w-full overflow-x-auto">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
