import { useEffect, useState } from 'react';
import { classifyImageSource } from './markdown-image-model.js';

/**
 * 正文内图片：远程 http(s) 与 data:image 直接渲染；本地图片经主进程读取通道
 * 回 data URL 后渲染；其余地址退化为文字占位。
 *
 * 限制高度与宽度避免撑破气泡，`loading="lazy"` 让历史里的图片按需加载；
 * 加载失败降级为 alt 文案，不显示破图。远程图片点击经 Main 在系统浏览器打开
 * （data: 图片没有可打开的地址，不提供链接）。
 */
export function MarkdownImage({
  src,
  alt,
  root,
  report,
}: {
  src: string | undefined;
  alt: string | undefined;
  /** 当前工作区根路径；相对路径图片以它为基准解析，缺省时相对路径图片退化为占位。 */
  root?: string;
  report(message: string): void;
}) {
  const [failed, setFailed] = useState(false);
  const source = classifyImageSource(src);
  if (source.kind === 'local') return <LocalImage path={source.path} root={root} alt={alt} />;
  if (source.kind === 'placeholder')
    return (
      <span className="text-kumo-subtle">
        {source.reason === 'local'
          ? `[本地图片：${alt?.trim() || src || '未命名'}]`
          : alt?.trim()
            ? `[图片：${alt.trim()}]`
            : '[图片]'}
      </span>
    );
  const image = (
    <img
      src={source.url}
      alt={alt ?? ''}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="max-h-80 w-auto max-w-full rounded-md border border-kumo-line object-contain"
    />
  );
  if (failed)
    return <span className="text-kumo-subtle">[图片加载失败：{alt?.trim() || source.url}]</span>;
  if (!source.url.startsWith('http')) return image;
  return (
    <a
      href={source.url}
      title="在浏览器打开图片"
      onClick={(event) => {
        event.preventDefault();
        void window.kapibala.app
          .openExternal(source.url)
          .catch((error: unknown) =>
            report(error instanceof Error ? error.message : '打开图片失败。'),
          );
      }}
    >
      {image}
    </a>
  );
}

/**
 * 本地图片：路径交给主进程按扩展名白名单整读并回 data URL。
 *
 * 只在地址或工作区根变化时读取一次；主进程拒绝（不存在、超限、非图片扩展）
 * 时降级为占位文案，与历史里其它不可渲染地址的观感一致。
 */
function LocalImage({
  path,
  root,
  alt,
}: {
  path: string;
  root?: string;
  alt: string | undefined;
}) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setUrl(undefined);
    setError('');
    void window.kapibala.preview
      .file({ path, root: root || undefined })
      .then((value) => {
        if (live) setUrl(value);
      })
      .catch(() => {
        if (live) setError('read');
      });
    return () => {
      live = false;
    };
  }, [path, root]);
  if (error)
    return <span className="text-kumo-subtle">[本地图片：{alt?.trim() || path}（无法读取）]</span>;
  if (!url)
    return (
      <span className="rounded-md border border-kumo-line px-3 py-2 text-xs text-kumo-subtle">
        正在加载图片…
      </span>
    );
  return (
    <img
      src={url}
      alt={alt ?? ''}
      loading="lazy"
      decoding="async"
      className="max-h-80 w-auto max-w-full rounded-md border border-kumo-line object-contain"
    />
  );
}
