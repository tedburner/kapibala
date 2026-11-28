import type { HTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './icon.js';

/** 胶囊徽标语义色调：`pulse` 专供待审批与运行焦点（琥珀占比受控）。 */
export type BadgeTone = 'neutral' | 'pulse' | 'success' | 'warning' | 'danger' | 'info';

/** `Badge` 入参契约：固定 `11px` 第三字阶与 `--kpbl-r-sm`（`6px`）圆角。 */
export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone?: BadgeTone;
  readonly outline?: boolean;
  readonly icon?: IconName;
  readonly children: ReactNode;
}

/** 轻量语义胶囊原语：承载风险分级、分支标记、计数与分类标签。 */
export function Badge({
  tone = 'neutral',
  outline = false,
  icon,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      data-tone={tone}
      data-outline={outline ? 'true' : undefined}
      className={className ? `kpbl-badge ${className}` : 'kpbl-badge'}
      {...rest}
    >
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}

/**
 * `HarnessBadge` 入参契约：对齐 `017` §5.2 `ThreadHarnessIdentity` 字段，
 * 统一渲染自研本地会话与外部代理（`ACP / CLI / App-Server / RPC`）来源身份胶囊。
 */
export interface HarnessBadgeProps {
  readonly kind?: 'native' | 'external';
  readonly label: string;
  readonly transportLabel?: string;
  readonly worktreeBranch?: string;
  readonly className?: string;
}

/**
 * 代理身份胶囊原语：外部代理展示 `代理名 · 协议`（如 `Claude Code · CLI`），
 * 若绑定独立 Git Worktree 则可并排附带分支胶囊。
 */
export function HarnessBadge({
  kind = 'native',
  label,
  transportLabel,
  worktreeBranch,
  className,
}: HarnessBadgeProps) {
  const fullText = transportLabel ? `${label} · ${transportLabel}` : label;
  return (
    <span
      className={
        className ? `inline-flex items-center gap-1 ${className}` : 'inline-flex items-center gap-1'
      }
    >
      <Badge outline={kind === 'external'} icon={kind === 'external' ? 'plugs-connected' : 'cpu'}>
        {fullText}
      </Badge>
      {worktreeBranch ? (
        <Badge tone="info" icon="git-branch">
          {worktreeBranch}
        </Badge>
      ) : null}
    </span>
  );
}

/** 运行与探针状态枚举。 */
export type StatusDotState =
  | 'idle'
  | 'running'
  | 'waiting_approval'
  | 'success'
  | 'warning'
  | 'danger'
  | 'offline';

/** 状态默认中文无障碍文案映射：严禁仅靠圆点颜色传达状态（017 §4）。 */
export const STATUS_DOT_LABELS: Readonly<Record<StatusDotState, string>> = {
  idle: '空闲',
  running: '运行中',
  waiting_approval: '待审批',
  success: '就绪',
  warning: '注意',
  danger: '异常',
  offline: '未就绪',
};

/**
 * `StatusDot` 入参契约：`showLabel = false` 时强制在 DOM 内输出 `.kpbl-sr-only` 状态文本，
 * 确保色觉障碍用户与自动化无障碍断言始终可读当前精确状态。
 */
export interface StatusDotProps {
  readonly status: StatusDotState;
  readonly label?: string;
  readonly showLabel?: boolean;
  readonly className?: string;
}

/** 状态指示点原语：`running` 与 `waiting_approval` 激活水豚琥珀焦点色，其余维持语义色阶。 */
export function StatusDot({ status, label, showLabel = false, className }: StatusDotProps) {
  const resolvedLabel = label ?? STATUS_DOT_LABELS[status];
  return (
    <span
      title={showLabel ? undefined : resolvedLabel}
      className={className ? `kpbl-status ${className}` : 'kpbl-status'}
    >
      <span aria-hidden="true" data-status={status} className="kpbl-status-dot" />
      {showLabel ? (
        <span>{resolvedLabel}</span>
      ) : (
        <span className="kpbl-sr-only">{resolvedLabel}</span>
      )}
    </span>
  );
}

/** `Kbd` 入参契约：语义化 `<kbd>` 快捷键徽标（固定 `--kpbl-r-xs: 4px`）。 */
export interface KbdProps extends HTMLAttributes<HTMLElement> {
  readonly children: ReactNode;
}

/** 键盘快捷键展示原语：用于 `⌘K`、`⌘J`、`Y / S / N` 等操作提示。 */
export function Kbd({ className, children, ...rest }: KbdProps) {
  return (
    <kbd className={className ? `kpbl-kbd ${className}` : 'kpbl-kbd'} {...rest}>
      {children}
    </kbd>
  );
}
