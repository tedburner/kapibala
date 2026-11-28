import { type ReactNode, useId } from 'react';
import { Icon, type IconName } from './icon.js';

/**
 * `SettingSection` 入参契约（017 §4 & §6.7）：
 * 采用单层 `--kpbl-line-default` 细框容器承载一组设置行，从结构上彻底杜绝「灰底套白卡」多层嵌套。
 */
export interface SettingSectionProps {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

/** 壳内设置中心单层分组容器原语：标题关联 `<section aria-labelledby>` 便于读屏器按区域跳转。 */
export function SettingSection({
  title,
  description,
  actions,
  children,
  className,
}: SettingSectionProps) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={title ? titleId : undefined}
      className={className ? `kpbl-setting-section ${className}` : 'kpbl-setting-section'}
    >
      {title || description || actions ? (
        <div className="kpbl-setting-section-head">
          <div className="min-w-0 flex-1">
            {title ? (
              <h3 id={titleId} className="kpbl-setting-section-title">
                {title}
              </h3>
            ) : null}
            {description ? <p className="kpbl-setting-section-desc">{description}</p> : null}
          </div>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </div>
      ) : null}
      <div className="kpbl-setting-box">{children}</div>
    </section>
  );
}

/**
 * `SettingRow` 入参契约：左文右控标准设置行；
 * 当传入 `children` 时在该行下方以细线分隔展开手风琴详情区（如外部代理路径/参数覆盖表单）。
 */
export interface SettingRowProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly control?: ReactNode;
  readonly children?: ReactNode;
  readonly htmlFor?: string;
  readonly align?: 'center' | 'start';
  readonly className?: string;
}

/** 单条设置行原语：相邻行通过 CSS 相邻兄弟选择器渲染细分隔线，首尾不冗余描边。 */
export function SettingRow({
  title,
  description,
  control,
  children,
  htmlFor,
  align = 'center',
  className,
}: SettingRowProps) {
  return (
    <div className={className ? `kpbl-setting-row ${className}` : 'kpbl-setting-row'}>
      <div data-align={align} className="kpbl-setting-row-main">
        <div className="kpbl-setting-row-copy">
          {htmlFor ? (
            <label htmlFor={htmlFor} className="kpbl-setting-row-title">
              {title}
            </label>
          ) : (
            <div className="kpbl-setting-row-title">{title}</div>
          )}
          {description ? <p className="kpbl-setting-row-desc">{description}</p> : null}
        </div>
        {control ? <div className="kpbl-setting-row-control">{control}</div> : null}
      </div>
      {children ? <div className="kpbl-setting-row-detail">{children}</div> : null}
    </div>
  );
}

/**
 * `EmptyState` 入参契约：用于工作台空标签、归档空列表与检索零结果提示；
 * 注意左栏空分组（如无条目的临时对话）按 `017` §6.1 必须直接返回 `null` 隐藏而非渲染空状态。
 */
export interface EmptyStateProps {
  readonly icon?: IconName;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
}

/** 轻量虚线边单层空状态原语。 */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={className ? `kpbl-empty-state ${className}` : 'kpbl-empty-state'}>
      {icon ? <Icon name={icon} size={20} /> : null}
      <div className="kpbl-setting-row-title">{title}</div>
      {description ? <p className="kpbl-field-hint">{description}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
