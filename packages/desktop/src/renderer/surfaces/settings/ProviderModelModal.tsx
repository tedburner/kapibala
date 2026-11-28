import { useEffect, useRef, useState } from 'react';
import type { Output, ProfileDraft } from '../../../shared/contracts.js';
import { Button, ModalDialog, SecretField, Select, Switch, TextField } from '../../ui/index.js';
import {
  type SettingsModelProfile,
  createBlankCustomProfileDraft,
  profileToDraft,
  withSettingsWatchdog,
} from './settings-helpers.js';

/** 上下文窗口容量快捷预设刻度（点击写入数值，仍允许手工输入任意正整数）。 */
export const CONTEXT_WINDOW_PRESETS = [128_000, 256_000, 500_000, 1_000_000] as const;

/** 最大输出 Token 容量快捷预设刻度。 */
export const OUTPUT_TOKEN_PRESETS = [8_000, 16_000, 32_000, 64_000] as const;

function formatTokenPreset(tokens: number): string {
  return tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${tokens / 1000}k`;
}

function translateModelListError(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (code === 'MODEL_LIST_TIMEOUT' || code === 'REQUEST_TIMEOUT') {
    return '获取模型列表超时：请检查 Base URL 与网络连接后重试。';
  }
  if (code === 'MODEL_LIST_UNAVAILABLE') {
    return '无法获取模型列表：请检查 Base URL 与 API Key。';
  }
  if (code === 'MODEL_LIST_INVALID') {
    return '端点返回的不是标准模型列表，请手动填写模型名。';
  }
  return code || '获取模型列表失败，请手动填写模型名。';
}

type CustomFieldErrors = Partial<Record<'baseURL' | 'modelName' | 'apiKey', string>>;

/**
 * `ProviderModelModal` 入参契约（017 §0 铁律 3 & §6.7）：
 * 以单层原生 `<ModalDialog>` 承载自定义兼容端点新增与模型参数编辑，消灭页内长表单嵌套。
 */
export interface ProviderModelModalProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly editingModel?: SettingsModelProfile;
  readonly defaultVendorName?: string;
  readonly isCustomGroup: boolean;
  readonly hostDown?: boolean;
  readonly onSaved: (saved: SettingsModelProfile, noticeText: string) => Promise<void>;
  readonly report?: (message: string) => void;
}

/**
 * 模型与自定义服务商单层新建/编辑模态框：支持端点在线枚举 `/models`、容量预设芯片与改端点自动另存。
 */
export function ProviderModelModal({
  open,
  onOpenChange,
  editingModel,
  defaultVendorName = '',
  isCustomGroup,
  hostDown = false,
  onSaved,
  report,
}: ProviderModelModalProps) {
  const [draft, setDraft] = useState<ProfileDraft>(() =>
    editingModel ? profileToDraft(editingModel) : createBlankCustomProfileDraft(defaultVendorName),
  );
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchStatus, setFetchStatus] = useState('');
  const [probedModels, setProbedModels] = useState<readonly string[]>();
  const [manualModel, setManualModel] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<CustomFieldErrors>({});
  const probeSeq = useRef(0);

  useEffect(() => {
    if (!open) return;
    probeSeq.current += 1;
    setDraft(
      editingModel
        ? profileToDraft(editingModel)
        : createBlankCustomProfileDraft(defaultVendorName),
    );
    setApiKey('');
    setFetching(false);
    setFetchStatus('');
    setProbedModels(undefined);
    setManualModel(false);
    setFieldErrors({});
  }, [open, editingModel, defaultVendorName]);

  const customMode = !editingModel || !editingModel.builtin || isCustomGroup;

  function patchDraft<K extends keyof ProfileDraft>(field: K, value: ProfileDraft[K]): void {
    setDraft((prev) => ({ ...prev, [field]: value }));
  }

  async function probeEndpointModels(): Promise<void> {
    if (!draft.baseURL.trim()) {
      setFetchStatus('请先填写 Base URL。');
      return;
    }
    if (typeof window === 'undefined' || !window.kapibala) return;
    setFetching(true);
    setFetchStatus('');
    const seq = ++probeSeq.current;
    try {
      const result = await withSettingsWatchdog(
        window.kapibala.settings.listModels({
          baseURL: draft.baseURL.trim(),
          apiKey: apiKey.trim() || undefined,
          profileId: editingModel?.id,
          provider: draft.provider,
        }),
        'MODEL_LIST_TIMEOUT',
        12_000,
      );
      if (seq !== probeSeq.current) return;
      setProbedModels(result.models);
      setManualModel(result.models.length === 0);
      setFetchStatus(
        result.models.length > 0
          ? `已获取 ${result.models.length} 个模型。`
          : '端点未返回模型，请手动填写模型名。',
      );
      if (result.models.length > 0 && !draft.modelName.trim()) {
        patchDraft('modelName', result.models[0]!);
      }
    } catch (error) {
      if (seq !== probeSeq.current) return;
      setProbedModels(undefined);
      setManualModel(true);
      setFetchStatus(translateModelListError(error));
    } finally {
      if (seq === probeSeq.current) setFetching(false);
    }
  }

  async function submitSave(): Promise<void> {
    if (customMode) {
      const needsKey = !apiKey.trim() && !editingModel?.credential.configured;
      const errors: CustomFieldErrors = {
        baseURL: draft.baseURL.trim() ? undefined : '请填写 Base URL。',
        apiKey: needsKey ? '请填写 API Key。' : undefined,
        modelName: draft.modelName.trim() ? undefined : '请填写模型名。',
      };
      if (errors.baseURL || errors.apiKey || errors.modelName) {
        setFieldErrors(errors);
        return;
      }
    }
    if (typeof window === 'undefined' || !window.kapibala) return;
    setFieldErrors({});
    setBusy(true);
    try {
      const target: ProfileDraft = {
        ...draft,
        name: customMode
          ? draft.name.trim() || draft.modelName.trim()
          : draft.name.trim() || draft.modelName.trim(),
        modelName: draft.modelName.trim(),
        baseURL: draft.baseURL.trim(),
        vendorName: draft.vendorName?.trim() || undefined,
        apiKeyEnv: customMode && apiKey.trim() ? 'CUSTOM_API_KEY' : draft.apiKeyEnv,
      };
      const pendingKey = apiKey.trim() || undefined;
      let saved: Output<'settings.saveProfile'>;
      let savedAsNew = false;
      try {
        saved = await withSettingsWatchdog(
          window.kapibala.settings.saveProfile({
            profile: target,
            apiKey: pendingKey,
            editId: editingModel?.id,
          }),
          '保存超时：Host 可能已断开，请重启应用后确认配置。',
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'SAVE_AS_NEW_PROFILE' &&
          customMode &&
          editingModel
        ) {
          savedAsNew = true;
          saved = await withSettingsWatchdog(
            window.kapibala.settings.saveProfile({
              profile: { ...target, id: `custom-${crypto.randomUUID().slice(0, 8)}` },
              apiKey: pendingKey,
            }),
            '保存超时：Host 可能已断开，请重启应用后确认配置。',
          );
        } else {
          throw error;
        }
      }
      await onSaved(
        saved.profile,
        savedAsNew ? '端点已变更，已另存为新模型。' : '已保存到本地配置。',
      );
      onOpenChange(false);
    } catch (error) {
      if (error instanceof Error && error.message === 'CONFIG_REQUIRED') {
        setFieldErrors({ apiKey: '请填写 API Key。' });
      } else {
        report?.(error instanceof Error ? error.message : '配置保存失败，请检查输入后重试。');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen);
      }}
      title={editingModel ? `编辑模型 · ${editingModel.name}` : '新增自定义模型'}
      description={
        customMode
          ? '配置兼容 OpenAI 或 Anthropic 协议的服务商端点，保存后立即写入全局 settings.json。'
          : '调整内置模型的输出上限、思考模式或更新凭证。'
      }
      width="lg"
      closedBy={busy ? 'none' : 'closerequest'}
      closeLabel="关闭模型表单"
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="solid"
            loading={busy}
            disabled={hostDown}
            onClick={() => void submitSave()}
          >
            保存到本地
          </Button>
        </>
      }
    >
      <div className="kpbl-dialog-stack">
        {customMode ? (
          <>
            <div className="kpbl-form-grid-2">
              <TextField
                label="厂商名称"
                placeholder="如 OpenRouter；留空归入自定义端点"
                value={draft.vendorName ?? ''}
                maxLength={64}
                disabled={busy}
                onValueChange={(val) => patchDraft('vendorName', val)}
              />
              <Select
                aria-label="协议"
                value={draft.provider}
                disabled={busy}
                onValueChange={(val) => patchDraft('provider', val)}
                options={[
                  { value: 'openai-compatible', label: 'Chat Completions (OpenAI 兼容)' },
                  { value: 'openai-responses', label: 'OpenAI Responses' },
                  { value: 'anthropic', label: 'Anthropic Messages' },
                ]}
              />
            </div>
            <TextField
              mono
              label="Base URL（必填）"
              placeholder="https://api.example.com/v1"
              value={draft.baseURL}
              error={fieldErrors.baseURL}
              disabled={busy}
              onValueChange={(val) => {
                patchDraft('baseURL', val);
                setFieldErrors((prev) => ({ ...prev, baseURL: undefined }));
              }}
            />
            <SecretField
              label="API Key（必填）"
              value={apiKey}
              configured={Boolean(editingModel?.credential.configured)}
              error={fieldErrors.apiKey}
              disabled={busy}
              description={
                editingModel?.credential.configured
                  ? '已有密钥不会回显；留空继续复用当前分组已存凭证。'
                  : '密钥保存在全局 settings.json 中，与 CLI 共用。'
              }
              onValueChange={(val) => {
                setApiKey(val);
                setFieldErrors((prev) => ({ ...prev, apiKey: undefined }));
              }}
            />
            <div className="kpbl-row-title-line">
              <Button
                variant="outline"
                size="sm"
                loading={fetching}
                disabled={busy || hostDown}
                onClick={() => void probeEndpointModels()}
              >
                {fetching ? '获取中…' : '获取模型列表'}
              </Button>
              {probedModels && probedModels.length > 0 ? (
                <Button variant="ghost" size="sm" onClick={() => setManualModel((prev) => !prev)}>
                  {manualModel ? '从列表选择模型' : '手动填写模型名'}
                </Button>
              ) : null}
              {fetchStatus ? <span className="kpbl-field-hint">{fetchStatus}</span> : null}
            </div>
            {probedModels && probedModels.length > 0 && !manualModel ? (
              <Select
                aria-label="模型（必填）"
                value={draft.modelName || undefined}
                placeholder="选择端点返回的模型"
                disabled={busy}
                options={probedModels.map((item) => ({ value: item, label: item }))}
                onValueChange={(val) => {
                  patchDraft('modelName', val);
                  setFieldErrors((prev) => ({ ...prev, modelName: undefined }));
                }}
              />
            ) : (
              <TextField
                mono
                label="模型名（必填）"
                placeholder="deepseek-chat"
                value={draft.modelName}
                error={fieldErrors.modelName}
                disabled={busy}
                onValueChange={(val) => {
                  patchDraft('modelName', val);
                  setFieldErrors((prev) => ({ ...prev, modelName: undefined }));
                }}
              />
            )}
            <TextField
              label="显示名"
              placeholder="留空默认使用模型名"
              value={draft.name}
              disabled={busy}
              onValueChange={(val) => patchDraft('name', val)}
            />
          </>
        ) : (
          <SecretField
            label="新 API Key"
            value={apiKey}
            configured={Boolean(editingModel?.credential.configured)}
            disabled={busy}
            description="同一服务商组内模型共用凭证；留空保留已存密钥。"
            onValueChange={setApiKey}
          />
        )}

        <details className="kpbl-accordion-form">
          <summary className="kpbl-field-label">高级设置</summary>
          <div className="kpbl-dialog-stack">
            {customMode ? (
              <>
                <TextField
                  type="number"
                  label="上下文窗口"
                  value={draft.contextWindow ?? ''}
                  disabled={busy}
                  description="留空将在保存时自动探测或按 256K 估算。"
                  onValueChange={(val) =>
                    patchDraft('contextWindow', val ? Number(val) : undefined)
                  }
                />
                <fieldset className="kpbl-preset-row">
                  <legend className="kpbl-sr-only">上下文窗口预设</legend>
                  {CONTEXT_WINDOW_PRESETS.map((tokens) => (
                    <Button
                      key={tokens}
                      variant={draft.contextWindow === tokens ? 'solid' : 'outline'}
                      size="xs"
                      disabled={busy}
                      aria-pressed={draft.contextWindow === tokens}
                      onClick={() => patchDraft('contextWindow', tokens)}
                    >
                      {formatTokenPreset(tokens)}
                    </Button>
                  ))}
                </fieldset>
              </>
            ) : null}
            <TextField
              type="number"
              label="最大输出 Token"
              value={draft.maxOutputTokens ?? ''}
              disabled={busy}
              onValueChange={(val) => patchDraft('maxOutputTokens', val ? Number(val) : undefined)}
            />
            <fieldset className="kpbl-preset-row">
              <legend className="kpbl-sr-only">最大输出 Token 预设</legend>
              {OUTPUT_TOKEN_PRESETS.map((tokens) => (
                <Button
                  key={tokens}
                  variant={draft.maxOutputTokens === tokens ? 'solid' : 'outline'}
                  size="xs"
                  disabled={busy}
                  aria-pressed={draft.maxOutputTokens === tokens}
                  onClick={() => patchDraft('maxOutputTokens', tokens)}
                >
                  {formatTokenPreset(tokens)}
                </Button>
              ))}
            </fieldset>
            <Switch
              label="支持思考输出"
              checked={draft.supportsThinking ?? false}
              disabled={busy}
              onCheckedChange={(checked) => patchDraft('supportsThinking', checked)}
            />
          </div>
        </details>
      </div>
    </ModalDialog>
  );
}
