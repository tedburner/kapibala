import { useState } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  SecretField,
  SettingRow,
  SettingSection,
  Switch,
} from '../../ui/index.js';
import type { SettingsModelProfile } from './settings-helpers.js';

function formatContextTokens(tokens?: number): string {
  if (!tokens) return '自动估算窗口';
  return tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M 上下文`
    : `${Math.round(tokens / 1000)}k 上下文`;
}

/**
 * `ProviderVendorDetail` 入参契约：
 * 渲染当前选中服务商分组的共享 API Key 表单与单层模型列表行。
 */
export interface ProviderVendorDetailProps {
  readonly vendorName: string;
  readonly vendorDescription?: string;
  readonly defaultModelId?: string;
  readonly primaryGlobalModel?: SettingsModelProfile;
  readonly providerModels: readonly SettingsModelProfile[];
  readonly sharedKey: string;
  readonly canClearSavedKey: boolean;
  readonly busy: boolean;
  readonly hostDown: boolean;
  readonly testingId?: string;
  readonly testState?: { readonly id: string; readonly ok: boolean; readonly message: string };
  readonly onChangeSharedKey: (value: string) => void;
  readonly onSaveSharedKey: () => void;
  readonly onClearSharedKey: () => void;
  readonly onTestModel: (model: SettingsModelProfile) => void;
  readonly onEditModel: (model: SettingsModelProfile) => void;
  readonly onDeleteModel: (model: SettingsModelProfile) => void;
  readonly onToggleModel: (model: SettingsModelProfile, enabled: boolean) => void;
}

/**
 * 模型与服务商页右栏详情：共享凭证卡片 + 模型启停与连接探测列表。
 */
export function ProviderVendorDetail({
  vendorName,
  vendorDescription,
  defaultModelId,
  primaryGlobalModel,
  providerModels,
  sharedKey,
  canClearSavedKey,
  busy,
  hostDown,
  testingId,
  testState,
  onChangeSharedKey,
  onSaveSharedKey,
  onClearSharedKey,
  onTestModel,
  onEditModel,
  onDeleteModel,
  onToggleModel,
}: ProviderVendorDetailProps) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>();
  const vendorConfigured = providerModels.some((m) => m.credential.configured);

  return (
    <div className="kpbl-vendor-detail">
      {primaryGlobalModel ? (
        <SettingSection
          title={`${vendorName} · 共享凭证`}
          description={
            vendorDescription || '同一服务商分组下的模型共享此 API Key，已存凭证不在界面明文回显。'
          }
          actions={
            <Badge tone={vendorConfigured ? 'success' : 'neutral'}>
              {vendorConfigured
                ? primaryGlobalModel.credential.source === 'env' ||
                  primaryGlobalModel.credential.source === 'family-env'
                  ? '已配置 · 环境变量'
                  : '已配置 · 全局设置'
                : '未配置密钥'}
            </Badge>
          }
        >
          <SettingRow
            align="start"
            title="服务商 API Key"
            description={`凭证组：${primaryGlobalModel.credential.group}${
              primaryGlobalModel.credential.env
                ? `（支持环境变量 ${primaryGlobalModel.credential.env}）`
                : ''
            }`}
          >
            <div className="kpbl-inline-key-form">
              <SecretField
                aria-label="服务商共享 API Key"
                value={sharedKey}
                configured={vendorConfigured}
                disabled={busy || hostDown}
                containerClassName="kpbl-inline-key-field"
                onValueChange={onChangeSharedKey}
              />
              <Button
                variant="solid"
                size="sm"
                disabled={busy || hostDown || !sharedKey.trim()}
                onClick={onSaveSharedKey}
              >
                保存密钥
              </Button>
              {(sharedKey.length > 0 || (canClearSavedKey && vendorConfigured)) && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || hostDown}
                  onClick={onClearSharedKey}
                >
                  {sharedKey.length > 0 ? '清空输入' : '清除密钥'}
                </Button>
              )}
            </div>
          </SettingRow>
        </SettingSection>
      ) : null}

      <SettingSection
        title={`${vendorName} · 模型列表`}
        description="关闭开关仅将该模型从对话选择器隐藏，保留已存凭证与自定义参数。"
      >
        {providerModels.length === 0 ? (
          <EmptyState
            icon="plugs-connected"
            title="该分组暂无模型"
            description="点击右上角「新增自定义模型」登记兼容 OpenAI 或 Anthropic 的服务端点。"
          />
        ) : (
          providerModels.map((item) => {
            const isDefault = defaultModelId === item.id;
            const rowTest = testState?.id === item.id ? testState : undefined;
            const confirmingDelete = confirmDeleteId === item.id;
            return (
              <SettingRow
                key={item.id}
                title={
                  <span className="kpbl-row-title-line">
                    <span>{item.name}</span>
                    {isDefault ? <Badge tone="info">默认</Badge> : null}
                    {item.scope === 'project' ? <Badge outline>项目级只读</Badge> : null}
                    {!item.credential.configured ? <Badge tone="warning">未配置密钥</Badge> : null}
                    {item.supportsThinking ? <Badge>思考</Badge> : null}
                    {item.disabled ? <Badge>已停用</Badge> : null}
                  </span>
                }
                description={`${item.modelName} · ${formatContextTokens(item.contextWindow)}`}
                control={
                  item.scope === 'global' ? (
                    <>
                      <Button
                        variant="ghost"
                        size="xs"
                        leadingIcon="plugs-connected"
                        aria-label={`测试连接 ${item.name}`}
                        loading={testingId === item.id}
                        disabled={busy || hostDown}
                        onClick={() => onTestModel(item)}
                      >
                        测试连接
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        leadingIcon="pencil"
                        aria-label={`编辑模型 ${item.name}`}
                        disabled={busy || hostDown}
                        onClick={() => onEditModel(item)}
                      >
                        编辑
                      </Button>
                      {!item.builtin ? (
                        confirmingDelete ? (
                          <>
                            <Button
                              variant="danger"
                              size="xs"
                              aria-label={`确认删除 ${item.name}`}
                              disabled={busy || hostDown}
                              onClick={() => {
                                setConfirmDeleteId(undefined);
                                onDeleteModel(item);
                              }}
                            >
                              确认删除
                            </Button>
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() => setConfirmDeleteId(undefined)}
                            >
                              取消
                            </Button>
                          </>
                        ) : (
                          <IconButton
                            size="xs"
                            icon="trash"
                            aria-label={`删除模型 ${item.name}`}
                            disabled={busy || hostDown}
                            onClick={() => setConfirmDeleteId(item.id)}
                          />
                        )
                      ) : null}
                      <Switch
                        size="sm"
                        checked={!item.disabled}
                        disabled={busy || hostDown}
                        aria-label={`${item.disabled ? '启用' : '停用'}模型 ${item.name}`}
                        onCheckedChange={(checked) => onToggleModel(item, checked)}
                      />
                    </>
                  ) : undefined
                }
              >
                {rowTest ? (
                  <output
                    className={rowTest.ok ? 'kpbl-field-hint' : 'kpbl-field-error'}
                    role={rowTest.ok ? 'status' : 'alert'}
                  >
                    {rowTest.message}
                  </output>
                ) : null}
              </SettingRow>
            );
          })
        )}
      </SettingSection>
    </div>
  );
}
