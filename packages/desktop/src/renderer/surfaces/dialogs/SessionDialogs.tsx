import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n.js';
import { Button, ModalDialog, TextField } from '../../ui/index.js';

/** 待重命名或物理删除的本地会话最小定位身份；标题仅用于确认回显，不参与宿主路由。 */
export interface SessionTarget {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly title: string;
}

/** 待移除的外部代理历史会话记录身份。 */
export interface ExternalSessionDeleteTarget {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly harnessName: string;
  readonly title: string;
}

/**
 * `SessionRenameDialog` 入参契约：
 * - 每次切换 `target` 时重置草稿初值，杜绝组件常驻复用导致上一条会话草稿残留；
 * - 空白标题在前端直接拦截提示，保存动作交由调用方统一执行与上报错误。
 */
export interface SessionRenameDialogProps {
  readonly target?: SessionTarget;
  readonly busy?: boolean;
  readonly title?: string;
  readonly onCancel: () => void;
  readonly onConfirm: (title: string) => void;
}

/**
 * 会话重命名原生 `<dialog>` 模态框：仅追加标题控制记录，不中断正在运行的会话流。
 */
export function SessionRenameDialog({
  target,
  busy = false,
  title = '重命名会话',
  onCancel,
  onConfirm,
}: SessionRenameDialogProps) {
  const [draft, setDraft] = useState(() => target?.title ?? '');
  const [invalid, setInvalid] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDraft(target?.title ?? '');
    setInvalid('');
  }, [target]);

  function submit(): void {
    const trimmed = draft.trim();
    if (!trimmed) {
      setInvalid('标题不能为空。');
      return;
    }
    onConfirm(trimmed);
  }

  return (
    <ModalDialog
      open={Boolean(target)}
      onOpenChange={(nextOpen) => {
        if (!busy && !nextOpen) onCancel();
      }}
      title={title}
      description="只改动会话标题，历史正文与运行状态保持不变；运行中的会话也可以改名。"
      closedBy={busy ? 'none' : 'closerequest'}
      closeLabel="取消重命名"
      initialFocusRef={inputRef}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button variant="solid" disabled={busy} onClick={submit}>
            保存
          </Button>
        </>
      }
    >
      <TextField
        ref={inputRef}
        label="标题"
        value={draft}
        error={invalid || undefined}
        maxLength={200}
        disabled={busy}
        onValueChange={(value) => {
          setDraft(value);
          setInvalid('');
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
        }}
      />
    </ModalDialog>
  );
}

/**
 * `SessionDeleteDialog` 入参契约（017 §4 破坏性确认安全焦点规范）：
 * - 初始焦点通过 `initialFocusRef` 严格锁定在「取消」安全按钮，防误按 Enter 造成不可逆删除；
 * - 明确区分物理删除与可恢复归档，关闭（含 `Esc` 或遮罩）一律走 `onCancel`。
 */
export interface SessionDeleteDialogProps {
  readonly target?: SessionTarget;
  readonly busy?: boolean;
  readonly title?: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

/**
 * 本地会话永久物理删除确认模态框：删除历史正文与索引缓存，不可恢复。
 */
export function SessionDeleteDialog({
  target,
  busy = false,
  title = '删除会话？',
  onCancel,
  onConfirm,
}: SessionDeleteDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  return (
    <ModalDialog
      open={Boolean(target)}
      onOpenChange={(nextOpen) => {
        if (!busy && !nextOpen) onCancel();
      }}
      title={title}
      description={`「${target?.title || '未命名对话'}」的历史正文与索引缓存会被一并删除，无法恢复。仍在运行或清理的对话需要先停止任务。`}
      closedBy={busy ? 'none' : 'closerequest'}
      closeLabel="取消删除"
      initialFocusRef={cancelRef}
      footer={
        <>
          <Button ref={cancelRef} variant="outline" disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button variant="danger" disabled={busy} onClick={onConfirm}>
            永久删除
          </Button>
        </>
      }
    />
  );
}

/**
 * `ExternalSessionDeleteDialog` 入参契约：
 * 移除外部代理本地只读快照记录的二次确认框，默认焦点同样锁定在「取消」按钮。
 */
export interface ExternalSessionDeleteDialogProps {
  readonly target?: ExternalSessionDeleteTarget;
  readonly busy?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

/**
 * 外部代理会话记录删除确认模态框。
 */
export function ExternalSessionDeleteDialog({
  target,
  busy = false,
  onCancel,
  onConfirm,
}: ExternalSessionDeleteDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  return (
    <ModalDialog
      open={Boolean(target)}
      onOpenChange={(nextOpen) => {
        if (!busy && !nextOpen) onCancel();
      }}
      title="删除外部会话记录？"
      description={`将从本地列表中移除「${target?.harnessName ?? '外部代理'} · ${target?.title || '外部任务'}」及其只读展示快照，此操作不可恢复。`}
      closedBy={busy ? 'none' : 'closerequest'}
      closeLabel="取消删除外部会话"
      initialFocusRef={cancelRef}
      footer={
        <>
          <Button ref={cancelRef} variant="outline" disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button variant="danger" disabled={busy} onClick={onConfirm}>
            确认删除
          </Button>
        </>
      }
    />
  );
}

/**
 * `SessionArchiveDialog` 入参契约：
 * 当用户在「常规 → 确认操作」开启「归档确认」时弹出，默认焦点落在安全取消钮。
 */
export interface SessionArchiveDialogProps {
  readonly target?: SessionTarget;
  readonly busy?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

/**
 * 会话逻辑归档二次确认模态框。
 */
export function SessionArchiveDialog({
  target,
  busy = false,
  onCancel,
  onConfirm,
}: SessionArchiveDialogProps) {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  return (
    <ModalDialog
      open={Boolean(target)}
      onOpenChange={(nextOpen) => {
        if (!busy && !nextOpen) onCancel();
      }}
      title={t('archives.archiveConfirmTitle')}
      description={t('archives.archiveConfirmDesc', { title: target?.title || '未命名对话' })}
      closedBy={busy ? 'none' : 'closerequest'}
      closeLabel={t('general.cancel')}
      initialFocusRef={cancelRef}
      footer={
        <>
          <Button ref={cancelRef} variant="outline" disabled={busy} onClick={onCancel}>
            {t('general.cancel')}
          </Button>
          <Button variant="solid" disabled={busy} onClick={onConfirm}>
            {t('archives.archiveConfirmAction')}
          </Button>
        </>
      }
    />
  );
}
