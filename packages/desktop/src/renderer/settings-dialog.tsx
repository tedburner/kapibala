import {
  Button,
  Combobox,
  InlineCopyText,
  Input,
  LayerDialog,
  Select,
  SensitiveInput,
  Switch,
} from '@cloudflare/kumo';
import { Tabs } from '@cloudflare/kumo/primitives/tabs';
import { useEffect, useRef, useState } from 'react';
import type { Output, ProfileDraft } from '../shared/contracts.js';

type Catalog = Output<'settings.read'>;
type Model = Catalog['profiles'][number];
/** 左导航只负责切换内容；诊断与产品设置同级但独立，避免版本信息混进日常配置。 */
const SETTINGS_TABS = [
  { value: 'models', label: '模型与服务商' },
  { value: 'routing', label: '默认模型与路由' },
  { value: 'appearance', label: '外观与应用' },
  { value: 'diagnostics', label: '诊断' },
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
/** 设置领域组合：Kumo 提供表单、敏感输入、过滤和焦点管理，本组件只提交确认过的配置字段。 */
export function SettingsDialog({
  open,
  onOpenChange,
  catalog,
  workspaceId,
  reload,
  report,
  hostDown = false,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  catalog?: Catalog;
  workspaceId?: string;
  reload(): Promise<void>;
  report(message: string): void;
  /** 执行 Host 断开或被阻断时，读取与保存都无法完成；表单明示原因而不是呈现空表单。 */
  hostDown?: boolean;
}) {
  const [info, setInfo] = useState<Output<'app.getInfo'>>();
  const [tab, setTab] = useState('models');
  const [selected, setSelected] = useState<Model>();
  const [draft, setDraft] = useState<ProfileDraft>();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    preview: Output<'settings.previewProfile'>;
    key: string;
    choice: '' | 'new' | 'reuse' | 'none';
  }>();
  const [notice, setNotice] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('light');
  const initialized = useRef(false);
  useEffect(() => {
    if (!open) {
      initialized.current = false;
      setKey('');
      setConfirmation(undefined);
      setNotice('');
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
      }
    }
  }, [open, catalog, report]);
  const change = <K extends keyof ProfileDraft>(field: K, value: ProfileDraft[K]) =>
    setDraft((current) => current && { ...current, [field]: value });
  async function save() {
    if (!draft) return;
    setBusy(true);
    setNotice('');
    try {
      const preview = await window.kapibala.settings.previewProfile({
        profile: draft,
        editId: selected?.id,
        workspaceId,
      });
      setConfirmation({ preview, key: key.trim(), choice: key.trim() ? 'new' : '' });
    } catch (error) {
      report(error instanceof Error ? error.message : '配置保存失败，请检查输入后重试。');
    } finally {
      setBusy(false);
    }
  }
  async function confirmSave() {
    if (!confirmation?.choice) return;
    setBusy(true);
    try {
      const { preview, choice, key: pendingKey } = confirmation;
      if (choice === 'new')
        await window.kapibala.settings.setCredential(preview.previewToken, pendingKey);
      else await window.kapibala.settings.saveProfile(preview.previewToken, choice);
      setKey('');
      setConfirmation(undefined);
      await reload();
      setNotice('配置已保存。连接是否可用将在明确发送任务后验证。');
    } catch (error) {
      setConfirmation(undefined);
      report(error instanceof Error ? error.message : '保存未完成，请重新预览。');
    } finally {
      setBusy(false);
    }
  }
  const builtin = Boolean(selected?.builtin && selected.id === draft?.id);
  return (
    <>
      <LayerDialog open={open} onOpenChange={onOpenChange} dismissDisabled={busy}>
        <LayerDialog.Content size="lg" closeLabel="关闭设置">
          <LayerDialog.Title>
            <span data-kapibala-modal="true">设置</span>
          </LayerDialog.Title>
          <LayerDialog.Description>
            模型配置与现有 CLI 共用。当前会话的临时模型选择不改变全局默认。
          </LayerDialog.Description>
          <LayerDialog.Body>
            {hostDown && (
              <div
                role="alert"
                className="mb-4 flex flex-wrap items-center gap-3 border-b border-kumo-line pb-4 text-sm"
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
            <Tabs.Root
              orientation="vertical"
              value={tab}
              onValueChange={(value) => setTab(String(value))}
              className="mt-5 flex gap-6"
            >
              <Tabs.List className="flex w-36 shrink-0 flex-col gap-1 self-start border-r border-kumo-line pr-3">
                {SETTINGS_TABS.map((item) => (
                  <Tabs.Tab
                    key={item.value}
                    value={item.value}
                    className="rounded-md px-3 py-2 text-left text-sm text-kumo-subtle outline-none hover:bg-kumo-recessed hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-focus aria-selected:bg-kumo-tint aria-selected:font-medium aria-selected:text-kumo-default"
                  >
                    {item.label}
                  </Tabs.Tab>
                ))}
              </Tabs.List>
              <div className="min-w-0 flex-1">
                <Tabs.Panel value="models" className="space-y-4">
                  <Combobox<Model>
                    label="模型 Profile"
                    items={catalog?.profiles ?? []}
                    value={selected ?? null}
                    // 设置页保留全量清单（这是补密钥的地方），但标出还不可用的条目，
                    // 否则用户看不出为什么输入区的模型菜单比这里少。
                    itemToStringLabel={(item) =>
                      item.credential.configured ? item.name : `${item.name}（未配置密钥）`
                    }
                    onValueChange={(model) => {
                      if (model) {
                        setSelected(model);
                        setDraft(draftOf(model));
                        setKey('');
                      }
                    }}
                  >
                    <Combobox.TriggerInput placeholder="选择模型" />
                    <Combobox.Content>
                      <Combobox.Empty>没有匹配的模型</Combobox.Empty>
                      <Combobox.List>
                        {(item: Model) => (
                          <Combobox.Item key={item.id} value={item}>
                            <span className="min-w-0 flex-1 truncate">{item.name}</span>
                            {!item.credential.configured && (
                              <span className="shrink-0 text-xs text-kumo-subtle">未配置密钥</span>
                            )}
                          </Combobox.Item>
                        )}
                      </Combobox.List>
                    </Combobox.Content>
                  </Combobox>
                  <Button
                    className="kapibala-action"
                    variant="secondary"
                    onClick={() => {
                      setSelected(undefined);
                      setDraft({
                        id: `custom-${crypto.randomUUID().slice(0, 8)}`,
                        name: '',
                        provider: 'openai-compatible',
                        modelName: '',
                        baseURL: '',
                        apiKeyEnv: 'CUSTOM_API_KEY',
                        contextWindow: 32000,
                      });
                      setKey('');
                    }}
                  >
                    新增自建模型
                  </Button>
                  {draft && (
                    <>
                      <div className="grid grid-cols-2 gap-4">
                        <Input
                          label="Profile ID"
                          value={draft.id}
                          disabled={builtin || busy}
                          onChange={(event) => change('id', event.target.value)}
                        />
                        <Input
                          label="显示名"
                          value={draft.name}
                          disabled={builtin || busy}
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
                          disabled={builtin || busy}
                          onValueChange={(value) =>
                            value && change('provider', value as ProfileDraft['provider'])
                          }
                        />
                        <Input
                          label="模型名"
                          value={draft.modelName}
                          disabled={builtin || busy}
                          onChange={(event) => change('modelName', event.target.value)}
                        />
                      </div>
                      <Input
                        label="Base URL"
                        value={draft.baseURL}
                        disabled={builtin || busy}
                        onChange={(event) => change('baseURL', event.target.value)}
                      />
                      <div className="grid grid-cols-2 gap-4">
                        <Input
                          label="凭证环境变量"
                          value={draft.apiKeyEnv}
                          disabled={builtin || busy}
                          onChange={(event) => change('apiKeyEnv', event.target.value)}
                        />
                        <Input
                          label="上下文窗口"
                          type="number"
                          value={draft.contextWindow ?? ''}
                          disabled={builtin || busy}
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
                      </div>
                      {selected && (
                        <p className="text-sm text-kumo-subtle">
                          {selected.credential.group} ·{' '}
                          {selected.credential.configured
                            ? `已配置（${selected.credential.source === 'env' || selected.credential.source === 'family-env' ? '环境变量' : '全局设置'}）`
                            : '尚未配置密钥'}
                        </p>
                      )}
                      <Switch
                        label="支持思考输出"
                        checked={draft.supportsThinking ?? false}
                        disabled={busy}
                        onCheckedChange={(checked) => change('supportsThinking', checked)}
                      />
                      <SensitiveInput
                        label="新 API Key"
                        value={key}
                        onValueChange={setKey}
                        disabled={busy}
                        autoComplete="off"
                        description="已有密钥不会回显。留空保留当前凭证；新密钥存放在全局 settings.json 中，并非系统钥匙串。"
                      />
                      {builtin && (
                        <Button
                          className="kapibala-action"
                          variant="ghost"
                          onClick={() => {
                            change('id', `${draft.id}-custom-${crypto.randomUUID().slice(0, 6)}`);
                          }}
                        >
                          另存为自建 Profile
                        </Button>
                      )}
                      <Button
                        className="kapibala-action"
                        disabled={busy}
                        onClick={() => void save()}
                      >
                        保存模型
                      </Button>
                    </>
                  )}
                </Tabs.Panel>
                <Tabs.Panel value="routing" className="space-y-4">
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
                <Tabs.Panel value="appearance" className="space-y-4">
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
                  <p className="text-sm text-kumo-subtle">主题设置适用于此客户端。</p>
                </Tabs.Panel>
                <Tabs.Panel value="diagnostics" className="space-y-4">
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
                        通知：{info.notifications ? '系统支持，送达取决于系统权限' : '系统不支持'} ·
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
                        labels={{ copyAction: '复制应用诊断', copied: '已复制' }}
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
                {notice && <output className="text-sm text-kumo-default">{notice}</output>}
              </div>
            </Tabs.Root>
          </LayerDialog.Body>
        </LayerDialog.Content>
      </LayerDialog>
      <LayerDialog
        open={Boolean(confirmation)}
        onOpenChange={(isOpen) => {
          if (!isOpen) setConfirmation(undefined);
        }}
        dismissDisabled={busy}
      >
        <LayerDialog.Content size="sm" closeLabel="返回编辑模型">
          <LayerDialog.Title>
            <span data-kapibala-modal="true">确认模型与凭证</span>
          </LayerDialog.Title>
          <LayerDialog.Description>
            确认只提交配置，不发起模型请求。预览 30 秒后失效。
          </LayerDialog.Description>
          <LayerDialog.Body>
            {confirmation && (
              <div className="space-y-4">
                <p className="text-sm">模型：{confirmation.preview.profile.name}</p>
                <p className="break-all font-mono text-sm">
                  实际端点：{confirmation.preview.profile.effectiveBaseURL}
                </p>
                <p className="text-sm">
                  凭证分组：{confirmation.preview.profile.credential.group} · 当前来源：
                  {confirmation.preview.profile.credential.source}
                </p>
                <Select
                  label="本次凭证选择"
                  value={confirmation.choice || null}
                  items={{
                    reuse: '明确复用目标分组或环境凭证',
                    new: '使用本次输入的新密钥',
                    none: '明确使用免鉴权端点',
                  }}
                  onValueChange={(value) =>
                    setConfirmation({ ...confirmation, choice: value as 'new' | 'reuse' | 'none' })
                  }
                />
                {confirmation.choice === 'new' && (
                  <p className="text-sm text-kumo-subtle">
                    新密钥将替换该分组所有模型共用的凭证，并清除同组冗余副本。
                    {confirmation.key ? '本次已输入新密钥。' : '请返回编辑并输入新密钥。'}
                  </p>
                )}
                {confirmation.choice === 'reuse' && (
                  <p className="text-sm text-kumo-subtle">
                    复用已解析的目标凭证，不把旧端点的内联密钥复制给新 Profile。
                  </p>
                )}
                {confirmation.choice === 'none' && (
                  <p className="text-sm text-kumo-subtle">
                    仅适用于凭证环境变量已设为 {catalog?.noAuthEnv} 的免鉴权
                    Profile；其它来源不会自动清除或降级。
                  </p>
                )}
                <Button
                  className="kapibala-action"
                  disabled={
                    busy ||
                    !confirmation.choice ||
                    (confirmation.choice === 'new' && !confirmation.key) ||
                    (confirmation.choice === 'reuse' &&
                      !confirmation.preview.profile.credential.configured) ||
                    (confirmation.choice === 'none' &&
                      confirmation.preview.profile.credential.source !== 'none')
                  }
                  onClick={() => void confirmSave()}
                >
                  确认保存配置
                </Button>
              </div>
            )}
          </LayerDialog.Body>
        </LayerDialog.Content>
      </LayerDialog>
    </>
  );
}
