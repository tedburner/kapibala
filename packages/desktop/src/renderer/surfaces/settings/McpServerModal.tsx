import { useState } from 'react';
import { Button, ModalDialog, Select, TextField } from '../../ui/index.js';

/** MCP 服务器新增/编辑草稿形态；`keepTransport` 在原目标含内嵌凭证未暴露回填面时锁定传输配置。 */
export interface McpFormDraft {
  readonly editName?: string;
  readonly scope: 'global' | 'project';
  readonly name: string;
  readonly type: 'stdio' | 'http';
  readonly command: string;
  readonly args: string;
  readonly url: string;
  readonly keepTransport?: boolean;
}

/**
 * `McpServerModal` 入参契约：
 * 以单层原生 `<ModalDialog>` 承载 MCP 服务器新增与编辑（严禁卡片套卡片），
 * 保留 `resource-panel.spec.ts` 全部精确标签（`名称`、`写入位置`、`传输类型`、`启动命令`、`端点 URL`、`保存`）。
 */
export interface McpServerModalProps {
  readonly draft?: McpFormDraft;
  readonly projectTrusted: boolean;
  readonly busy: boolean;
  readonly error?: string;
  readonly onChangeDraft: (draft: McpFormDraft | undefined) => void;
  readonly onClearError: () => void;
  readonly onSubmit: (draft: McpFormDraft) => void;
}

/**
 * MCP 服务器配置单层新建/编辑模态框。
 */
export function McpServerModal({
  draft,
  projectTrusted,
  busy,
  error,
  onChangeDraft,
  onClearError,
  onSubmit,
}: McpServerModalProps) {
  const draftIdentity = draft ? `${draft.scope}:${draft.editName ?? '__new__'}` : '__closed__';
  const [trackedIdentity, setTrackedIdentity] = useState(draftIdentity);
  const [localError, setLocalError] = useState('');

  if (trackedIdentity !== draftIdentity) {
    setTrackedIdentity(draftIdentity);
    setLocalError('');
  }

  const activeError = error || localError;

  function handleSave(): void {
    if (!draft) return;
    if (!draft.keepTransport) {
      if (draft.type === 'http' && !draft.url.trim()) {
        setLocalError('HTTP 服务器必须提供端点 URL');
        return;
      }
      if (draft.type === 'stdio' && !draft.command.trim()) {
        setLocalError('stdio 服务器必须提供启动命令');
        return;
      }
    }
    setLocalError('');
    onClearError();
    onSubmit(draft);
  }

  return (
    <ModalDialog
      open={Boolean(draft)}
      onOpenChange={(nextOpen) => {
        if (!busy && !nextOpen) {
          setLocalError('');
          onClearError();
          onChangeDraft(undefined);
        }
      }}
      title={draft?.editName ? `编辑 MCP 服务器 · ${draft.editName}` : '新增 MCP 服务器'}
      description="启停与修改对之后新建的会话生效，运行中的会话不受影响。"
      closedBy={busy ? 'none' : 'closerequest'}
      closeLabel="关闭 MCP 表单"
      footer={
        <>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setLocalError('');
              onClearError();
              onChangeDraft(undefined);
            }}
          >
            取消
          </Button>
          <Button
            variant="solid"
            loading={busy}
            disabled={!draft?.name.trim()}
            onClick={handleSave}
          >
            保存
          </Button>
        </>
      }
    >
      {draft ? (
        <div className="kpbl-dialog-stack">
          <TextField
            label="名称"
            placeholder="例如 filesystem"
            value={draft.name}
            disabled={busy}
            onValueChange={(value) => {
              setLocalError('');
              onChangeDraft({ ...draft, name: value });
            }}
          />
          <div className="kpbl-form-grid-2">
            <div className="kpbl-field">
              <span className="kpbl-field-label">写入位置</span>
              <Select
                aria-label="写入位置"
                value={draft.scope}
                disabled={busy || Boolean(draft.editName)}
                options={
                  projectTrusted
                    ? [
                        { value: 'global', label: '全局（~/.kapibala/mcp.json）' },
                        { value: 'project', label: '项目（需已信任）' },
                      ]
                    : [{ value: 'global', label: '全局（~/.kapibala/mcp.json）' }]
                }
                onValueChange={(value) => onChangeDraft({ ...draft, scope: value })}
              />
            </div>
            <div className="kpbl-field">
              <span className="kpbl-field-label">传输类型</span>
              <Select
                aria-label="传输类型"
                value={draft.type}
                disabled={busy || Boolean(draft.keepTransport)}
                options={[
                  { value: 'stdio', label: 'stdio（本地命令）' },
                  { value: 'http', label: 'HTTP（远程端点）' },
                ]}
                onValueChange={(value) => {
                  setLocalError('');
                  onChangeDraft({ ...draft, type: value });
                }}
              />
            </div>
          </div>

          {draft.type === 'stdio' ? (
            <>
              <TextField
                mono
                label="启动命令"
                placeholder="npx 或 node server.js"
                value={draft.command}
                disabled={busy || Boolean(draft.keepTransport)}
                onValueChange={(value) => {
                  setLocalError('');
                  onChangeDraft({ ...draft, command: value });
                }}
              />
              <TextField
                mono
                label="命令行参数（空白分隔，可选）"
                placeholder="-y @modelcontextprotocol/server-filesystem ."
                value={draft.args}
                disabled={busy || Boolean(draft.keepTransport)}
                onValueChange={(value) => onChangeDraft({ ...draft, args: value })}
              />
            </>
          ) : (
            <TextField
              mono
              label="端点 URL"
              placeholder="https://mcp.example.com/sse"
              value={draft.url}
              disabled={busy || Boolean(draft.keepTransport)}
              onValueChange={(value) => {
                setLocalError('');
                onChangeDraft({ ...draft, url: value });
              }}
            />
          )}

          <p className="kpbl-field-hint">
            {draft.keepTransport
              ? '该声明包含敏感字段，面板仅支持改名并保留原传输配置；修改命令或 URL 请编辑 mcp.json。'
              : '环境变量与请求头请在 mcp.json 中维护；面板保存会自动保留已有敏感字段原文。'}
          </p>

          {activeError ? (
            <p role="alert" className="kpbl-field-error">
              {activeError}
            </p>
          ) : null}
        </div>
      ) : null}
    </ModalDialog>
  );
}
