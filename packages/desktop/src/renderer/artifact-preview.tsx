import { ImageSquareIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { IMAGE_PREVIEW_LIMIT } from '../shared/preview.js';
import { artifactFileName, isArtifactTooLarge } from './artifact-model.js';

/** 面板里的字节事实做粗粒度展示；预览通道只认整字节，不在这里做换算以外的处理。 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 右侧 dock 的产物只读预览。
 *
 * 路径与大小都来自宿主投影，渲染层不自行判定信任边界；超过图片预览上限时
 * 不调用读取通道，只显示文件名与提示，避免「半张图」或必然失败的请求。
 * 读取失败（文件被移动、格式不支持）退化为可读占位，不抛出到错误边界。
 */
export function ArtifactPreview({
  path,
  ext,
  size,
}: {
  path: string;
  ext: string;
  /** 宿主观察到的字节数；缺省时跳过大小事实，不影响图片读取。 */
  size?: number;
}) {
  const name = artifactFileName(path);
  const tooLarge = isArtifactTooLarge(size);
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>();
  useEffect(() => {
    if (tooLarge) return;
    let live = true;
    setUrl(undefined);
    setFailed(false);
    setDimensions(undefined);
    void window.kapibala.preview
      .file({ path })
      .then((value) => {
        if (live) setUrl(value);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [path, tooLarge]);
  const facts = [
    dimensions ? `${dimensions.width} × ${dimensions.height}` : '尺寸未知',
    size === undefined ? '大小未知' : formatSize(size),
  ].join(' · ');
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <ImageSquareIcon size={16} className="shrink-0 text-kumo-brand" aria-hidden="true" />
        <span className="min-w-0 break-all font-medium">{name}</span>
        <span className="shrink-0 rounded-sm bg-kumo-recessed px-1.5 py-0.5 font-mono text-2xs text-kumo-subtle">
          {ext.toUpperCase()}
        </span>
      </div>
      {tooLarge ? (
        <p className="rounded-md border border-kumo-line px-3 py-2 text-xs text-kumo-subtle">
          图片超过 {formatSize(IMAGE_PREVIEW_LIMIT)}，未加载预览。可在工作目录用系统看图器打开。
        </p>
      ) : failed ? (
        <p className="rounded-md border border-kumo-line px-3 py-2 text-xs text-kumo-subtle">
          无法读取该图片：文件可能已被移动或删除，也可能超出了预览通道支持的格式。
        </p>
      ) : url ? (
        <img
          src={url}
          alt={name}
          decoding="async"
          onLoad={(event) =>
            setDimensions({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          onError={() => setFailed(true)}
          className="max-h-[60vh] w-auto max-w-full rounded-md border border-kumo-line object-contain"
        />
      ) : (
        <p className="rounded-md border border-kumo-line px-3 py-2 text-xs text-kumo-subtle">
          正在加载图片…
        </p>
      )}
      <p className="tabular-nums text-xs text-kumo-subtle">{facts}</p>
      <p className="break-all font-mono text-2xs text-kumo-faint">{path}</p>
    </section>
  );
}
