import { useMemo, useState } from 'react';
import {
  Badge,
  EmptyState,
  Select,
  type SelectOption,
  SettingRow,
  SettingSection,
} from '../../ui/index.js';
import { type SettingsCatalog, withSettingsWatchdog } from './settings-helpers.js';

const ROUTING_ROLES = [
  {
    role: 'planning',
    label: '规划角色',
    description: '用于复杂任务拆解、架构设计与只读计划推演（/plan）。',
  },
  {
    role: 'execution',
    label: '执行角色',
    description: '用于多步工具调用、代码编辑与验证闭环。',
  },
  {
    role: 'fast',
    label: '快速角色',
    description: '用于轻量问答、检索筛选与高频短任务响应。',
  },
  {
    role: 'summary',
    label: '摘要角色',
    description: '用于长上下文压缩归并、会话标题生成与分叉摘要。',
  },
] as const;

const FOLLOW_DEFAULT_VALUE = '__default__';

/**
 * `RoutingPage` 入参契约（017 §6.7）：
 * 单层 `SettingSection` + `SettingRow` 管理新建本地会话的全局默认模型与四类场景角色路由。
 */
export interface RoutingPageProps {
  readonly catalog?: SettingsCatalog;
  readonly reload?: () => Promise<void>;
  readonly report?: (message: string) => void;
  readonly hostDown?: boolean;
}

/**
 * 壳内设置中心「默认模型与路由」页面。
 */
export function RoutingPage({ catalog, reload, report, hostDown = false }: RoutingPageProps) {
  const [busyRole, setBusyRole] = useState<string>();

  const availableOptions = useMemo<readonly SelectOption<string>[]>(
    () =>
      (catalog?.profiles ?? [])
        .filter((item) => item.scope === 'global' && item.credential.configured && !item.disabled)
        .map((item) => ({
          value: item.id,
          label: item.name,
          badge: item.providerKey,
        })),
    [catalog],
  );

  const routingOptions = useMemo<readonly SelectOption<string>[]>(
    () => [{ value: FOLLOW_DEFAULT_VALUE, label: '使用默认模型' }, ...availableOptions],
    [availableOptions],
  );

  async function updateDefaultModel(profileId: string): Promise<void> {
    if (typeof window === 'undefined' || !window.kapibala || hostDown) return;
    setBusyRole('default');
    try {
      await withSettingsWatchdog(
        window.kapibala.settings.setDefault(profileId),
        '写入默认模型超时。',
      );
      await reload?.();
    } catch (error) {
      report?.(error instanceof Error ? error.message : '更新默认模型失败。');
    } finally {
      setBusyRole(undefined);
    }
  }

  async function updateScenarioRoute(
    role: 'planning' | 'execution' | 'fast' | 'summary',
    selectedValue: string,
  ): Promise<void> {
    if (typeof window === 'undefined' || !window.kapibala || hostDown) return;
    setBusyRole(role);
    try {
      await withSettingsWatchdog(
        window.kapibala.settings.setRouting({
          role,
          profileId: selectedValue === FOLLOW_DEFAULT_VALUE ? undefined : selectedValue,
        }),
        '写入角色路由超时。',
      );
      await reload?.();
    } catch (error) {
      report?.(error instanceof Error ? error.message : '更新角色路由失败。');
    } finally {
      setBusyRole(undefined);
    }
  }

  if (availableOptions.length === 0) {
    return (
      <div className="kpbl-settings-stack">
        <EmptyState
          icon="shuffle"
          title="暂无可参与路由的已配置模型"
          description="请先在「模型与服务商」分组配置至少一个服务商 API Key 并启用模型。"
        />
      </div>
    );
  }

  return (
    <div className="kpbl-settings-stack">
      <SettingSection
        title="全局默认模型"
        description="新建或重新打开会话时生效；已打开的活跃会话保持各自当前所选模型。"
        actions={
          catalog?.projectOverride ? (
            <Badge tone="warning">当前工作区含项目级覆盖</Badge>
          ) : undefined
        }
      >
        <SettingRow
          title="全局默认模型"
          description={
            catalog?.projectOverride
              ? '当前空间存在 .kapibala/settings.json 项目覆盖，新建会话优先读取空间内配置。'
              : '当前空间无项目覆盖，直接沿用此处选定的全局默认模型。'
          }
          control={
            <Select
              aria-label="全局默认模型"
              size="sm"
              value={catalog?.defaultModel}
              options={availableOptions}
              disabled={hostDown || busyRole === 'default'}
              onValueChange={(val) => void updateDefaultModel(val)}
            />
          }
        />
      </SettingSection>

      <SettingSection
        title="场景角色路由"
        description="按推理职责绑定专用模型；选择「使用默认模型」时自动跟随上方全局默认配置。"
      >
        {ROUTING_ROLES.map((entry) => (
          <SettingRow
            key={entry.role}
            title={entry.label}
            description={entry.description}
            control={
              <Select
                aria-label={entry.label}
                size="sm"
                value={catalog?.routing[entry.role] ?? FOLLOW_DEFAULT_VALUE}
                options={routingOptions}
                disabled={hostDown || busyRole === entry.role}
                onValueChange={(val) => void updateScenarioRoute(entry.role, val)}
              />
            }
          />
        ))}
      </SettingSection>
    </div>
  );
}
