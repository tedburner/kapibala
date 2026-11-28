import { useEffect, useMemo, useRef, useState } from 'react';
import { clipForDisplay } from '../../display-budget.js';
import { useI18n } from '../../i18n.js';
import { useSettingsStore } from '../../stores/index.js';
import { Badge, Button, EmptyState, Icon, MiddleTruncate, SearchField } from '../../ui/index.js';
import { formatPreviewBytes } from './PreviewTab.js';

/** 受控工作区只读文件读取返回结构（对应 `018` §6.1 `workspace.readFile`，512 KiB 上限）。 */
export interface WorkspaceFileReadResult {
  readonly path: string;
  readonly content: string;
  readonly byteLength: number;
  readonly truncated?: boolean;
  readonly binary?: boolean;
  readonly language?: string;
}

/** `onSearchFiles` 可返回纯路径列表或附带服务端 5,000 条截断标记的结构。 */
export type WorkspaceFileSearchResult =
  | readonly string[]
  | { readonly files: readonly string[]; readonly truncated?: boolean };

/**
 * `FilesTab` 入参契约（`tab[name="文件"]`）：
 * 提供当前会话 `executionRoot`（含受管 Worktree 目录）下的模糊文件检索、带行号只读源码检视与一键 `@文件` 引用插入。
 */
export interface FilesTabProps {
  readonly files?: readonly string[];
  readonly filesTruncated?: boolean;
  readonly initialQuery?: string;
  readonly selectedPath?: string;
  readonly defaultSelectedPath?: string;
  readonly fileContent?: WorkspaceFileReadResult | null;
  readonly loadingFiles?: boolean;
  readonly loadingContent?: boolean;
  readonly error?: string;
  readonly onSearchFiles?: (
    query: string,
  ) => Promise<WorkspaceFileSearchResult | undefined> | WorkspaceFileSearchResult | undefined;
  readonly onSelectFile?: (path: string) => void;
  readonly onReadFile?: (path: string) => Promise<WorkspaceFileReadResult>;
  readonly onInsertFileReference?: (path: string, formattedMention: string) => void;
  readonly onCopyContent?: (content: string) => Promise<void> | void;
}

/**
 * 右侧工作台「文件」标签页：
 * 支持服务端模糊搜索突破 5,000 文件上限，自动识别二进制与超预算文本，提供一键插入 `@path ` 引用胶囊。
 */
export function FilesTab({
  files = [],
  filesTruncated = false,
  initialQuery = '',
  selectedPath,
  defaultSelectedPath,
  fileContent: externalFileContent,
  loadingFiles = false,
  loadingContent = false,
  error,
  onSearchFiles,
  onSelectFile,
  onReadFile,
  onInsertFileReference,
  onCopyContent,
}: FilesTabProps) {
  const { t } = useI18n();
  const codeWordWrap = useSettingsStore((s) => s.general.codeWordWrap);
  const [query, setQuery] = useState(initialQuery);
  const [remoteFiles, setRemoteFiles] = useState<readonly string[] | null>(null);
  const [remoteTruncated, setRemoteTruncated] = useState<boolean | undefined>(undefined);
  const [internalPath, setInternalPath] = useState<string | undefined>(
    () => selectedPath ?? defaultSelectedPath ?? files[0],
  );
  const [loadedFile, setLoadedFile] = useState<WorkspaceFileReadResult | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState('');
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && copyTimerRef.current !== undefined) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (selectedPath) setInternalPath(selectedPath);
  }, [selectedPath]);

  const activePath = selectedPath ?? internalPath;

  useEffect(() => {
    if (!activePath || externalFileContent !== undefined || !onReadFile) return undefined;
    let live = true;
    setReading(true);
    setReadError('');
    void onReadFile(activePath)
      .then((res) => {
        if (live) setLoadedFile(res);
      })
      .catch((err: unknown) => {
        if (live) {
          setLoadedFile(null);
          setReadError(err instanceof Error ? err.message : '读取工作区文件失败。');
        }
      })
      .finally(() => {
        if (live) setReading(false);
      });
    return () => {
      live = false;
    };
  }, [activePath, externalFileContent, onReadFile]);

  const handleQueryChange = (nextQuery: string) => {
    setQuery(nextQuery);
    if (!onSearchFiles) return;
    void Promise.resolve(onSearchFiles(nextQuery))
      .then((outcome) => {
        if (!outcome) {
          setRemoteFiles(null);
          setRemoteTruncated(undefined);
          return;
        }
        if (Array.isArray(outcome)) {
          setRemoteFiles(outcome);
          setRemoteTruncated(false);
        } else {
          const structured = outcome as {
            readonly files: readonly string[];
            readonly truncated?: boolean;
          };
          setRemoteFiles(structured.files);
          setRemoteTruncated(structured.truncated);
        }
      })
      .catch(() => {
        /* 服务端检索异常时平滑回退至本地已缓存列表过滤。 */
      });
  };

  const visibleFiles = useMemo(() => {
    if (remoteFiles !== null) return remoteFiles;
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return files;
    return files.filter((item) => item.toLowerCase().includes(trimmed));
  }, [files, query, remoteFiles]);

  const isTruncatedList = remoteTruncated ?? filesTruncated;
  const activeFile = externalFileContent !== undefined ? externalFileContent : loadedFile;
  const isBusyReading = loadingContent || reading;

  const clippedCode = useMemo(
    () =>
      activeFile && !activeFile.binary
        ? clipForDisplay(activeFile.content)
        : { text: '', truncated: false },
    [activeFile],
  );

  const codeLines = useMemo(
    () => (clippedCode.text.length > 0 ? clippedCode.text.split(/\r?\n/) : []),
    [clippedCode.text],
  );

  const handleCopy = async () => {
    if (!activeFile || activeFile.binary) return;
    try {
      if (onCopyContent) {
        await onCopyContent(activeFile.content);
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(activeFile.content);
      }
      setCopied(true);
      if (typeof window !== 'undefined') {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = window.setTimeout(() => setCopied(false), 1_500);
      }
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="kpbl-workbench-panel">
      <div className="kpbl-files-searchbar">
        <SearchField
          aria-label={t('files.searchAria')}
          placeholder={t('files.searchPlaceholder')}
          value={query}
          onValueChange={handleQueryChange}
        />
      </div>

      {isTruncatedList ? (
        <div className="kpbl-wb-banner">
          <span>{t('files.truncatedBanner')}</span>
        </div>
      ) : null}

      {error ? (
        <div role="alert" data-tone="danger" className="kpbl-wb-banner">
          <span>{error}</span>
        </div>
      ) : null}

      {loadingFiles ? (
        <div className="p-4">
          <EmptyState icon="spinner" title={t('files.loadingIndex')} />
        </div>
      ) : visibleFiles.length === 0 ? (
        <div className="p-4">
          <EmptyState
            icon="folder-open"
            title={query.trim() ? t('files.noMatchTitle') : t('files.emptyTitle')}
            description={t('files.emptyDesc')}
          />
        </div>
      ) : (
        <section aria-label={t('files.listAria')} className="kpbl-files-list">
          {visibleFiles.map((filePath) => {
            const selected = filePath === activePath;
            return (
              <button
                key={filePath}
                type="button"
                data-active={selected ? 'true' : undefined}
                aria-pressed={selected}
                className="kpbl-files-item"
                onClick={() => {
                  setInternalPath(filePath);
                  onSelectFile?.(filePath);
                }}
              >
                <Icon name="file-code" size={14} />
                <MiddleTruncate text={filePath} mono maxChars={52} />
              </button>
            );
          })}
        </section>
      )}

      {activePath ? (
        <div className="kpbl-wb-toolbar">
          <div className="kpbl-wb-toolbar-group">
            <MiddleTruncate text={activeFile?.path ?? activePath} mono maxChars={42} />
            {activeFile ? <Badge>{formatPreviewBytes(activeFile.byteLength)}</Badge> : null}
          </div>
          <div className="kpbl-wb-toolbar-group">
            <Button
              variant="outline"
              size="xs"
              leadingIcon="note-pencil"
              onClick={() => {
                const target = activeFile?.path ?? activePath;
                onInsertFileReference?.(target, `@${target} `);
              }}
            >
              {t('files.insertRefBtn')}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              leadingIcon={copied ? 'check' : 'copy'}
              disabled={!activeFile || Boolean(activeFile.binary)}
              onClick={() => void handleCopy()}
            >
              {copied ? t('thread.copied') : t('files.copyBtn')}
            </Button>
          </div>
        </div>
      ) : null}

      {readError ? (
        <div role="alert" data-tone="danger" className="kpbl-wb-banner">
          <span>{readError}</span>
        </div>
      ) : isBusyReading ? (
        <div className="p-4">
          <EmptyState icon="spinner" title={t('files.readingContent')} />
        </div>
      ) : !activeFile ? (
        <div className="p-4">
          <EmptyState
            icon="file-text"
            title={t('files.selectPromptTitle')}
            description={t('files.selectPromptDesc')}
          />
        </div>
      ) : activeFile.binary ? (
        <div className="p-4">
          <EmptyState
            icon="file"
            title={t('files.binaryTitle')}
            description={t('files.binaryDesc', { size: formatPreviewBytes(activeFile.byteLength) })}
          />
        </div>
      ) : (
        <>
          {activeFile.truncated || clippedCode.truncated ? (
            <div data-tone="warning" className="kpbl-wb-banner">
              <span>{t('files.contentTruncated')}</span>
            </div>
          ) : null}
          <div data-code-wrap={codeWordWrap ? 'true' : undefined} className="kpbl-code-viewer">
            {codeLines.length === 0 ? (
              <div className="p-3 kpbl-wb-meta">{t('files.emptyFile')}</div>
            ) : (
              codeLines.map((line, index) => (
                <div key={`${activeFile.path}:L${index + 1}`} className="kpbl-code-line">
                  <span className="kpbl-code-lineno">{index + 1}</span>
                  <code className="kpbl-code-content">{line}</code>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
