import { Button, Input, LayerDialog } from '@cloudflare/kumo';
import { DesktopIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { ProjectNameSchema, type Workspace } from '../shared/contracts.js';
import { KubaiIcon } from './icons/KubaiIcon.js';

/** 项目创建是已有目录的显示入口，不创建目录或任务；信任取消保留表单，原语负责双层弹窗与焦点。 */
export function ProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreated(workspace: Workspace): Promise<void>;
}) {
  const [name, setName] = useState('');
  const [edited, setEdited] = useState(false);
  const [selected, setSelected] = useState<Workspace>();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const validName = ProjectNameSchema.safeParse(name);
  async function choose() {
    setBusy(true);
    setError('');
    try {
      const workspace = await window.kapibala.workspace.pick();
      if (!workspace) return;
      if (workspace.kind !== 'project') {
        setError('此目录是默认空间，请选择一个项目文件夹。');
        return;
      }
      setSelected(workspace);
      if (!edited)
        setName(
          Array.from(workspace.name)
            .filter((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127)
            .join('')
            .slice(0, 80),
        );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法选择文件夹，请重试。');
    } finally {
      setBusy(false);
    }
  }
  async function create(acceptTrust: boolean) {
    if (!selected || !validName.success) return;
    setBusy(true);
    setError('');
    try {
      if (!acceptTrust) {
        const current = await window.kapibala.workspace.confirmTrust({
          workspaceId: selected.id,
          trustToken: selected.trustToken,
          accept: false,
        });
        setSelected(current);
        if (!current.trusted) {
          setConfirm(true);
          return;
        }
      }
      const workspace = await window.kapibala.workspace.addProject({
        workspaceId: selected.id,
        name: validName.data,
        trustToken: selected.trustToken,
        acceptTrust,
      });
      await onCreated(workspace);
      setConfirm(false);
      onOpenChange(false);
      setSelected(undefined);
      setName('');
      setEdited(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法创建项目，请重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <LayerDialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          onOpenChange(value);
          if (!value) setConfirm(false);
        }
      }}
      dismissDisabled={busy}
    >
      <LayerDialog.Content size="base" closeLabel="关闭创建项目">
        <LayerDialog.Title>
          <span data-kapibala-modal="true">创建项目</span>
        </LayerDialog.Title>
        <LayerDialog.Description>选择项目名称和源文件夹。</LayerDialog.Description>
        <LayerDialog.Body>
          <div className="space-y-4">
            <Input
              label="项目名称"
              size="base"
              placeholder="新项目"
              value={name}
              maxLength={80}
              disabled={busy}
              onValueChange={(value) => {
                setName(value);
                setEdited(true);
              }}
            />
            <section>
              <h3 className="mb-3 text-sm font-medium">源文件夹</h3>
              <div className="flex min-h-32 flex-col items-center justify-center gap-3 rounded-xl border border-kumo-line px-4 py-5">
                <span className="flex items-center gap-2 text-sm text-kumo-subtle">
                  <DesktopIcon size={18} aria-hidden="true" />
                  在此电脑上添加文件夹
                </span>
                <Button
                  className="kapibala-action"
                  variant="secondary"
                  aria-label={selected ? '更换文件夹' : '选择文件夹'}
                  disabled={busy}
                  onClick={() => void choose()}
                >
                  <KubaiIcon name="新建项目" size={20} />
                  {selected ? '更换' : '添加'}
                </Button>
                {selected && (
                  <span className="max-w-full break-all text-sm text-kumo-subtle">
                    {selected.root}
                  </span>
                )}
              </div>
            </section>
            {!confirm && error && (
              <p role="alert" className="text-sm text-kumo-danger">
                {error}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-3">
              <Button
                className="kapibala-action"
                variant="ghost"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                取消
              </Button>
              <Button
                className="kapibala-action"
                variant="primary"
                disabled={busy || !selected || !validName.success}
                onClick={() => void create(false)}
              >
                创建项目
              </Button>
            </div>
          </div>
        </LayerDialog.Body>
      </LayerDialog.Content>
      <LayerDialog
        open={confirm}
        onOpenChange={(value) => {
          if (!busy) setConfirm(value);
        }}
        dismissDisabled={busy}
      >
        <LayerDialog.Content size="sm" closeLabel="返回创建项目">
          <LayerDialog.Title>
            <span data-kapibala-modal="true">信任此文件夹吗？</span>
          </LayerDialog.Title>
          <LayerDialog.Description>请确认文件夹来源可靠后继续。</LayerDialog.Description>
          <LayerDialog.Body>
            <div className="space-y-4">
              <p className="flex items-center gap-2 text-sm text-kumo-subtle">
                <DesktopIcon size={18} aria-hidden="true" />
                此电脑
              </p>
              <p className="break-all font-mono text-sm">{selected?.root}</p>
              <p className="text-sm leading-6 text-kumo-subtle">
                Kapibala
                可在当前权限设置允许的范围内读取、编辑此文件夹中的文件，并运行命令。信任后会加载项目配置、指令、技能与
                MCP。请仅在你信任此文件夹时继续。
              </p>
              {error && (
                <p role="alert" className="text-sm text-kumo-danger">
                  {error}
                </p>
              )}
              <div className="flex flex-col-reverse gap-3">
                <Button
                  className="kapibala-action w-full justify-center"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setConfirm(false);
                    setError('');
                  }}
                >
                  取消
                </Button>
                <Button
                  className="kapibala-action w-full justify-center"
                  variant="primary"
                  disabled={busy}
                  onClick={() => void create(true)}
                >
                  {busy ? '正在创建…' : '信任文件夹并创建'}
                </Button>
              </div>
            </div>
          </LayerDialog.Body>
        </LayerDialog.Content>
      </LayerDialog>
    </LayerDialog>
  );
}
