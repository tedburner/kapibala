import { useState } from 'react';
import type { Workspace } from '../../../shared/contracts.js';
import { useWorkspaceStore } from '../../stores/index.js';
import {
  Badge,
  Button,
  MiddleTruncate,
  SettingRow,
  SettingSection,
  StatusDot,
} from '../../ui/index.js';
import { FullAccessConfirmDialog, WorkspaceTrustDialog } from '../dialogs/index.js';
import { type SettingsCatalog, withSettingsWatchdog } from './settings-helpers.js';

const DEFAULT_MODES = [
  {
    mode: 'Plan',
    label: '计划模式',
    hint: '编辑前先生成只读执行计划，确认后再落盘改动。',
  },
  {
    mode: 'Approval',
    label: '变更前确认',
    hint: '默认安全档位：修改文件或执行副作用命令前请求人工确认。',
  },
  {
    mode: 'Auto',
    label: '自主模式',
    hint: '工作区内文件读写与常见只读命令自动放行；网络、写入类未知命令与越界访问仍会询问。',
  },
] as const;

const PROTECTED_BOUNDARIES = [
  {
    pattern: '.git',
    title: 'Git 版本库元数据（.git）',
    description: '强制阻断直接覆写 .git/config、.git/hooks 等钩子与引用，防止植入持久化执行脚本。',
    badge: '强制写保护',
  },
  {
    pattern: '.env*',
    title: '本地环境变量与凭证文件（.env*）',
    description:
      '读写 .env、.env.local、.env.production 等敏感文件始终触发人工审批并执行输出脱敏。',
    badge: '强制审批',
  },
  {
    pattern: '.kapibala/**',
    title: 'Kapibala 宿主受控配置目录（.kapibala/**）',
    description: '保护 settings.json、mcp.json、信任账本与会话证据不被代理自行篡改。',
    badge: '宿主独占',
  },
] as const;

/**
 * `PermissionsPage` 入参契约（017 §6.7 & §7）：
 * 管理新建会话默认审批档位、当前会话「启用完全访问？」二次确认、登记工作区信任列表与受保护路径边界说明。
 */
export interface PermissionsPageProps {
  readonly catalog?: SettingsCatalog;
  readonly spaces?: readonly Workspace[];
  readonly activeSessionScope?: { readonly workspaceId: string; readonly sessionId: string };
  readonly currentSessionMode?: 'Approval' | 'Plan' | 'Auto' | 'FullAccess';
  readonly hostDown?: boolean;
  readonly reload?: () => Promise<void>;
  readonly onSpacesChanged?: (updated?: Workspace) => Promise<void> | void;
  readonly onEnableFullAccess?: () => Promise<void>;
  readonly report?: (message: string) => void;
}

/**
 * 壳内设置中心「权限审批」页面。
 */
export function PermissionsPage({
  catalog,
  spaces: propSpaces,
  activeSessionScope,
  currentSessionMode,
  hostDown = false,
  reload,
  onSpacesChanged,
  onEnableFullAccess,
  report,
}: PermissionsPageProps) {
  const storeSpaces = useWorkspaceStore((s) => s.spaces);
  const resolvedSpaces: readonly Workspace[] = propSpaces ?? storeSpaces;
  const [savingMode, setSavingMode] = useState(false);
  const [trustBusyId, setTrustBusyId] = useState<string>();
  const [pendingTrustSpace, setPendingTrustSpace] = useState<Workspace>();
  const [trustError, setTrustError] = useState('');
  const [fullAccessDialogOpen, setFullAccessDialogOpen] = useState(false);
  const [fullAccessBusy, setFullAccessBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const activeDefaultMode = catalog?.permissionMode ?? 'Approval';

  async function selectDefaultMode(mode: 'Plan' | 'Approval' | 'Auto'): Promise<void> {
    if (savingMode || hostDown || typeof window === 'undefined' || !window.kapibala) return;
    setSavingMode(true);
    setNotice('');
    try {
      await withSettingsWatchdog(
        window.kapibala.settings.setPermissionMode(mode),
        '写入默认审批档位超时。',
      );
      await reload?.();
      setNotice('已更新新建会话的默认审批档位。');
    } catch (error) {
      report?.(error instanceof Error ? error.message : '更新默认审批档位失败。');
    } finally {
      setSavingMode(false);
    }
  }

  async function confirmEnableFullAccess(): Promise<void> {
    setFullAccessBusy(true);
    setNotice('');
    try {
      if (onEnableFullAccess) {
        await onEnableFullAccess();
      } else if (activeSessionScope && typeof window !== 'undefined' && window.kapibala) {
        await withSettingsWatchdog(
          window.kapibala.session.configure({
            ...activeSessionScope,
            mode: 'FullAccess',
            confirmFullAccess: true,
          }),
          '启用本会话完全访问超时。',
        );
      }
      setFullAccessDialogOpen(false);
      setNotice('已为当前会话启用完全访问（FullAccess）。');
    } catch (error) {
      report?.(error instanceof Error ? error.message : '启用完全访问失败。');
    } finally {
      setFullAccessBusy(false);
    }
  }

  async function updateWorkspaceTrust(space: Workspace, accept: boolean): Promise<void> {
    if (typeof window === 'undefined' || !window.kapibala || hostDown) return;
    setTrustBusyId(space.id);
    setTrustError('');
    setNotice('');
    try {
      const updated = await withSettingsWatchdog(
        window.kapibala.workspace.confirmTrust({
          workspaceId: space.id,
          trustToken: space.trustToken,
          accept,
        }),
        '更新工作区信任状态超时。',
      );
      setPendingTrustSpace(undefined);
      await onSpacesChanged?.(updated);
      setNotice(accept ? `已授权信任「${space.name}」。` : `已撤销「${space.name}」目录信任。`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : '更新工作区信任状态失败。';
      setTrustError(msg);
      report?.(msg);
    } finally {
      setTrustBusyId(undefined);
    }
  }

  return (
    <div className="kpbl-settings-stack">
      {notice ? (
        <output className="kpbl-settings-banner" data-tone="success">
          <span>{notice}</span>
        </output>
      ) : null}

      <SettingSection
        title="新建会话默认审批档位"
        description="与 CLI 共用全局配置，保存立即写盘；已打开的活跃会话保留各自上次选择的档位。"
      >
        {DEFAULT_MODES.map((option) => {
          const isCurrent = activeDefaultMode === option.mode;
          return (
            <SettingRow
              key={option.mode}
              title={
                <span className="kpbl-row-title-line">
                  <span>{option.label}</span>
                  {isCurrent ? <Badge tone="info">当前默认</Badge> : null}
                </span>
              }
              description={option.hint}
              control={
                <Button
                  variant={isCurrent ? 'solid' : 'outline'}
                  size="sm"
                  aria-pressed={isCurrent}
                  aria-label={option.label}
                  disabled={savingMode || hostDown}
                  onClick={() => void selectDefaultMode(option.mode)}
                >
                  {isCurrent ? '当前默认' : `设为${option.label}`}
                </Button>
              }
            />
          );
        })}

        <SettingRow
          title={
            <span className="kpbl-row-title-line">
              <span>完全访问（FullAccess · 仅当前会话）</span>
              {currentSessionMode === 'FullAccess' ? (
                <Badge tone="danger">本会话已开启</Badge>
              ) : null}
            </span>
          }
          description="跳过常规工具审批，永不写入全局默认配置；仅限在完全可信的隔离仓库内按需单次开启。"
          control={
            <Button
              variant="danger"
              size="sm"
              disabled={hostDown || currentSessionMode === 'FullAccess'}
              onClick={() => setFullAccessDialogOpen(true)}
            >
              {currentSessionMode === 'FullAccess' ? '已启用完全访问' : '启用完全访问'}
            </Button>
          }
        />
      </SettingSection>

      <SettingSection
        title="工作区目录信任"
        description="仅受信项目才加载目录内的项目指令、技能与项目级 MCP 声明；随时可撤销信任。"
      >
        {resolvedSpaces.length === 0 ? (
          <SettingRow
            title="暂无已登记项目工作区"
            description="在对话输入坞或侧栏添加本地项目文件夹时，将按原生路径身份校验并询问信任。"
          />
        ) : (
          resolvedSpaces.map((space) => (
            <SettingRow
              key={space.id}
              title={
                <span className="kpbl-row-title-line">
                  <span>{space.name}</span>
                  {space.kind === 'default' ? (
                    <Badge tone="success">内置受控空间</Badge>
                  ) : (
                    <StatusDot
                      status={space.trusted ? 'success' : 'warning'}
                      label={space.trusted ? '已信任' : '未信任'}
                      showLabel
                    />
                  )}
                </span>
              }
              description={<MiddleTruncate mono maxChars={62} text={space.root} />}
              control={
                space.kind === 'project' ? (
                  space.trusted ? (
                    <Button
                      variant="outline"
                      size="xs"
                      aria-label={`撤销信任 ${space.name}`}
                      loading={trustBusyId === space.id}
                      disabled={hostDown}
                      onClick={() => void updateWorkspaceTrust(space, false)}
                    >
                      撤销信任
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="xs"
                      aria-label={`授权信任 ${space.name}`}
                      loading={trustBusyId === space.id}
                      disabled={hostDown}
                      onClick={() => {
                        setTrustError('');
                        setPendingTrustSpace(space);
                      }}
                    >
                      授权信任
                    </Button>
                  )
                ) : undefined
              }
            />
          ))
        )}
      </SettingSection>

      <SettingSection
        title="受保护路径边界"
        description="无论会话处于何种常规档位，以下敏感边界始终受沙箱与宿主级安全规则保护："
      >
        {PROTECTED_BOUNDARIES.map((rule) => (
          <SettingRow
            key={rule.pattern}
            title={
              <span className="kpbl-row-title-line">
                <code className="kpbl-mono-inline">{rule.pattern}</code>
                <span>{rule.title}</span>
              </span>
            }
            description={rule.description}
            control={<Badge tone="warning">{rule.badge}</Badge>}
          />
        ))}
      </SettingSection>

      <FullAccessConfirmDialog
        open={fullAccessDialogOpen}
        onOpenChange={setFullAccessDialogOpen}
        busy={fullAccessBusy}
        onConfirm={() => void confirmEnableFullAccess()}
      />

      <WorkspaceTrustDialog
        open={Boolean(pendingTrustSpace)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setPendingTrustSpace(undefined);
        }}
        rootPath={pendingTrustSpace?.root}
        busy={Boolean(pendingTrustSpace && trustBusyId === pendingTrustSpace.id)}
        error={trustError || undefined}
        confirmLabel="信任并启用"
        busyLabel="授权中…"
        closeLabel="取消信任"
        onCancel={() => setPendingTrustSpace(undefined)}
        onConfirm={() => {
          if (pendingTrustSpace) void updateWorkspaceTrust(pendingTrustSpace, true);
        }}
      />
    </div>
  );
}
