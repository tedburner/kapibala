import { CodeHighlighted, normalizeLanguage } from '@cloudflare/kumo/code';
import { Children, isValidElement } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PlainCodeBlock } from './code-display.js';
import { clipForDisplay } from './display-budget.js';

/** Markdown 仅解析公开文本；外链交给 Main，代码高亮与复制复用 Kumo，不执行 HTML 或远程图片。 */
export function MessageMarkdown({ text, report }: { text: string; report(message: string): void }) {
  return (
    <div className="kapibala-prose">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
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
          img: ({ alt }) => <span>{alt ? `[图片：${alt}]` : '[图片]'}</span>,
          pre: ({ children }) => {
            const child = Children.toArray(children)[0];
            if (!isValidElement<{ className?: string; children?: unknown }>(child))
              return <pre>{children}</pre>;
            const code = String(child.props.children ?? '').replace(/\n$/, '');
            const language = normalizeLanguage(
              child.props.className?.replace(/^language-/, '') ?? '',
            );
            const clip = clipForDisplay(code);
            // 无法识别的语言不进高亮组件（避免必然告警），超限内容不整段 tokenize；
            // 两者都走带复制与截断提示的纯文本回退，完整内容仍以会话历史为准。
            if (!language || clip.truncated)
              return <PlainCodeBlock code={code} ariaLabel="复制代码内容" />;
            return (
              <CodeHighlighted
                code={code}
                lang={language}
                showCopyButton
                labels={{ copy: '复制代码', copied: '已复制' }}
              />
            );
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
