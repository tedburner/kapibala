import { useEffect, useRef, useState } from 'react';
import { ProjectNameSchema, type Workspace } from '../../../shared/contracts.js';
import { Button, Icon, ModalDialog, TextField } from '../../ui/index.js';

/**
 * 清洗系统目录名称以派生初始项目显示名：剥离 ASCII 控制字符并截断至 80 字符上限，
 * 确保任意合法本地目录名首次选中后无需手工清理即可通过 `ProjectNameSchema` 校验。
 */
export function sanitizeInitialProjectName(rawName: string): string {
  return Array.from(rawName)
    .filter((ch) => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127)
    .join('')
    .slice(0, 80);
}

/**
 * `WorkspaceTrustDialog` 入参契约（017 §0 铁律 3 & §7）：
 * 锁定可访问标题 `信任此文件夹吗？`，初始焦点默认落在「取消」安全按钮以防回车误授信未知仓库；
 * 同时复用于「创建项目 -> 信任确认」与「未受信历史项目 -> 重新授权信任」两条路径。
 */
export interface WorkspaceTrustDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly rootPath?: string;
  readonly busy?: boolean;
  readonly error?: string;
  readonly confirmLabel?: string;
  readonly busyLabel?: string;
  readonly cancelLabel?: string;
  readonly closeLabel?: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * 工作区目录信任确认模态框：明确告知信任后将加载项目级配置、指令、技能与 MCP 声明。
 */
export function WorkspaceTrustDialog({
  open,
  onOpenChange,
  rootPath,
  busy = false,
  error,
  confirmLabel = '信任文件夹并创建',
  busyLabel = '正在创建…',
  cancelLabel = '取消',
  closeLabel = '返回创建项目',
  onConfirm,
  onCancel,
}: WorkspaceTrustDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  return (
    <ModalDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy && !nextOpen) {
          onCancel();
          onOpenChange(false);
        }
      }}
      title="信任此文件夹吗？"
      description="请确认文件夹来源可靠后继续。"
      closedBy={busy ? 'none' : 'closerequest'}
      closeLabel={closeLabel}
      initialFocusRef={cancelRef}
      footer={
        <>
          <Button
            ref={cancelRef}
            variant="outline"
            disabled={busy}
            onClick={() => {
              onCancel();
              onOpenChange(false);
            }}
          >
            {cancelLabel}
          </Button>
          <Button variant="solid" disabled={busy} onClick={onConfirm}>
            {busy ? busyLabel : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="kpbl-dialog-stack">
        <p className="kpbl-dialog-meta">
          <Icon name="desktop" size={16} />
          <span>此电脑</span>
        </p>
        {rootPath ? <p className="kpbl-dialog-mono-box">{rootPath}</p> : null}
        <p className="kpbl-dialog-copy">
          Kapibala
          可在当前权限设置允许的范围内读取、编辑此文件夹中的文件，并运行命令。信任后会加载项目配置、指令、技能与
          MCP。请仅在你信任此文件夹时继续。
        </p>
        {error ? (
          <p role="alert" className="kpbl-field-error">
            {error}
          </p>
        ) : null}
      </div>
    </ModalDialog>
  );
}

/**
 * `FullAccessConfirmDialog` 入参契约（017 §7）：
 * 锁定可访问标题 `启用完全访问？` 与取消按钮关闭标签 `取消完全访问`，
 * 初始焦点强制锚定在「取消」按钮以阻断键盘连击直接放开全自动执行权限。
 */
export interface FullAccessConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
}

/**
 * 会话级完全访问（`FullAccess`）二次确认模态框：完全访问永不落入全局默认配置，仅限当前可信会话按需开启。
 */
export function FullAccessConfirmDialog({
  open,
  onOpenChange,
  busy = false,
  onConfirm,
}: FullAccessConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  return (
    <ModalDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen);
      }}
      title="启用完全访问？"
      description="本会话将跳过通常的工具审批，可能修改文件或执行命令。仅在确认当前空间和任务可信时启用。"
      closedBy={busy ? 'none' : 'closerequest'}
      closeLabel="取消完全访问"
      initialFocusRef={cancelRef}
      footer={
        <>
          <Button
            ref={cancelRef}
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button variant="danger" disabled={busy} onClick={onConfirm}>
            确认启用本会话完全访问
          </Button>
        </>
      }
    />
  );
}

/**
 * `ProjectDialog` 入参契约（017 §0 铁律 3 & §7）：
 * 锁定可访问标题 `创建项目`；当所选目录尚未授信时单层切换至 `WorkspaceTrustDialog`（零「弹窗套弹窗」），
 * 取消授信后完整保留用户已填项目名称与已选源目录，支持可选注入测试桥以脱离 Electron 独立验证。
 */
export interface ProjectDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (workspace: Workspace) => Promise<void>;
  readonly initialSelected?: Workspace;
  readonly initialName?: string;
  readonly initialConfirmTrust?: boolean;
}

/**
 * 项目登记与源目录选择模态框：项目是本地已有目录的工作区入口，不在磁盘上新建空文件夹或自动触发会话请求。
 */
export function ProjectDialog({
  open,
  onOpenChange,
  onCreated,
  initialSelected,
  initialName = '',
  initialConfirmTrust = false,
}: ProjectDialogProps) {
  const [name, setName] = useState(initialName);
  const [edited, setEdited] = useState(Boolean(initialName));
  const [selected, setSelected] = useState<Workspace | undefined>(initialSelected);
  const [confirmTrust, setConfirmTrust] = useState(initialConfirmTrust);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      setConfirmTrust(false);
      setError('');
    }
  }, [open]);

  const validName = ProjectNameSchema.safeParse(name);

  async function chooseFolder(): Promise<void> {
    if (typeof window === 'undefined' || !window.kapibala) return;
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
      if (!edited) {
        setName(sanitizeInitialProjectName(workspace.name));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法选择文件夹，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function submitCreate(acceptTrust: boolean): Promise<void> {
    if (!selected || !validName.success) return;
    if (typeof window === 'undefined' || !window.kapibala) return;
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
          setConfirmTrust(true);
          return;
        }
      }
      const created = await window.kapibala.workspace.addProject({
        workspaceId: selected.id,
        name: validName.data,
        trustToken: selected.trustToken,
        acceptTrust,
      });
      await onCreated(created);
      setConfirmTrust(false);
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

  if (confirmTrust) {
    return (
      <WorkspaceTrustDialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!busy && !nextOpen) {
            setConfirmTrust(false);
            setError('');
          }
        }}
        rootPath={selected?.root}
        busy={busy}
        error={error || undefined}
        onCancel={() => {
          setConfirmTrust(false);
          setError('');
        }}
        onConfirm={() => void submitCreate(true)}
      />
    );
  }

  return (
    <ModalDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) {
          onOpenChange(nextOpen);
          if (!nextOpen) setConfirmTrust(false);
        }
      }}
      title="创建项目"
      description="选择项目名称和源文件夹。"
      closedBy={busy ? 'none' : 'closerequest'}
      closeLabel="关闭创建项目"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="solid"
            disabled={busy || !selected || !validName.success}
            onClick={() => void submitCreate(false)}
          >
            创建项目
          </Button>
        </>
      }
    >
      <div className="kpbl-dialog-stack">
        <TextField
          label="项目名称"
          placeholder="新项目"
          value={name}
          maxLength={80}
          disabled={busy}
          onValueChange={(value) => {
            setName(value);
            setEdited(true);
          }}
        />
        <div className="kpbl-field">
          <span className="kpbl-field-label">源文件夹</span>
          <div className="kpbl-project-folder-picker">
            <span className="kpbl-dialog-meta">
              <Icon name="desktop" size={16} />
              <span>在此电脑上添加文件夹</span>
            </span>
            <Button
              variant="outline"
              size="sm"
              leadingIcon="folder-plus"
              aria-label={selected ? '更换文件夹' : '选择文件夹'}
              disabled={busy}
              onClick={() => void chooseFolder()}
            >
              {selected ? '更换' : '添加'}
            </Button>
            {selected ? <span className="kpbl-project-folder-path">{selected.root}</span> : null}
          </div>
        </div>
        {error ? (
          <p role="alert" className="kpbl-field-error">
            {error}
          </p>
        ) : null}
      </div>
    </ModalDialog>
  );
}

/** `ProjectDialog` 的语义化具名别名，方便顶层装配按职责导入。 */
export const ProjectCreateDialog = ProjectDialog;
