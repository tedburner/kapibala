import type { ViewArtifact } from '@kiturone/kapibala-host/view-model';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { classifyPreviewUrl } from '../../../shared/preview-url.js';
import { HTML_PREVIEW_LIMIT, IMAGE_PREVIEW_LIMIT } from '../../../shared/preview.js';
import { artifactFileName, isArtifactTooLarge } from '../../artifact-model.js';
import { clipForDisplay } from '../../display-budget.js';
import { htmlPreviewSource } from '../../html-preview-model.js';
import { useI18n } from '../../i18n.js';
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  MiddleTruncate,
  Segmented,
  type SegmentedOption,
  TextField,
} from '../../ui/index.js';

/** `PreviewTab` 三种统一预览源模式（018 §6.1）。 */
export type PreviewSurfaceMode = 'sandbox' | 'image' | 'url';

/** 格式化文件字节体积为紧凑可读标签。 */
export function formatPreviewBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * `PreviewTab` 入参契约（`tab[name="预览"]`）：
 * 统一承载三类受控预览面：
 * 1. `kpbl-preview://` 断网独立源 HTML/SVG 沙箱（`sandbox="allow-scripts"`，无 `allow-same-origin`）；
 * 2. `window.kapibala.preview.file` 受控图片/SVG data URL 预览（含缩放与尺寸元数据）；
 * 3. `classifyPreviewUrl` 严格白名单裁决的本机回环开发服务预览（`embed_loopback` / `open_external` / `blocked`）。
 */
export interface PreviewTabProps {
  readonly defaultMode?: PreviewSurfaceMode;
  readonly html?: string;
  readonly htmlLabel?: string;
  readonly initialSandboxUrl?: string;
  readonly artifact?: ViewArtifact;
  readonly workspaceRoot?: string;
  readonly initialImageDataUrl?: string;
  readonly initialUrl?: string;
  readonly onCreatePreviewUrl?: (sandboxDocument: string) => Promise<string>;
  readonly onLoadPreviewFile?: (params: {
    readonly path: string;
    readonly root?: string;
  }) => Promise<string>;
  readonly onOpenExternal?: (url: string) => Promise<void> | void;
}

const ZOOM_STEPS = [50, 75, 100, 125, 150, 200] as const;

function resolveInitialMode(props: PreviewTabProps): PreviewSurfaceMode {
  if (props.defaultMode) return props.defaultMode;
  if (props.initialUrl) return 'url';
  if (props.artifact) return 'image';
  return 'sandbox';
}

/**
 * 右侧工作台「预览」标签页：严格隔离模型不可信文档与本机开发端口，拦截私网段与危险协议。
 */
export function PreviewTab(props: PreviewTabProps) {
  const {
    html,
    htmlLabel = 'HTML 文件预览',
    initialSandboxUrl,
    artifact,
    workspaceRoot,
    initialImageDataUrl,
    initialUrl = '',
    onCreatePreviewUrl,
    onLoadPreviewFile,
    onOpenExternal,
  } = props;
  const { t } = useI18n();
  const modeOptions = useMemo<readonly SegmentedOption<PreviewSurfaceMode>[]>(
    () => [
      { value: 'sandbox', label: t('preview.modeSandbox'), icon: 'code' },
      { value: 'image', label: t('preview.modeImage'), icon: 'image' },
      { value: 'url', label: t('preview.modeUrl'), icon: 'globe' },
    ],
    [t],
  );
  const [mode, setMode] = useState<PreviewSurfaceMode>(() => resolveInitialMode(props));
  const [showSource, setShowSource] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [sandboxUrl, setSandboxUrl] = useState<string | undefined>(initialSandboxUrl);
  const [sandboxError, setSandboxError] = useState('');
  const [imageUrl, setImageUrl] = useState<string | undefined>(initialImageDataUrl);
  const [imageError, setImageError] = useState('');
  const [dimensions, setDimensions] = useState<{
    readonly width: number;
    readonly height: number;
  } | null>(null);
  const [zoomPercent, setZoomPercent] = useState<number>(100);
  const [fitContainer, setFitContainer] = useState(true);
  const [urlInput, setUrlInput] = useState(initialUrl);
  const [committedUrl, setCommittedUrl] = useState(initialUrl);

  useEffect(() => {
    if (initialUrl) {
      setUrlInput(initialUrl);
      setCommittedUrl(initialUrl);
      setMode('url');
    }
  }, [initialUrl]);
  useEffect(() => {
    if (artifact && !initialUrl) setMode('image');
  }, [artifact, initialUrl]);
  useEffect(() => {
    if (html && !artifact && !initialUrl) setMode('sandbox');
  }, [artifact, html, initialUrl]);

  useEffect(() => {
    if (mode !== 'sandbox' || !html) return undefined;
    if (html.length > HTML_PREVIEW_LIMIT) {
      setSandboxUrl(undefined);
      setSandboxError(
        `文档超过预览上限（${formatPreviewBytes(HTML_PREVIEW_LIMIT)}），已拒绝加载。`,
      );
      return undefined;
    }
    const createFn =
      onCreatePreviewUrl ??
      (typeof window !== 'undefined' && window.kapibala?.preview?.url
        ? (doc: string) => window.kapibala.preview.url(doc)
        : undefined);
    if (!createFn) return undefined;

    let live = true;
    setSandboxError('');
    if (reloadNonce > 0 || !initialSandboxUrl) {
      setSandboxUrl(undefined);
    }
    void createFn(htmlPreviewSource(html))
      .then((nextUrl) => {
        if (live) setSandboxUrl(nextUrl);
      })
      .catch((reason: unknown) => {
        if (live) {
          setSandboxError(reason instanceof Error ? reason.message : '预览沙箱初始化失败。');
        }
      });
    return () => {
      live = false;
    };
  }, [html, initialSandboxUrl, mode, onCreatePreviewUrl, reloadNonce]);

  const artifactTooLarge = isArtifactTooLarge(artifact?.size);
  useEffect(() => {
    if (mode !== 'image' || !artifact || artifactTooLarge) return undefined;
    const loadFileFn =
      onLoadPreviewFile ??
      (typeof window !== 'undefined' && window.kapibala?.preview?.file
        ? (params: { readonly path: string; readonly root?: string }) =>
            window.kapibala.preview.file({ path: params.path, root: params.root })
        : undefined);
    if (!loadFileFn) return undefined;

    let live = true;
    setImageError('');
    setDimensions(null);
    if (!initialImageDataUrl) setImageUrl(undefined);
    void loadFileFn({ path: artifact.path, root: workspaceRoot })
      .then((dataUrl) => {
        if (live) setImageUrl(dataUrl);
      })
      .catch(() => {
        if (live) {
          setImageError('无法读取该图片产物：文件可能已移动或超出受控预览格式范围。');
        }
      });
    return () => {
      live = false;
    };
  }, [artifact, artifactTooLarge, initialImageDataUrl, mode, onLoadPreviewFile, workspaceRoot]);

  const urlDecision = useMemo(
    () =>
      committedUrl.trim()
        ? classifyPreviewUrl(committedUrl, {
            hostOrigin: typeof window !== 'undefined' ? window.location?.origin : undefined,
          })
        : null,
    [committedUrl],
  );

  const handleOpenExternal = (targetUrl: string) => {
    if (onOpenExternal) {
      void onOpenExternal(targetUrl);
      return;
    }
    if (typeof window !== 'undefined' && window.kapibala?.app?.openExternal) {
      void window.kapibala.app.openExternal(targetUrl);
    }
  };

  const handleUrlSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMode('url');
    setCommittedUrl(urlInput);
  };

  const clippedHtmlSource = useMemo(() => clipForDisplay(html ?? ''), [html]);

  return (
    <div className="kpbl-workbench-panel">
      <div className="kpbl-wb-toolbar">
        <Segmented
          aria-label={t('preview.modeAria')}
          value={mode}
          options={modeOptions}
          onValueChange={setMode}
        />

        {mode === 'sandbox' && html ? (
          <div className="kpbl-wb-toolbar-group">
            <Button
              variant="ghost"
              size="xs"
              leadingIcon="code"
              aria-pressed={showSource}
              onClick={() => setShowSource((prev) => !prev)}
            >
              {showSource ? t('preview.viewPreview') : t('preview.viewSource')}
            </Button>
            <IconButton
              size="xs"
              icon="arrow-clockwise"
              aria-label={t('preview.reloadSandboxAria')}
              onClick={() => setReloadNonce((n) => n + 1)}
            />
          </div>
        ) : null}

        {mode === 'image' && artifact ? (
          <div className="kpbl-wb-toolbar-group">
            <Button
              variant="ghost"
              size="xs"
              aria-pressed={fitContainer}
              onClick={() => {
                setFitContainer((prev) => !prev);
                setZoomPercent(100);
              }}
            >
              {fitContainer ? t('preview.actualSize') : t('preview.fitWindow')}
            </Button>
            <IconButton
              size="xs"
              icon="minus-circle"
              aria-label={t('preview.zoomOutAria')}
              disabled={zoomPercent <= ZOOM_STEPS[0]}
              onClick={() => {
                setFitContainer(false);
                setZoomPercent((z) => Math.max(50, z - 25));
              }}
            />
            <span className="kpbl-wb-meta">
              {fitContainer ? t('preview.fitBadge') : `${zoomPercent}%`}
            </span>
            <IconButton
              size="xs"
              icon="plus"
              aria-label={t('preview.zoomInAria')}
              disabled={zoomPercent >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
              onClick={() => {
                setFitContainer(false);
                setZoomPercent((z) => Math.min(200, z + 25));
              }}
            />
          </div>
        ) : null}
      </div>

      <form className="kpbl-preview-urlbar" onSubmit={handleUrlSubmit}>
        <TextField
          mono
          containerClassName="flex-1"
          aria-label={t('preview.urlAria')}
          placeholder={t('preview.urlPlaceholder')}
          value={urlInput}
          onValueChange={setUrlInput}
        />
        <Button type="submit" variant="outline" size="sm" leadingIcon="arrow-right">
          {t('preview.goBtn')}
        </Button>
        {mode === 'url' && urlDecision?.kind === 'embed_loopback' ? (
          <>
            <IconButton
              size="sm"
              icon="arrow-clockwise"
              aria-label={t('preview.reloadUrlAria')}
              onClick={() => setReloadNonce((n) => n + 1)}
            />
            <Button
              variant="ghost"
              size="sm"
              leadingIcon="arrow-square-out"
              onClick={() => handleOpenExternal(urlDecision.normalizedUrl)}
            >
              {t('preview.openExternalBtn')}
            </Button>
          </>
        ) : null}
      </form>

      <div className="kpbl-preview-stage">
        {mode === 'sandbox' ? (
          !html ? (
            <EmptyState
              icon="code"
              title={t('preview.emptySandboxTitle')}
              description={t('preview.emptySandboxDesc')}
            />
          ) : sandboxError ? (
            <div role="alert" data-tone="danger" className="kpbl-wb-banner">
              <span>{sandboxError}</span>
            </div>
          ) : showSource ? (
            <pre className="kpbl-inspector-pre">{clippedHtmlSource.text}</pre>
          ) : sandboxUrl ? (
            <iframe
              key={`${sandboxUrl}:${reloadNonce}`}
              className="kpbl-preview-iframe"
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              src={sandboxUrl}
              title={htmlLabel}
            />
          ) : (
            <EmptyState icon="spinner" title={t('preview.preparingSandbox')} />
          )
        ) : mode === 'image' ? (
          !artifact ? (
            <EmptyState
              icon="image"
              title={t('preview.emptyImageTitle')}
              description={t('preview.emptyImageDesc')}
            />
          ) : (
            <>
              <div className="kpbl-wb-toolbar-group justify-between">
                <div className="kpbl-wb-toolbar-group">
                  <MiddleTruncate text={artifactFileName(artifact.path)} mono maxChars={40} />
                  <Badge>{artifact.ext.toUpperCase()}</Badge>
                </div>
                <span className="kpbl-wb-meta">
                  {dimensions ? `${dimensions.width} × ${dimensions.height} · ` : ''}
                  {artifact.size !== undefined ? formatPreviewBytes(artifact.size) : ''}
                </span>
              </div>
              {artifactTooLarge ? (
                <div role="alert" data-tone="warning" className="kpbl-wb-banner">
                  <span>
                    图片超过 {formatPreviewBytes(IMAGE_PREVIEW_LIMIT)} 上限，请使用系统看图器打开。
                  </span>
                </div>
              ) : imageError ? (
                <div role="alert" data-tone="danger" className="kpbl-wb-banner">
                  <span>{imageError}</span>
                </div>
              ) : imageUrl ? (
                <div className="kpbl-preview-image-stage">
                  <img
                    src={imageUrl}
                    alt={artifactFileName(artifact.path)}
                    decoding="async"
                    style={
                      fitContainer ? undefined : { width: `${zoomPercent}%`, maxWidth: 'none' }
                    }
                    className="kpbl-preview-img"
                    onLoad={(event) =>
                      setDimensions({
                        width: event.currentTarget.naturalWidth,
                        height: event.currentTarget.naturalHeight,
                      })
                    }
                    onError={() => setImageError('图片解码失败，文件可能已损坏或格式不受支持。')}
                  />
                </div>
              ) : (
                <EmptyState icon="spinner" title={t('preview.loadingImage')} />
              )}
            </>
          )
        ) : !urlDecision ? (
          <EmptyState
            icon="globe"
            title={t('preview.emptyUrlTitle')}
            description={t('preview.emptyUrlDesc')}
          />
        ) : urlDecision.kind === 'embed_loopback' ? (
          <iframe
            key={`${urlDecision.normalizedUrl}:${reloadNonce}`}
            title={t('preview.loopbackIframeTitle')}
            src={urlDecision.normalizedUrl}
            sandbox="allow-scripts allow-forms allow-same-origin"
            referrerPolicy="no-referrer"
            className="kpbl-preview-iframe"
          />
        ) : urlDecision.kind === 'open_external' ? (
          <div className="kpbl-preview-card">
            <Badge tone="info" icon="globe">
              {t('preview.externalIsolationBadge')}
            </Badge>
            <div className="kpbl-setting-row-title">{t('preview.externalCardTitle')}</div>
            <p className="kpbl-field-hint">{urlDecision.reason}</p>
            <MiddleTruncate text={urlDecision.normalizedUrl} mono maxChars={52} />
            <Button
              variant="solid"
              size="sm"
              leadingIcon="arrow-square-out"
              onClick={() => handleOpenExternal(urlDecision.normalizedUrl)}
            >
              {t('preview.openExternalBtn')}
            </Button>
          </div>
        ) : (
          <div role="alert" data-tone="danger" className="kpbl-wb-banner">
            <span>{urlDecision.reason}</span>
          </div>
        )}
      </div>
    </div>
  );
}
