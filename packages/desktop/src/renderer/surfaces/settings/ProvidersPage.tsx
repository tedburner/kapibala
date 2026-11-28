import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, SearchField, StatusDot } from '../../ui/index.js';
import { ProviderModelModal } from './ProviderModelModal.js';
import { ProviderVendorDetail } from './ProviderVendorDetail.js';
import {
  type SettingsCatalog,
  type SettingsModelProfile,
  profileToDraft,
  withSettingsWatchdog,
} from './settings-helpers.js';

/**
 * `ProvidersPage` 入参契约（017 §6.7）：
 * 承载「模型与服务商」双栏复合设置页（`max-width: 960px`），支持按厂商分组共享 API Key 更新、
 * 模型碳素墨 `Switch` 启停、单点连接探测（`测试连接`）及单层模态框新建/编辑自定义端点。
 */
export interface ProvidersPageProps {
  readonly catalog?: SettingsCatalog;
  readonly reload?: () => Promise<void>;
  readonly report?: (message: string) => void;
  readonly hostDown?: boolean;
  readonly onClearVendorKey?: (providerKey: string) => Promise<void>;
}

/**
 * 壳内设置中心「模型与服务商」页面。
 */
export function ProvidersPage({
  catalog,
  reload,
  report,
  hostDown = false,
  onClearVendorKey,
}: ProvidersPageProps) {
  const defaultProviderKey = useMemo(
    () => catalog?.profiles.find((item) => item.id === catalog.defaultModel)?.providerKey,
    [catalog],
  );
  const [selectedVendorKey, setSelectedVendorKey] = useState<string>(
    () => defaultProviderKey ?? catalog?.providers[0]?.key ?? 'custom',
  );
  const [search, setSearch] = useState('');
  const [sharedKey, setSharedKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string>();
  const [testState, setTestState] = useState<{
    readonly id: string;
    readonly ok: boolean;
    readonly message: string;
  }>();
  const [notice, setNotice] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<SettingsModelProfile>();

  useEffect(() => {
    if (!catalog) return;
    const exists = catalog.providers.some((p) => p.key === selectedVendorKey);
    if (!exists) {
      setSelectedVendorKey(defaultProviderKey ?? catalog.providers[0]?.key ?? 'custom');
    }
  }, [catalog, defaultProviderKey, selectedVendorKey]);

  const groupedModels = useMemo(() => {
    const map = new Map<string, SettingsModelProfile[]>();
    for (const item of catalog?.profiles ?? []) {
      const bucket = map.get(item.providerKey);
      if (bucket) bucket.push(item);
      else map.set(item.providerKey, [item]);
    }
    return map;
  }, [catalog]);

  const visibleProviders = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = catalog?.providers ?? [];
    const filtered = q
      ? all.filter(
          (meta) =>
            meta.name.toLowerCase().includes(q) ||
            (groupedModels.get(meta.key) ?? []).some(
              (m) => m.name.toLowerCase().includes(q) || m.modelName.toLowerCase().includes(q),
            ),
        )
      : all;
    const rank = (key: string) => {
      if (key === defaultProviderKey) return 0;
      const list = groupedModels.get(key) ?? [];
      if (list.length > 0 && list.every((m) => m.disabled)) return 2;
      return list.some((m) => m.credential.configured) ? 1 : 2;
    };
    return [...filtered].sort((a, b) => rank(a.key) - rank(b.key));
  }, [catalog, defaultProviderKey, groupedModels, search]);

  const providerMeta = (catalog?.providers ?? []).find((item) => item.key === selectedVendorKey);
  const isCustomGroup = Boolean(providerMeta?.custom) || selectedVendorKey === 'custom';

  const providerModels = useMemo(() => {
    const rank = (item: SettingsModelProfile) => {
      if (item.id === catalog?.defaultModel) return 0;
      if (item.disabled) return 3;
      return item.credential.configured ? 1 : 2;
    };
    return [...(groupedModels.get(selectedVendorKey) ?? [])].sort((a, b) => rank(a) - rank(b));
  }, [catalog, groupedModels, selectedVendorKey]);

  const primaryGlobalModel = useMemo(
    () =>
      providerModels.find((m) => m.scope === 'global' && m.credential.configured) ??
      providerModels.find((m) => m.scope === 'global'),
    [providerModels],
  );

  async function saveVendorSharedKey(): Promise<void> {
    if (!primaryGlobalModel || !sharedKey.trim() || busy || hostDown) return;
    if (typeof window === 'undefined' || !window.kapibala) return;
    setBusy(true);
    setNotice('');
    try {
      await withSettingsWatchdog(
        window.kapibala.settings.saveProfile({
          profile: profileToDraft(primaryGlobalModel),
          apiKey: sharedKey.trim(),
          editId: primaryGlobalModel.id,
        }),
        '保存密钥超时：Host 可能已断开，请重试。',
      );
      setSharedKey('');
      await reload?.();
      setNotice(`已更新 ${providerMeta?.name ?? '服务商'} 共享 API Key。`);
    } catch (error) {
      report?.(error instanceof Error ? error.message : '保存 API Key 失败。');
    } finally {
      setBusy(false);
    }
  }

  async function clearVendorKey(): Promise<void> {
    setSharedKey('');
    if (!onClearVendorKey || busy || hostDown) return;
    setBusy(true);
    try {
      await onClearVendorKey(selectedVendorKey);
      await reload?.();
      setNotice(`已清除 ${providerMeta?.name ?? '服务商'} 已存密钥。`);
    } catch (error) {
      report?.(error instanceof Error ? error.message : '清除密钥失败。');
    } finally {
      setBusy(false);
    }
  }

  async function probeModelConnection(item: SettingsModelProfile): Promise<void> {
    if (typeof window === 'undefined' || !window.kapibala) return;
    setTestingId(item.id);
    setTestState(undefined);
    try {
      const result = await withSettingsWatchdog(
        window.kapibala.settings.testProfile(item.id),
        '测试超时：Host 可能已断开，请重启应用后重试。',
        12_000,
      );
      setTestState({ id: item.id, ok: result.ok, message: result.message });
    } catch (error) {
      setTestState({
        id: item.id,
        ok: false,
        message: error instanceof Error ? error.message : '测试连接失败。',
      });
    } finally {
      setTestingId(undefined);
    }
  }

  async function toggleModelEnabled(item: SettingsModelProfile, enabled: boolean): Promise<void> {
    if (typeof window === 'undefined' || !window.kapibala) return;
    setBusy(true);
    try {
      await withSettingsWatchdog(
        window.kapibala.settings.setEnabled({ profileId: item.id, enabled }),
        '操作超时：Host 可能已断开。',
      );
      await reload?.();
      setNotice(enabled ? `已启用 ${item.name}。` : `已停用 ${item.name}。`);
    } catch (error) {
      report?.(error instanceof Error ? error.message : '更新模型启停状态失败。');
    } finally {
      setBusy(false);
    }
  }

  async function deleteModelProfile(item: SettingsModelProfile): Promise<void> {
    if (typeof window === 'undefined' || !window.kapibala) return;
    setBusy(true);
    try {
      await withSettingsWatchdog(
        window.kapibala.settings.deleteProfile(item.id),
        '删除模型超时：Host 可能已断开。',
      );
      await reload?.();
      setNotice(
        item.builtin ? `已停用 ${item.name}（已存密钥保留）。` : `已删除自定义模型 ${item.name}。`,
      );
    } catch (error) {
      report?.(error instanceof Error ? error.message : '删除模型失败。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="kpbl-settings-stack">
      {notice ? (
        <output className="kpbl-settings-banner" data-tone="success">
          <span>{notice}</span>
        </output>
      ) : null}

      <div className="kpbl-providers-toolbar">
        <SearchField
          aria-label="搜索提供商或模型"
          placeholder="搜索提供商或模型…"
          value={search}
          containerClassName="kpbl-providers-search"
          onValueChange={setSearch}
        />
        <Button
          variant="solid"
          size="sm"
          leadingIcon="plus"
          disabled={hostDown}
          onClick={() => {
            setEditingModel(undefined);
            setModalOpen(true);
          }}
        >
          新增自定义模型
        </Button>
      </div>

      <div className="kpbl-providers-grid">
        <nav aria-label="服务商列表" className="kpbl-vendor-list">
          {visibleProviders.map((meta) => {
            const models = groupedModels.get(meta.key) ?? [];
            const configured = models.some((m) => m.credential.configured);
            return (
              <button
                key={meta.key}
                type="button"
                aria-pressed={selectedVendorKey === meta.key}
                className="kpbl-vendor-item"
                onClick={() => {
                  setSelectedVendorKey(meta.key);
                  setSharedKey('');
                  setTestState(undefined);
                }}
              >
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{meta.name}</span>
                  {meta.custom ? <Badge>自定义</Badge> : null}
                </span>
                <StatusDot
                  status={configured ? 'success' : 'offline'}
                  label={configured ? '已配置密钥' : '未配置密钥'}
                />
              </button>
            );
          })}
          {visibleProviders.length === 0 ? (
            <p className="kpbl-field-hint p-3 text-center">
              {catalog ? '没有匹配的提供商或模型' : '正在加载提供商与模型目录…'}
            </p>
          ) : null}
        </nav>

        <ProviderVendorDetail
          vendorName={providerMeta?.name ?? '服务商'}
          vendorDescription={providerMeta?.description}
          defaultModelId={catalog?.defaultModel}
          primaryGlobalModel={primaryGlobalModel}
          providerModels={providerModels}
          sharedKey={sharedKey}
          canClearSavedKey={Boolean(onClearVendorKey)}
          busy={busy}
          hostDown={hostDown}
          testingId={testingId}
          testState={testState}
          onChangeSharedKey={setSharedKey}
          onSaveSharedKey={() => void saveVendorSharedKey()}
          onClearSharedKey={() => void clearVendorKey()}
          onTestModel={(item) => void probeModelConnection(item)}
          onEditModel={(item) => {
            setEditingModel(item);
            setModalOpen(true);
          }}
          onDeleteModel={(item) => void deleteModelProfile(item)}
          onToggleModel={(item, enabled) => void toggleModelEnabled(item, enabled)}
        />
      </div>

      <ProviderModelModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        editingModel={editingModel}
        defaultVendorName={
          isCustomGroup && selectedVendorKey !== 'custom' ? (providerMeta?.name ?? '') : ''
        }
        isCustomGroup={isCustomGroup}
        hostDown={hostDown}
        report={report}
        onSaved={async (savedProfile, noticeText) => {
          setSelectedVendorKey(savedProfile.providerKey);
          await reload?.();
          setNotice(noticeText);
        }}
      />
    </div>
  );
}
