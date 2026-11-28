import { useEffect, useState } from 'react';
import { htmlPreviewSource } from './html-preview-model.js';
import { Button } from './ui/index.js';

/**
 * 沙箱内嵌 HTML 预览。
 *
 * 文档先交给主进程登记，再由预览协议以独立来源载入：blob:/srcdoc 会继承主页面的
 * CSP，模型输出里的内联脚本会被应用的 script-src 一并封掉，只有独立来源才能既
 * 保留沙箱（`allow-scripts`、无 `allow-same-origin`）又允许预览自身运行。
 * 网络与外链限制由预览协议的响应头 CSP 负责。只在用户显式点击后挂载，
 * 避免历史回看时批量创建 iframe。
 */
export function HtmlPreview({ html, label }: { html: string; label: string }) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setUrl(undefined);
    setError('');
    void window.kapibala.preview
      .url(htmlPreviewSource(html))
      .then((value) => {
        if (live) setUrl(value);
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : '预览加载失败。');
      });
    return () => {
      live = false;
    };
  }, [html]);
  if (error)
    return (
      <p role="alert" className="text-xs" style={{ color: 'var(--kpbl-status-danger)' }}>
        {error}
      </p>
    );
  if (!url)
    return (
      <p
        className="rounded-md border px-3 py-6 text-center text-xs"
        style={{
          borderColor: 'var(--kpbl-line-default)',
          color: 'var(--kpbl-ink-subtle)',
        }}
      >
        正在准备预览…
      </p>
    );
  return (
    <iframe
      className="h-96 w-full resize-y rounded-md border"
      style={{
        borderColor: 'var(--kpbl-line-default)',
        backgroundColor: 'var(--kpbl-bg-surface)',
      }}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src={url}
      title={label}
    />
  );
}

/**
 * 预览开关按钮：文案与 aria-expanded 是界面契约，代码块与工具行共用一份。
 *
 * kind 决定展开前的文案（HTML / SVG），e2e 以 `预览 HTML` 精确匹配，
 * 改动文案必须同步 packages/desktop/e2e。按钮本身不管理 iframe 是否挂载，
 * 展开状态由调用方持有——关闭时必须卸载 {@link HtmlPreview}，否则运行中的
 * 预览会一直留在内存里。
 */
export function HtmlPreviewButton({
  open,
  onClick,
  kind = 'HTML',
}: {
  open: boolean;
  onClick(): void;
  kind?: 'HTML' | 'SVG';
}) {
  return (
    <Button className="shrink-0" size="xs" variant="ghost" aria-expanded={open} onClick={onClick}>
      {open ? '收起预览' : `预览 ${kind}`}
    </Button>
  );
}
