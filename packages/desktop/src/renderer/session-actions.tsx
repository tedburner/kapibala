import { Button, Input, LayerDialog } from '@cloudflare/kumo';
import { useEffect, useState } from 'react';

/** 待处理会话的最小身份；标题只用于确认文案，不参与 Host 侧定位。 */
export interface SessionTarget {
  workspaceId: string;
  conversationId: string;
  title: string;
}

/**
 * 重命名的输入弹窗。
 *
 * 约束与边界：
 * - 只改标题记录，不动历史正文，因此运行中的对话也能改名；
 * - 每次打开都以当前标题为初值：组件实例会复用，不能沿用上一次的草稿；
 * - 空标题不发请求，错在本地说清；确认与取消都走调用方，保存失败由外层统一呈现。
 */
export function SessionRenameDialog({
  target,
  busy,
  onCancel,
  onConfirm,
}: {
  target?: SessionTarget;
  busy: boolean;
  onCancel(): void;
  onConfirm(title: string): void;
}) {
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState('');
  useEffect(() => {
    setDraft(target?.title ?? '');
    setInvalid('');
  }, [target]);
  function submit() {
    const title = draft.trim();
    if (!title) {
      setInvalid('标题不能为空。');
      return;
    }
    onConfirm(title);
  }
  return (
    <LayerDialog
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <LayerDialog.Content size="sm" closeLabel="取消重命名">
        <LayerDialog.Title>
          <span data-kapibala-modal="true">重命名对话</span>
        </LayerDialog.Title>
        <LayerDialog.Description>
          只改动对话标题，历史与运行状态都保持不变；运行中的对话也可以改名。
        </LayerDialog.Description>
        <LayerDialog.Body>
          <div className="space-y-3">
            <Input
              label="标题"
              value={draft}
              error={invalid || undefined}
              maxLength={200}
              autoFocus
              disabled={busy}
              onChange={(event) => {
                setDraft(event.target.value);
                setInvalid('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit();
              }}
            />
            <div className="flex justify-end gap-3">
              <Button className="kapibala-action" variant="secondary" onClick={onCancel}>
                取消
              </Button>
              <Button
                className="kapibala-action"
                variant="primary"
                disabled={busy}
                onClick={submit}
              >
                保存
              </Button>
            </div>
          </div>
        </LayerDialog.Body>
      </LayerDialog.Content>
    </LayerDialog>
  );
}

/**
 * 物理删除的二次确认。
 *
 * 约束与边界：
 * - 文案必须说明「不可恢复」与「运行中需先停止」，否则用户会把它当成归档的另一种写法；
 * - 本组件不发请求，删除由调用方执行：错误呈现、列表刷新与视图收敛都留在同一处，避免两套语义；
 * - 目标为空即关闭；关闭（含按 Esc、点遮罩）一律走 onCancel，不做隐式确认。
 */
export function SessionDeleteDialog({
  target,
  onCancel,
  onConfirm,
}: {
  target?: SessionTarget;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <LayerDialog
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <LayerDialog.Content size="sm" closeLabel="取消删除">
        <LayerDialog.Title>
          <span data-kapibala-modal="true">永久删除这个对话？</span>
        </LayerDialog.Title>
        <LayerDialog.Description>
          「{target?.title || '未命名对话'}」的历史正文与索引缓存会被一并删除，无法恢复。
          仍在运行或清理的对话需要先停止任务。
        </LayerDialog.Description>
        <LayerDialog.Body>
          <div className="flex justify-end gap-3">
            <Button className="kapibala-action" variant="secondary" onClick={onCancel}>
              取消
            </Button>
            <Button className="kapibala-action" variant="secondary-destructive" onClick={onConfirm}>
              永久删除
            </Button>
          </div>
        </LayerDialog.Body>
      </LayerDialog.Content>
    </LayerDialog>
  );
}
