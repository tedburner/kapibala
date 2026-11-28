import { useEffect, useRef, useState } from 'react';
import { CodeBlock, CodeBlockCopyButton, useIsCodeFenceIncomplete } from 'streamdown';
import { clipForDisplay } from './display-budget.js';
import { HtmlPreview, HtmlPreviewButton } from './html-preview.js';
import { codePreviewKind } from './message-markdown-model.js';
import { useSettingsStore } from './stores/index.js';
import { Button, IconButton } from './ui/index.js';

/**
 * 纯文本代码回退块：工作台原始载荷与超过展示预算的代码块在这里渲染，
 * 不进入语法高亮管线（避免超大文本整段分词阻塞主线程），保留复制能力。
 * 只渲染经预算裁剪后的文本；截断时复制完整原文并向用户明示显示范围。
 */
export function PlainCodeBlock({
  code,
  maximum,
  ariaLabel,
}: {
  code: string;
  /** 覆盖默认预算仅供测试；生产调用方不得缩小语义（不放大、不绕过截断提示）。 */
  maximum?: number;
  ariaLabel: string;
}) {
  const clip = clipForDisplay(code, maximum);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs" style={{ color: 'var(--kpbl-ink-subtle)' }}>
          {clip.truncated ? '内容超过展示预算，已截断显示；可复制完整内容' : '文本'}
        </span>
        <Button
          size="xs"
          variant="ghost"
          aria-label={clip.truncated ? `${ariaLabel}（完整内容）` : ariaLabel}
          onClick={() => {
            void navigator.clipboard
              .writeText(code)
              .then(() => {
                setCopyError(false);
                setCopied(true);
                window.clearTimeout(timer.current);
                timer.current = window.setTimeout(() => setCopied(false), 1_500);
              })
              .catch(() => {
                setCopied(false);
                setCopyError(true);
              });
          }}
        >
          {copied ? '已复制' : clip.truncated ? '复制完整内容' : '复制'}
        </Button>
      </div>
      {copyError && (
        <p role="alert" className="text-xs" style={{ color: 'var(--kpbl-status-danger)' }}>
          复制失败，请检查剪贴板权限。
        </p>
      )}
      <pre className="kpbl-inspector-pre overflow-x-auto">
        <code>{clip.text}</code>
      </pre>
    </div>
  );
}

/**
 * 围栏代码块统一出口：Streamdown Shiki 按需高亮、长行折行开关、一键复制，以及 html/svg 沙箱预览。
 *
 * 超过 {@link clipForDisplay} 展示预算的内容直接降级为 {@link PlainCodeBlock}，避免超大代码块进入
 * Shiki 分词阻塞主线程；预算内统一复用单层卡片顶栏，消除高亮块与无语言块之间的样式割裂。
 */
export function FencedCodeBlock({
  code,
  language,
  compact,
}: {
  code: string;
  language: string;
  compact: boolean;
}) {
  const isIncomplete = useIsCodeFenceIncomplete();
  const defaultWrap = useSettingsStore((s) => s.general.codeWordWrap);
  const clip = clipForDisplay(code);
  const [preview, setPreview] = useState(false);
  const [wrapOverride, setWrapOverride] = useState<boolean | undefined>(undefined);
  const wrapped = wrapOverride ?? defaultWrap;
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
            <IconButton
              size="xs"
              variant="ghost"
              icon="arrow-bend-down-left"
              active={wrapped}
              className="kapibala-code-wrap-btn"
              aria-label={wrapped ? '取消自动换行' : '自动换行'}
              aria-pressed={wrapped}
              title={wrapped ? '取消自动换行' : '自动换行'}
              onClick={() => setWrapOverride((value) => !(value ?? defaultWrap))}
            />
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
