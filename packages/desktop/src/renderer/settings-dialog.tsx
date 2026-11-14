import { Button, InlineCopyText, Input, Select, SensitiveInput, Switch } from '@cloudflare/kumo';
import { Dialog } from '@cloudflare/kumo/primitives/dialog';
import { Tabs } from '@cloudflare/kumo/primitives/tabs';
import {
  ArchiveIcon,
  PackageIcon,
  PaletteIcon,
  PlugsConnectedIcon,
  PulseIcon,
  ShuffleIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Output, ProfileDraft, Workspace } from '../shared/contracts.js';
import type { SessionTarget } from './session-actions.js';

type Catalog = Output<'settings.read'>;
type Model = Catalog['profiles'][number];
type McpCatalog = Output<'resources.readMcp'>;
type McpServerView = McpCatalog['servers'][number];
type SkillsCatalog = Output<'resources.readSkills'>;
/** MCP 编辑表单的草稿形态；args 以空白分隔输入，提交时按空白切分。 */
type McpFormDraft = {
  editName?: string;
  name: string;
  type: 'stdio' | 'http';
  command: string;
  args: string;
  url: string;
  /** 快照未提供未脱敏回填面（目标串内嵌密钥）时置位：传输字段锁定，只允许改名。 */
  keepTransport?: boolean;
};
/** 左导航只负责切换内容；诊断与产品设置同级但独立，避免版本信息混进日常配置。 */
const SETTINGS_TABS = [
  {
    value: 'models',
    label: '模型与服务商',
    icon: PlugsConnectedIcon,
    subtitle: '添加模型、更新凭证；与 CLI 共用同一份全局配置。',
  },
  {
    value: 'routing',
    label: '默认模型与路由',
    icon: ShuffleIcon,
    subtitle: '为新建会话指定默认模型和各角色模型。',
  },
  {
    value: 'resources',
    label: '资源管理',
    icon: PackageIcon,
    subtitle: 'MCP 服务器与技能的清单、启停与诊断；管理操作对新建会话生效。',
  },
  {
    value: 'appearance',
    label: '外观与应用',
    icon: PaletteIcon,
    subtitle: '主题设置适用于此客户端。',
  },
  {
    value: 'archived',
    label: '会话归档',
    icon: ArchiveIcon,
    subtitle: '已归档的对话不在侧栏显示；可以恢复到列表，也可以永久删除。',
  },
  {
    value: 'diagnostics',
    label: '诊断',
    icon: PulseIcon,
    subtitle: '版本、运行环境与退出入口。',
  },
] as const;
function draftOf(model: Model): ProfileDraft {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    modelName: model.modelName,
    baseURL: model.baseURL,
    apiKeyEnv: model.apiKeyEnv,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    supportsThinking: model.supportsThinking,
  };
}
/** 新建自定义模型的最小草稿：只要求端点与模型名，其余走默认协议与上下文预算。 */
function blankCustomDraft(): ProfileDraft {
  return {
    id: `custom-${crypto.randomUUID().slice(0, 8)}`,
    name: '',
    provider: 'openai-compatible',
    modelName: '',
    baseURL: '',
    apiKeyEnv: 'CUSTOM_API_KEY',
    contextWindow: 32000,
  };
}
/** 设置领域组合：Kumo 提供表单、敏感输入、过滤和焦点管理；保存即写本地配置，不经过预览态。 */
export function SettingsDialog({
  open,
  onOpenChange,
  catalog,
  reload,
  report,
  spaces = [],
  workspaceId,
  archiveRevision = 0,
  onArchivedChanged,
  onRequestDelete,
  hostDown = false,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  catalog?: Catalog;
  reload(): Promise<void>;
  report(message: string): void;
  /** 已登记空间；归档页按空间分组读取，未信任空间不参与（与侧栏列表同一准入）。 */
  spaces?: readonly Workspace[];
  /** 资源管理读取上下文；MCP 项目视图与技能目录都按该空间的信任投影。 */
  workspaceId?: string;
  /** 归档集合的变更代数：外部归档/删除后重新拉取，避免展示过期行。 */
  archiveRevision?: number;
  /** 恢复成功后通知外部刷新侧栏列表。 */
  onArchivedChanged?(): void;
  /** 删除不可逆，统一交给外层二次确认弹窗执行，避免设置页内再叠一层对话框。 */
  onRequestDelete?(target: SessionTarget): void;
  /** 执行 Host 断开或被阻断时，读取与保存都无法完成；表单明示原因而不是呈现空表单。 */
  hostDown?: boolean;
}) {
  const [info, setInfo] = useState<Output<'app.getInfo'>>();
  const [tab, setTab] = useState('models');
  const [resMcp, setResMcp] = useState<McpCatalog>();
  const [resSkills, setResSkills] = useState<SkillsCatalog>();
  const [resDraft, setResDraft] = useState<McpFormDraft>();
  const [resConfirmDelete, setResConfirmDelete] = useState<string>();
  const [resBusy, setResBusy] = useState(false);
  /** 资源面板本地错误条：模态弹窗会遮住全局状态栏，校验失败的原因必须在面板内可见。 */
  const [resError, setResError] = useState('');
  /** 资源管理读函数：MCP 与 Skills 并行拉取；workspaceId 未定时不请求。 */
  const loadResources = useCallback(() => {
    if (!workspaceId) return;
    void window.kapibala.resources
      .readMcp(workspaceId)
      .then(setResMcp)
      .catch((error) => report(error.message));
    void window.kapibala.resources
      .readSkills(workspaceId)
      .then(setResSkills)
      .catch((error) => report(error.message));
  }, [workspaceId, report]);
  useEffect(() => {
    if (!open || tab !== 'resources') return;
    loadResources();
  }, [open, tab, loadResources]);
  /** 资源写操作统一入口：串行防抖 + 回读 + 失败上报，不静默吞错。 */
  function resourceAction(action: (activeWorkspaceId: string) => Promise<unknown>): void {
    if (!workspaceId || resBusy) return;
    setResBusy(true);
    setResError('');
    void action(workspaceId)
      .then(() => loadResources())
      .catch((error) => {
        setResError(error.message);
        report(error.message);
      })
      .finally(() => setResBusy(false));
  }
  /** 左侧选中的厂商分组键（providers[].key）；详情面板展示该厂商的模型与编辑表单。 */
  const [providerSel, setProviderSel] = useState('custom');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Model>();
  const [draft, setDraft] = useState<ProfileDraft>();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  /** 端点探测出的模型 id 清单；仅在当前编辑会话内有效，不落盘。 */
  const [models, setModels] = useState<string[]>();
  const [fetching, setFetching] = useState(false);
  const [fetchStatus, setFetchStatus] = useState('');
  /** 探测失败或列表为空时退回手填模型名，避免被一次网络错误卡死。 */
  const [manualModel, setManualModel] = useState(false);
  const [notice, setNotice] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('light');
  const initialized = useRef(false);
  useEffect(() => {
    if (!open) {
      initialized.current = false;
      setKey('');
      setNotice('');
      setModels(undefined);
      setFetchStatus('');
      setManualModel(false);
    } else if (!initialized.current && catalog) {
      initialized.current = true;
      void window.kapibala.app
        .getInfo()
        .then(setInfo)
        .catch((error) => report(error.message));
      void window.kapibala.preferences
        .read()
        .then((prefs) => setTheme(prefs.theme))
        .catch((error) => report(error.message));
      if (catalog) {
        const model = catalog.profiles.find((item) => item.id === catalog.defaultModel);
        setSelected(model);
        setDraft(model && draftOf(model));
        setProviderSel(model?.providerKey ?? 'custom');
      }
    }
  }, [open, catalog, report]);
  /** 归档页数据按空间聚合；一次读取失败整体报错，不展示半份分组。 */
  const [archive, setArchive] = useState<{
    loading: boolean;
    error?: string;
    groups: { space: Workspace; list: Output<'session.archived'> }[];
  }>({ loading: false, groups: [] });
  /** 正在恢复的会话 id：只锁该行，其余行仍可操作。 */
  const [restoring, setRestoring] = useState<string>();
  /** 恢复成功后自增，触发归档页重新读取；与外部 archiveRevision 分开记，避免互相覆盖。 */
  const [reloadTick, setReloadTick] = useState(0);
  useEffect(() => {
    if (!open || tab !== 'archived') return;
    // archiveRevision 与 reloadTick 只作失效信号：外部归档/删除、本地恢复都要求重读本页。
    void archiveRevision;
    void reloadTick;
    let cancelled = false;
    const groups: { space: Workspace; list: Output<'session.archived'> }[] = [];
    setArchive({ loading: true, groups: [] });
    void (async () => {
      try {
        // 顺序读取：与侧栏搜索同一策略，避免多个空间同时占满 Host 请求预算。
        for (const space of spaces) {
          if (!space.trusted) continue;
          groups.push({
            space,
            list: await window.kapibala.session.archived(space.id),
          });
          if (cancelled) return;
        }
        if (!cancelled) setArchive({ loading: false, groups });
      } catch (error) {
        if (cancelled) return;
        setArchive({
          loading: false,
          groups: [],
          error: error instanceof Error ? error.message : '读取归档失败，请重试。',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, tab, archiveRevision, spaces, reloadTick]);
  /** 恢复只追加 archive_state(false)，不移动文件；成功后刷新本页并要求外层刷新侧栏。 */
  async function restoreArchived(space: Workspace, conversationId: string) {
    setRestoring(conversationId);
    try {
      await window.kapibala.session.restore({
        workspaceId: space.id,
        conversationId,
      });
      setReloadTick((value) => value + 1);
      onArchivedChanged?.();
    } catch (error) {
      report(error instanceof Error ? error.message : '恢复失败，请重试。');
    } finally {
      setRestoring(undefined);
    }
  }
  const change = <K extends keyof ProfileDraft>(field: K, value: ProfileDraft[K]) =>
    setDraft((current) => current && { ...current, [field]: value });
  /** 目录按厂商分组；分组键来自 host 投影（与 CLI /model 菜单同一套 detectProviderFamily 推断）。 */
  const groupedModels = useMemo(() => {
    const map = new Map<string, Model[]>();
    for (const item of catalog?.profiles ?? []) {
      const list = map.get(item.providerKey);
      if (list) list.push(item);
      else map.set(item.providerKey, [item]);
    }
    return map;
  }, [catalog]);
  /** 搜索同时命中厂商名与模型名/显示名；空查询返回完整目录。 */
  const visibleProviders = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return catalog?.providers ?? [];
    return (catalog?.providers ?? []).filter(
      (meta) =>
        meta.name.toLowerCase().includes(query) ||
        (groupedModels.get(meta.key) ?? []).some(
          (item) =>
            item.name.toLowerCase().includes(query) || item.modelName.toLowerCase().includes(query),
        ),
    );
  }, [catalog, groupedModels, search]);
  const providerModels = groupedModels.get(providerSel) ?? [];
  const providerMeta = (catalog?.providers ?? []).find((item) => item.key === providerSel);
  /** 探测状态属于「正在编辑的端点」，切换厂商或模型时一并清空，避免串到别的表单。 */
  function resetProbe() {
    setModels(undefined);
    setFetchStatus('');
    setManualModel(false);
  }
  /** 切换厂商时优先带入已配置密钥的模型；自定义分组为空时直接进入新建表单。 */
  function selectProvider(key: string) {
    setProviderSel(key);
    const list = groupedModels.get(key) ?? [];
    const model = list.find((item) => item.credential.configured) ?? list[0];
    setSelected(model);
    setDraft(model ? draftOf(model) : key === 'custom' ? blankCustomDraft() : undefined);
    setKey('');
    resetProbe();
  }
  /** 新增自定义模型：归入「自定义端点 / 其它」分组，只需要端点、密钥和模型名。 */
  function newCustomModel() {
    setProviderSel('custom');
    setSelected(undefined);
    setDraft(blankCustomDraft());
    setKey('');
    resetProbe();
  }
  /** 端点探测失败按固定错误码翻译，避免把 host 的英文码直接甩给用户。 */
  function listErrorText(error: unknown): string {
    const code = error instanceof Error ? error.message : '';
    if (code === 'MODEL_LIST_TIMEOUT') return '获取模型列表超时，请检查网络或 Base URL。';
    if (code === 'MODEL_LIST_UNAVAILABLE') return '无法获取模型列表：请检查 Base URL 与 API Key。';
    if (code === 'MODEL_LIST_INVALID') return '端点返回的不是模型列表，请手动填写模型名。';
    return code || '获取模型列表失败，请手动填写模型名。';
  }
  /** 按当前 Base URL 拉一次模型目录；密钥只用于这次请求，留空则复用已存凭证。 */
  async function fetchModels() {
    if (!draft?.baseURL.trim()) {
      setFetchStatus('请先填写 Base URL。');
      return;
    }
    setFetching(true);
    setFetchStatus('');
    try {
      const result = await window.kapibala.settings.listModels({
        baseURL: draft.baseURL.trim(),
        apiKey: key.trim() || undefined,
        profileId: selected?.id,
      });
      setModels(result.models);
      setManualModel(result.models.length === 0);
      setFetchStatus(
        result.models.length > 0
          ? `已获取 ${result.models.length} 个模型。`
          : '端点未返回模型，请手动填写模型名。',
      );
      // 只在用户还没填模型名时自动选中首个，避免把已保存的模型名悄悄改掉。
      if (result.models.length > 0 && !draft.modelName.trim())
        change('modelName', result.models[0]);
    } catch (error) {
      setModels(undefined);
      setManualModel(true);
      setFetchStatus(listErrorText(error));
    } finally {
      setFetching(false);
    }
  }
  /**
   * 保存就是一次落盘：配置和密钥一起写进本地 settings.json，不再生成预览令牌，
   * 也不再需要二次确认。端点变更时 host 拒绝原地改写，页面换新 id 另存，旧配置保持可用。
   */
  async function save() {
    if (!draft) return;
    if (providerSel === 'custom' && (!draft.baseURL.trim() || !draft.modelName.trim())) {
      setNotice('请填写 Base URL 与模型名后保存。');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const target: ProfileDraft = {
        ...draft,
        name: draft.name.trim() || draft.modelName.trim(),
        modelName: draft.modelName.trim(),
        baseURL: draft.baseURL.trim(),
      };
      const pendingKey = key.trim() || undefined;
      let saved: Output<'settings.saveProfile'>;
      let savedAsNew = false;
      try {
        saved = await window.kapibala.settings.saveProfile({
          profile: target,
          apiKey: pendingKey,
          editId: selected?.id,
        });
      } catch (error) {
        // 自定义端点改了地址或协议时 host 拒绝原地改写；换新 id 另存，旧配置保持可用。
        if (
          error instanceof Error &&
          error.message === 'SAVE_AS_NEW_PROFILE' &&
          providerSel === 'custom' &&
          selected
        ) {
          savedAsNew = true;
          saved = await window.kapibala.settings.saveProfile({
            profile: {
              ...target,
              id: `custom-${crypto.randomUUID().slice(0, 8)}`,
            },
            apiKey: pendingKey,
          });
        } else {
          throw error;
        }
      }
      setKey('');
      // 以 host 回读的落盘结果为准，避免页面上留着未清洗的旧值。
      setSelected(saved.profile);
      setDraft(draftOf(saved.profile));
      setProviderSel(saved.profile.providerKey);
      await reload();
      setNotice(savedAsNew ? '端点已变更，已另存为新模型。' : '已保存到本地配置。');
    } catch (error) {
      if (error instanceof Error && error.message === 'CONFIG_REQUIRED') {
        setNotice('该端点还没有可用密钥，请填写 API Key 后保存。');
      } else {
        report(error instanceof Error ? error.message : '配置保存失败，请检查输入后重试。');
      }
    } finally {
      setBusy(false);
    }
  }
  const builtin = Boolean(selected?.builtin && selected.id === draft?.id);
  const active = SETTINGS_TABS.find((item) => item.value === tab) ?? SETTINGS_TABS[0];
  return (
    <>
      <Dialog.Root
        open={open}
        onOpenChange={(isOpen) => {
          if (!isOpen && !busy) onOpenChange(false);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 bg-kumo-contrast/20" />
          <Dialog.Popup className="kapibala-settings-popup fixed inset-0 text-kumo-default">
            <Tabs.Root
              orientation="vertical"
              value={tab}
              onValueChange={(value) => setTab(String(value))}
              className="kapibala-settings"
            >
              <aside className="kapibala-settings-rail">
                <div className="kapibala-settings-rail-top">
                  <Dialog.Title className="kapibala-settings-rail-title">设置</Dialog.Title>
                  <Dialog.Close
                    render={
                      <Button
                        className="kapibala-action"
                        variant="ghost"
                        shape="square"
                        size="base"
                        aria-label="关闭设置"
                      />
                    }
                  >
                    <XIcon size={18} />
                  </Dialog.Close>
                </div>
                <Tabs.List className="kapibala-settings-nav" aria-label="设置分类">
                  {SETTINGS_TABS.map((item) => (
                    <Tabs.Tab
                      key={item.value}
                      value={item.value}
                      className="kapibala-settings-nav-item"
                    >
                      <span className="kapibala-settings-nav-icon" aria-hidden="true">
                        <item.icon size={16} />
                      </span>
                      {item.label}
                    </Tabs.Tab>
                  ))}
                </Tabs.List>
                <div className="kapibala-settings-rail-footer">
                  <span className="text-xs text-kumo-subtle">
                    {info ? `Kapibala ${info.version}` : 'Kapibala'}
                  </span>
                </div>
              </aside>
              <div className="kapibala-settings-content">
                <header className="kapibala-settings-header">
                  <span className="kapibala-settings-page-icon" aria-hidden="true">
                    <active.icon size={19} />
                  </span>
                  <div className="min-w-0">
                    <h2 className="kapibala-settings-title">{active.label}</h2>
                    <Dialog.Description className="kapibala-settings-subtitle">
                      {active.subtitle}
                    </Dialog.Description>
                  </div>
                </header>
                {hostDown && (
                  <div
                    role="alert"
                    className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-kumo-recessed px-4 py-3 text-sm"
                  >
                    <span className="min-w-0 flex-1">
                      执行 Host 未连接，无法读取或保存模型配置。请先核查残留进程并重新连接。
                    </span>
                    <Button
                      className="kapibala-action"
                      variant="secondary"
                      onClick={() =>
                        void window.kapibala.app.reconnect().catch((error: unknown) => {
                          report(error instanceof Error ? error.message : '重新连接请求失败。');
                        })
                      }
                    >
                      重新连接
                    </Button>
                  </div>
                )}
                {/* 保存/校验反馈固定在面板上方，长表单滚动后依然可见。 */}
                {notice && (
                  <output className="kapibala-settings-notice block text-sm">{notice}</output>
                )}
                <Tabs.Panel value="models" className="kapibala-settings-panel kapibala-models">
                  <div className="kapibala-models-toolbar">
                    <Input
                      aria-label="搜索提供商或模型"
                      placeholder="搜索提供商或模型…"
                      value={search}
                      onValueChange={setSearch}
                    />
                    <Button className="kapibala-action" variant="primary" onClick={newCustomModel}>
                      新增自定义模型
                    </Button>
                  </div>
                  <div className="kapibala-models-body">
                    <div className="kapibala-models-list">
                      {visibleProviders.map((meta) => {
                        const models = groupedModels.get(meta.key) ?? [];
                        const configured = models.some((item) => item.credential.configured);
                        return (
                          <Button
                            key={meta.key}
                            variant="ghost"
                            aria-pressed={providerSel === meta.key}
                            className="kapibala-models-item"
                            onClick={() => selectProvider(meta.key)}
                          >
                            <span className="kapibala-models-item-badge" aria-hidden="true">
                              {meta.name.slice(0, 1)}
                            </span>
                            <span className="kapibala-models-item-name">{meta.name}</span>
                            {meta.key === 'custom' && (
                              <span className="kapibala-models-item-tag">自定义</span>
                            )}
                            <span
                              className={`kapibala-models-dot${configured ? ' is-on' : ''}`}
                              role="img"
                              aria-label={configured ? '已配置密钥' : '未配置密钥'}
                            />
                          </Button>
                        );
                      })}
                      {visibleProviders.length === 0 && (
                        <p className="kapibala-models-empty">没有匹配的提供商或模型</p>
                      )}
                    </div>
                    <div className="kapibala-models-detail">
                      <div className="kapibala-models-detail-head">
                        <div className="min-w-0">
                          <h3 className="kapibala-models-detail-title">
                            {providerMeta?.name ?? '模型'}
                          </h3>
                          <p className="kapibala-models-detail-desc">{providerMeta?.description}</p>
                        </div>
                        <span
                          className={`kapibala-models-state${
                            providerModels.some((item) => item.credential.configured)
                              ? ' is-on'
                              : ''
                          }`}
                        >
                          {providerModels.some((item) => item.credential.configured)
                            ? '已配置'
                            : '未配置'}
                        </span>
                      </div>
                      {providerModels.length > 0 && (
                        <div className="kapibala-models-chips">
                          {providerModels.map((item) => (
                            <Button
                              key={item.id}
                              variant="ghost"
                              aria-pressed={selected?.id === item.id}
                              className="kapibala-models-chip"
                              onClick={() => {
                                setSelected(item);
                                setDraft(draftOf(item));
                                setKey('');
                                resetProbe();
                              }}
                            >
                              <span className="min-w-0 truncate">{item.name}</span>
                              {!item.credential.configured && (
                                <em className="kapibala-models-chip-tag">未配置密钥</em>
                              )}
                              {catalog?.defaultModel === item.id && (
                                <em className="kapibala-models-chip-tag">默认</em>
                              )}
                            </Button>
                          ))}
                        </div>
                      )}
                      {draft && providerSel === 'custom' ? (
                        <div className="kapibala-models-form">
                          <Input
                            label="Base URL"
                            placeholder="https://api.example.com/v1"
                            value={draft.baseURL}
                            disabled={busy}
                            onChange={(event) => change('baseURL', event.target.value)}
                          />
                          <SensitiveInput
                            label="API Key"
                            value={key}
                            onValueChange={setKey}
                            disabled={busy}
                            autoComplete="off"
                            description="已有密钥不会回显；留空则复用该分组的已存凭证。新密钥存放在全局 settings.json 中，并非系统钥匙串。"
                          />
                          <div className="kapibala-models-probe">
                            <Button
                              className="kapibala-action"
                              variant="secondary"
                              disabled={busy || fetching}
                              onClick={() => void fetchModels()}
                            >
                              {fetching ? '获取中…' : '获取模型列表'}
                            </Button>
                            {fetchStatus && (
                              <span className="kapibala-models-hint">{fetchStatus}</span>
                            )}
                          </div>
                          {models && models.length > 0 && !manualModel ? (
                            <Select
                              label="模型"
                              items={Object.fromEntries(models.map((item) => [item, item]))}
                              value={draft.modelName || null}
                              disabled={busy}
                              onValueChange={(value) => value && change('modelName', String(value))}
                            />
                          ) : (
                            <Input
                              label="模型名"
                              placeholder="deepseek-chat"
                              value={draft.modelName}
                              disabled={busy}
                              onChange={(event) => change('modelName', event.target.value)}
                            />
                          )}
                          {models && models.length > 0 && (
                            <Button
                              className="kapibala-action"
                              variant="ghost"
                              onClick={() => setManualModel(!manualModel)}
                            >
                              {manualModel ? '从列表选择模型' : '手动填写模型名'}
                            </Button>
                          )}
                          <details className="kapibala-models-advanced">
                            <summary>高级设置</summary>
                            <div className="kapibala-models-advanced-body">
                              <Input
                                label="显示名"
                                placeholder="留空使用模型名"
                                value={draft.name}
                                disabled={busy}
                                onChange={(event) => change('name', event.target.value)}
                              />
                              <Select
                                label="协议"
                                items={{
                                  'openai-compatible': 'Chat Completions',
                                  'openai-responses': 'Responses',
                                  anthropic: 'Anthropic Messages',
                                }}
                                value={draft.provider}
                                disabled={busy}
                                onValueChange={(value) =>
                                  value && change('provider', value as ProfileDraft['provider'])
                                }
                              />
                              <Input
                                label="上下文窗口"
                                type="number"
                                value={draft.contextWindow ?? ''}
                                disabled={busy}
                                onChange={(event) =>
                                  change(
                                    'contextWindow',
                                    event.target.value ? Number(event.target.value) : undefined,
                                  )
                                }
                              />
                              <Input
                                label="最大输出 Token"
                                type="number"
                                value={draft.maxOutputTokens ?? ''}
                                disabled={busy}
                                onChange={(event) =>
                                  change(
                                    'maxOutputTokens',
                                    event.target.value ? Number(event.target.value) : undefined,
                                  )
                                }
                              />
                              <Switch
                                label="支持思考输出"
                                checked={draft.supportsThinking ?? false}
                                disabled={busy}
                                onCheckedChange={(checked) => change('supportsThinking', checked)}
                              />
                            </div>
                          </details>
                          <Button
                            className="kapibala-action"
                            disabled={busy}
                            onClick={() => void save()}
                          >
                            保存到本地
                          </Button>
                        </div>
                      ) : draft ? (
                        <div className="kapibala-models-form">
                          <SensitiveInput
                            label="新 API Key"
                            value={key}
                            onValueChange={setKey}
                            disabled={busy}
                            autoComplete="off"
                            description="同一厂商只需配置一次，组内模型共用。已有密钥不会回显；留空保留当前凭证。"
                          />
                          {selected && (
                            <p className="text-sm text-kumo-subtle">
                              {selected.credential.group} ·{' '}
                              {selected.credential.configured
                                ? `已配置（${selected.credential.source === 'env' || selected.credential.source === 'family-env' ? '环境变量' : '全局设置'}）`
                                : '尚未配置密钥'}
                            </p>
                          )}
                          <details className="kapibala-models-advanced">
                            <summary>高级设置</summary>
                            <div className="kapibala-models-advanced-body">
                              <Input
                                label="最大输出 Token"
                                type="number"
                                value={draft.maxOutputTokens ?? ''}
                                disabled={busy}
                                onChange={(event) =>
                                  change(
                                    'maxOutputTokens',
                                    event.target.value ? Number(event.target.value) : undefined,
                                  )
                                }
                              />
                              <Switch
                                label="支持思考输出"
                                checked={draft.supportsThinking ?? false}
                                disabled={busy}
                                onCheckedChange={(checked) => change('supportsThinking', checked)}
                              />
                              {builtin && (
                                <Button
                                  className="kapibala-action"
                                  variant="ghost"
                                  onClick={() => {
                                    change(
                                      'id',
                                      `${draft.id}-custom-${crypto.randomUUID().slice(0, 6)}`,
                                    );
                                  }}
                                >
                                  另存为自建 Profile
                                </Button>
                              )}
                            </div>
                          </details>
                          <Button
                            className="kapibala-action"
                            disabled={busy}
                            onClick={() => void save()}
                          >
                            保存到本地
                          </Button>
                        </div>
                      ) : null}
                      {!draft && providerModels.length === 0 && (
                        <p className="kapibala-models-empty">
                          该提供商暂无模型。点击右上角「新增自定义模型」创建，自定义端点会归入
                          「自定义端点 / 其它」分组。
                        </p>
                      )}
                    </div>
                  </div>
                </Tabs.Panel>
                <Tabs.Panel value="routing" className="kapibala-settings-panel space-y-4">
                  <Select
                    label="全局默认模型"
                    value={catalog?.defaultModel}
                    items={Object.fromEntries(
                      (catalog?.profiles ?? [])
                        .filter((item) => item.credential.configured)
                        .map((item) => [item.id, item.name]),
                    )}
                    onValueChange={(value) => {
                      if (value)
                        void window.kapibala.settings
                          .setDefault(String(value))
                          .then(reload)
                          .catch((error) => report(error.message));
                    }}
                  />
                  <p className="text-sm text-kumo-subtle">
                    新建或重新打开会话时生效。
                    {catalog?.projectOverride
                      ? '当前空间存在项目覆盖，请以空间内的生效配置为准。'
                      : '当前空间没有项目覆盖。'}
                  </p>
                  {(['planning', 'execution', 'fast', 'summary'] as const).map((route) => (
                    <Select
                      key={route}
                      label={`${{ planning: '规划', execution: '执行', fast: '快速', summary: '摘要' }[route]}角色`}
                      value={catalog?.routing[route] ?? '__default__'}
                      items={{
                        __default__: '使用默认模型',
                        ...Object.fromEntries(
                          (catalog?.profiles ?? [])
                            .filter((item) => item.credential.configured)
                            .map((item) => [item.id, item.name]),
                        ),
                      }}
                      onValueChange={(value) =>
                        void window.kapibala.settings
                          .setRouting({
                            role: route,
                            profileId: value === '__default__' ? undefined : String(value),
                          })
                          .then(reload)
                          .catch((error) => report(error.message))
                      }
                    />
                  ))}
                </Tabs.Panel>
                <Tabs.Panel value="resources" className="kapibala-settings-panel space-y-6">
                  {!workspaceId && (
                    <p className="text-sm text-kumo-subtle">暂无可用空间，无法读取资源清单。</p>
                  )}
                  {resError && (
                    <p role="alert" className="text-xs text-kumo-danger">
                      {resError}
                    </p>
                  )}
                  <section className="space-y-3" aria-label="MCP 服务器">
                    <h3 className="text-sm font-medium">MCP 服务器</h3>
                    <p className="text-sm text-kumo-subtle">
                      全局配置：~/.kapibala/mcp.json；项目级声明只读展示。
                      启停与增删对新建会话生效，运行中的会话不受影响。
                    </p>
                    {(resMcp?.servers ?? []).length === 0 && (
                      <p className="text-sm text-kumo-subtle">未配置任何 MCP 服务器。</p>
                    )}
                    {(resMcp?.servers ?? []).map((server: McpServerView) => (
                      <div
                        key={`${server.source}:${server.name}`}
                        className="space-y-1 rounded-lg border border-kumo-line p-3"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-medium">
                              {server.name}
                              <span className="ml-2 text-xs text-kumo-subtle">
                                {server.source === 'project'
                                  ? '项目级（只读）'
                                  : server.enabled
                                    ? '已启用'
                                    : '已禁用'}
                              </span>
                            </div>
                            <div className="truncate text-xs text-kumo-subtle">
                              {server.type === 'http' ? 'HTTP' : 'stdio'} ·{' '}
                              {server.target || '（无目标）'}
                            </div>
                          </div>
                          {server.source === 'global' && (
                            <div className="flex shrink-0 items-center gap-2">
                              <Switch
                                label={`启用 ${server.name}`}
                                checked={server.enabled}
                                disabled={resBusy}
                                onCheckedChange={(checked) =>
                                  resourceAction((activeWorkspaceId) =>
                                    window.kapibala.resources.toggleMcpServer({
                                      workspaceId: activeWorkspaceId,
                                      name: server.name,
                                      enabled: checked,
                                    }),
                                  )
                                }
                              />
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  setResDraft({
                                    editName: server.name,
                                    name: server.name,
                                    type: server.type === 'http' ? 'http' : 'stdio',
                                    // 回填必须用未脱敏的编辑面：target 是脱敏摘要
                                    //（command+args 合并、密钥成掩码），回写会损坏声明。
                                    command: server.edit?.command ?? '',
                                    args: server.edit?.args?.join(' ') ?? '',
                                    url: server.edit?.url ?? '',
                                    keepTransport: !server.edit,
                                  })
                                }
                              >
                                编辑
                              </Button>
                              {resConfirmDelete === server.name ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    setResConfirmDelete(undefined);
                                    resourceAction((activeWorkspaceId) =>
                                      window.kapibala.resources.deleteMcpServer({
                                        workspaceId: activeWorkspaceId,
                                        name: server.name,
                                      }),
                                    );
                                  }}
                                >
                                  确认删除
                                </Button>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setResConfirmDelete(server.name)}
                                >
                                  删除
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                        {server.hasSecretSurface && (
                          <p className="text-xs text-kumo-subtle">
                            该声明包含环境变量或请求头（值不在界面回显，编辑会保留原文）。
                          </p>
                        )}
                        {server.diagnostics.map((diagnostic) => (
                          <p
                            key={`${diagnostic.code}:${diagnostic.message}`}
                            className="text-xs text-kumo-subtle"
                          >
                            [{diagnostic.code}] {diagnostic.message}
                          </p>
                        ))}
                      </div>
                    ))}
                    {resMcp?.diagnostics.map((diagnostic) => (
                      <p
                        key={`${diagnostic.code}:${diagnostic.message}`}
                        className="text-xs text-kumo-subtle"
                      >
                        [{diagnostic.code}] {diagnostic.message}
                      </p>
                    ))}
                    {resDraft && (
                      <div className="space-y-3 rounded-lg border border-kumo-line p-3">
                        <Input
                          label="名称"
                          value={resDraft.name}
                          onValueChange={(value) => setResDraft({ ...resDraft, name: value })}
                        />
                        <Select
                          label="传输类型"
                          value={resDraft.type}
                          items={{
                            stdio: 'stdio（本地命令）',
                            http: 'HTTP（远程端点）',
                          }}
                          disabled={resDraft.keepTransport}
                          onValueChange={(value) =>
                            setResDraft({
                              ...resDraft,
                              type: value as 'stdio' | 'http',
                            })
                          }
                        />
                        {resDraft.type === 'stdio' ? (
                          <>
                            <Input
                              label="启动命令"
                              value={resDraft.command}
                              disabled={resDraft.keepTransport}
                              onValueChange={(value) =>
                                setResDraft({ ...resDraft, command: value })
                              }
                            />
                            <Input
                              label="命令行参数（空白分隔，可选）"
                              value={resDraft.args}
                              disabled={resDraft.keepTransport}
                              onValueChange={(value) => setResDraft({ ...resDraft, args: value })}
                            />
                          </>
                        ) : (
                          <Input
                            label="端点 URL"
                            value={resDraft.url}
                            disabled={resDraft.keepTransport}
                            onValueChange={(value) => setResDraft({ ...resDraft, url: value })}
                          />
                        )}
                        <p className="text-xs text-kumo-subtle">
                          {resDraft.keepTransport
                            ? '该声明包含敏感内容，面板编辑只保留传输配置原文（可改名）；如需修改传输配置请手工编辑 ~/.kapibala/mcp.json。'
                            : '环境变量与请求头请在 mcp.json 中手工维护；编辑会保留这些字段原文。'}
                        </p>
                        <div className="flex gap-2">
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={resBusy || !resDraft.name.trim()}
                            onClick={() => {
                              // 提交前友好预校验：宿主层事务仍会全量兜底，此处只拦截最常见的必填缺失。
                              // keepTransport 时传输字段锁定为空，必填校验交由服务端保留原文。
                              if (!resDraft.keepTransport) {
                                if (resDraft.type === 'http' && !resDraft.url.trim()) {
                                  setResError('HTTP 服务器必须提供端点 URL');
                                  return;
                                }
                                if (resDraft.type === 'stdio' && !resDraft.command.trim()) {
                                  setResError('stdio 服务器必须提供启动命令');
                                  return;
                                }
                              }
                              const draft = {
                                name: resDraft.name.trim(),
                                type: resDraft.type,
                                ...(resDraft.keepTransport
                                  ? {}
                                  : resDraft.type === 'stdio'
                                    ? { command: resDraft.command.trim() }
                                    : { url: resDraft.url.trim() }),
                                ...(resDraft.type === 'stdio' &&
                                !resDraft.keepTransport &&
                                resDraft.args.trim()
                                  ? { args: resDraft.args.trim().split(/\s+/) }
                                  : {}),
                              };
                              resourceAction((activeWorkspaceId) =>
                                window.kapibala.resources
                                  .saveMcpServer({
                                    workspaceId: activeWorkspaceId,
                                    editName: resDraft.editName,
                                    ...(resDraft.keepTransport ? { keepTransport: true } : {}),
                                    draft,
                                  })
                                  .then(() => setResDraft(undefined)),
                              );
                            }}
                          >
                            保存
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setResDraft(undefined)}>
                            取消
                          </Button>
                        </div>
                      </div>
                    )}
                    {!resDraft && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!workspaceId}
                        onClick={() =>
                          setResDraft({
                            name: '',
                            type: 'stdio',
                            command: '',
                            args: '',
                            url: '',
                          })
                        }
                      >
                        新增服务器
                      </Button>
                    )}
                  </section>
                  <section className="space-y-3" aria-label="技能">
                    <h3 className="text-sm font-medium">技能</h3>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium">启用技能功能</div>
                        <p className="text-xs text-kumo-subtle">
                          关闭后新建会话不注册技能工具；运行中的会话不变。
                        </p>
                      </div>
                      <Switch
                        label="启用技能功能"
                        checked={resSkills?.enabled ?? true}
                        disabled={resBusy}
                        onCheckedChange={(checked) =>
                          resourceAction((activeWorkspaceId) =>
                            window.kapibala.resources.setSkillsEnabled({
                              workspaceId: activeWorkspaceId,
                              enabled: checked,
                            }),
                          )
                        }
                      />
                    </div>
                    {(resSkills?.skills ?? []).map((skill) => (
                      <div
                        key={skill.name}
                        className="flex items-center justify-between gap-3 rounded-lg border border-kumo-line p-3"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium">
                            {skill.name}
                            <span className="ml-2 text-xs text-kumo-subtle">
                              [{skill.scope}]
                              {skill.disabled ? ' · 已禁用' : skill.available ? '' : ' · 不可用'}
                            </span>
                          </div>
                          <div className="truncate text-xs text-kumo-subtle">
                            {skill.description || skill.filePath || '目录中暂无同名技能'}
                          </div>
                          {!skill.available && (
                            <div className="text-xs text-kumo-subtle">
                              原因：{skill.unavailableReason ?? '未知'}
                            </div>
                          )}
                        </div>
                        <Switch
                          label={`启用 ${skill.name}`}
                          checked={!skill.disabled}
                          disabled={resBusy}
                          onCheckedChange={(checked) =>
                            resourceAction((activeWorkspaceId) =>
                              window.kapibala.resources.setSkillDisabled({
                                workspaceId: activeWorkspaceId,
                                name: skill.name,
                                disabled: !checked,
                              }),
                            )
                          }
                        />
                      </div>
                    ))}
                    {resSkills?.diagnostics.map((diagnostic) => (
                      <p
                        key={`${diagnostic.code}:${diagnostic.path}:${diagnostic.message}`}
                        className="text-xs text-kumo-subtle"
                      >
                        [{diagnostic.code}] {diagnostic.path} · {diagnostic.message}
                      </p>
                    ))}
                  </section>
                </Tabs.Panel>
                <Tabs.Panel value="appearance" className="kapibala-settings-panel space-y-4">
                  <Select
                    label="主题"
                    items={{ light: '浅色', dark: '深色', system: '跟随系统' }}
                    value={theme}
                    onValueChange={(value) => {
                      if (value) {
                        const next = value as typeof theme;
                        setTheme(next);
                        void window.kapibala.preferences
                          .update(next)
                          .catch((error) => report(error.message));
                      }
                    }}
                  />
                </Tabs.Panel>
                <Tabs.Panel value="archived" className="kapibala-settings-panel space-y-4">
                  {archive.loading && <p className="text-sm text-kumo-subtle">正在读取归档…</p>}
                  {archive.error && (
                    <p role="alert" className="text-sm text-kumo-danger">
                      {archive.error}
                    </p>
                  )}
                  {!archive.loading &&
                    !archive.error &&
                    archive.groups.every((group) => group.list.total === 0) && (
                      <p className="text-sm text-kumo-subtle">
                        没有已归档的对话。归档不会删除历史文件，之后可以在这里恢复。
                      </p>
                    )}
                  {archive.groups
                    .filter((group) => group.list.total > 0)
                    .map(({ space, list }) => (
                      <section key={space.id} className="space-y-2">
                        <h3 className="text-sm font-medium">{space.name}</h3>
                        <ul className="space-y-1">
                          {list.items.map((item) => (
                            <li
                              key={item.conversationId}
                              className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-kumo-tint"
                            >
                              <span className="min-w-0 flex-1 truncate">
                                {item.title || '未命名对话'}
                              </span>
                              <span className="shrink-0 text-xs text-kumo-subtle">
                                {item.messageCount} 条 ·{' '}
                                {new Date(item.lastActivityAt).toLocaleDateString()}
                              </span>
                              <Button
                                className="kapibala-action"
                                variant="secondary"
                                size="sm"
                                disabled={restoring === item.conversationId}
                                onClick={() => void restoreArchived(space, item.conversationId)}
                              >
                                恢复
                              </Button>
                              <Button
                                className="kapibala-action text-kumo-danger"
                                variant="ghost"
                                size="sm"
                                disabled={restoring === item.conversationId}
                                onClick={() =>
                                  onRequestDelete?.({
                                    workspaceId: space.id,
                                    conversationId: item.conversationId,
                                    title: item.title,
                                  })
                                }
                              >
                                删除
                              </Button>
                            </li>
                          ))}
                        </ul>
                        {list.total > list.items.length && (
                          <p className="text-xs text-kumo-subtle">
                            共 {list.total} 条，仅显示最近 {list.items.length} 条。
                          </p>
                        )}
                      </section>
                    ))}
                </Tabs.Panel>
                <Tabs.Panel value="diagnostics" className="kapibala-settings-panel space-y-4">
                  <p className="text-sm">
                    Kapibala {info?.version ?? '读取中'}
                    {info?.testBuild ? ' · 内部测试构建' : ''}
                  </p>
                  {info && (
                    <>
                      <p className="text-sm text-kumo-subtle">
                        Electron {info.runtimes.electron} · Node {info.runtimes.node} · Chromium{' '}
                        {info.runtimes.chrome}
                      </p>
                      <p className="text-sm text-kumo-subtle">
                        通知：
                        {info.notifications ? '系统支持，送达取决于系统权限' : '系统不支持'} ·
                        托盘：
                        {info.tray
                          ? '可用'
                          : info.platform === 'darwin'
                            ? '通过 Dock 恢复'
                            : '不可用，关窗需确认退出'}
                      </p>
                      <InlineCopyText
                        value={JSON.stringify(
                          {
                            name: info.name,
                            version: info.version,
                            testBuild: info.testBuild,
                            platform: info.platform,
                            runtimes: info.runtimes,
                            notifications: info.notifications,
                            tray: info.tray,
                          },
                          null,
                          2,
                        )}
                        labels={{
                          copyAction: '复制应用诊断',
                          copied: '已复制',
                        }}
                      >
                        复制应用诊断
                      </InlineCopyText>
                    </>
                  )}
                  <Button
                    className="kapibala-action"
                    variant="secondary"
                    onClick={() => void window.kapibala.app.requestQuit()}
                  >
                    停止任务并退出
                  </Button>
                </Tabs.Panel>
              </div>
            </Tabs.Root>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
