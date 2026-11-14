import { Button } from '@cloudflare/kumo';
import { useEffect, useRef, useState } from 'react';
import { clipForDisplay } from './display-budget.js';

/**
 * 纯文本代码回退块：无法识别语言或超过展示预算的内容在这里渲染，
 * 不进入高亮管线（避免组件告警与整段 tokenize），保留复制能力。
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
        <span className="text-xs text-kumo-subtle">
          {clip.truncated ? '内容超过展示预算，已截断显示；可复制完整内容' : '文本'}
        </span>
        <Button
          className="kapibala-action"
          size="sm"
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
        <p role="alert" className="text-xs text-kumo-danger">
          复制失败，请检查剪贴板权限。
        </p>
      )}
      <pre className="overflow-x-auto rounded-md border border-kumo-fill bg-kumo-base p-2.5 text-xs">
        <code>{clip.text}</code>
      </pre>
    </div>
  );
}
