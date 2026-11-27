import { Button, InlineCopyText, Input, InputArea, Switch } from '@cloudflare/kumo';
import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  PlugsConnectedIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  SparkleIcon,
  TrashIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Output } from '../shared/contracts.js';

type HarnessesOutput = Output<'external.harnesses'>;
type HarnessItem = HarnessesOutput['harnesses'][number];
type TemplateItem = HarnessesOutput['templates'][number];
type ProbeResult = Output<'external.testHarness'>;

/** 内置代理覆盖草稿：command 留空表示沿用内置命令名自动探测。 */
interface BuiltinOverrideDraft {
  readonly id: string;
  command: string;
  argsText: string;
  envFromText: string;
}

/** 自定义 Local ACP Command 表单草稿；参数逐行拆分，严禁经过 Shell 字符串拼接。 */
interface CustomHarnessDraft {
  id: string;
  idLocked: boolean;
  idTouched: boolean;
  name: string;
  command: string;
  argsText: string;
  envFromText: string;
  registryId?: string;
  enabled: boolean;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HARNESS_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PASTED_SECRET_RE =
  /^(?:sk-[A-Za-z0-9_-]{8,}|sk_[A-Za-z0-9_]{8,}|pk_[A-Za-z0-9_]{8,}|rk_[A-Za-z0-9_]{8,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[abprs]-[A-Za-z0-9-]{8,}|hf_[A-Za-z0-9]{12,}|gsk_[A-Za-z0-9]{12,}|AIza[0-9A-Za-z_-]{16,}|AKIA[0-9A-Z]{12,})$/;

/**
 * 为外部代理管理与探测请求包裹前端看门狗；
 * 外部 CLI 首次冷启动可能触发 Node/二进制加载，探测默认放宽至 20 秒，常规写盘 10 秒。
 */
function withExternalWatchdog<T>(task: Promise<T>, message: string, ms = 10_000): Promise<T> {
  return Promise.race([
    task,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

/** 逐行解析非空启动参数；保留行内空格（如路径参数），仅剔除首尾换行与空行。 */
function parseArgsLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 解析逗号、空白或换行分隔的环境变量名列表，并在前端先行拦截非法变量名或疑似键值对输入。 */
function parseEnvNames(text: string): { names: string[]; error?: string } {
  const raw = text
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of raw) {
    if (item.includes('=')) {
      const keyPreview = item.slice(0, item.indexOf('=')).slice(0, 48) || '***';
      return {
        names: [],
        error: `环境变量名「${keyPreview}=***」不应包含 "=" 或密钥值，请仅填写变量名。`,
      };
    }
    if (PASTED_SECRET_RE.test(item)) {
      return {
        names: [],
        error: '检测到疑似直接粘贴了密钥明文，请仅填写系统环境变量名称（如 OPENAI_API_KEY）。',
      };
    }
    if (!ENV_NAME_RE.test(item)) {
      const safePreview = item.length > 24 ? `${item.slice(0, 12)}…` : item;
      return {
        names: [],
        error: `环境变量名「${safePreview}」格式不合法（需以字母或下划线开头，仅含字母、数字与下划线）。`,
      };
    }
    if (!seen.has(item)) {
      seen.add(item);
      names.push(item);
    }
  }
  return { names };
}

/**
 * 根据显示名称派生默认 kebab-case 代理标识，并自动避让已有内置或自定义代理 ID（如纯中文名称自动生成 `custom-acp`、`custom-acp-2`）。
 */
function suggestHarnessId(name: string, occupiedIds?: ReadonlySet<string>): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const base = slug || 'custom-acp';
  if (!occupiedIds || !occupiedIds.has(base)) {
    return base;
  }
  let suffix = 2;
  while (occupiedIds.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function transportBadgeText(transport: HarnessItem['transport']): string {
  if (transport === 'acp') return '原生 ACP';
  if (transport === 'claude-cli') return '原生 CLI 直连';
  if (transport === 'pi-rpc') return 'Pi 原生直连';
  return '原生 App-Server';
}

function formatCacheUpdatedAt(updatedAt: number): string {
  const date = new Date(updatedAt);
  const now = new Date();
  const pad = (num: number) => String(num).padStart(2, '0');
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return hhmm;
  }
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hhmm}`;
}

function describeHarnessCache(item: HarnessItem): {
  readonly cached: boolean;
  readonly modelCount: number;
  readonly summary: string;
} {
  const options = item.cachedConfigOptions;
  if (!options || options.length === 0) {
    return {
      cached: false,
      modelCount: 0,
      summary: '模型缓存：尚未缓存，首次选用或点击右侧「拉取缓存」后写入本地',
    };
  }
  const modelCount = options.find((opt) => opt.category === 'model')?.options.length ?? 0;
  const thoughtCount = options.find((opt) => opt.category === 'thought_level')?.options.length ?? 0;
  const modeCount = options.find((opt) => opt.category === 'mode')?.options.length ?? 0;
  const parts: string[] = [
    modelCount > 0 ? `已缓存 ${modelCount} 个模型` : '已缓存运行参数',
    ...(thoughtCount > 0 ? [`推理 ${thoughtCount} 档`] : []),
    ...(modeCount > 0 ? [`模式 ${modeCount} 项`] : []),
    ...(item.cachedConfigUpdatedAt !== undefined
      ? [`更新于 ${formatCacheUpdatedAt(item.cachedConfigUpdatedAt)}`]
      : []),
  ];
  return {
    cached: true,
    modelCount,
    summary: `模型缓存：${parts.join(' · ')}`,
  };
}

function probeBadge(probe?: ProbeResult): { label: string; className: string } {
  if (!probe) {
    return { label: '未检测', className: 'border border-kumo-hairline text-kumo-faint' };
  }
  if (probe.status === 'ready') {
    const suffix = probe.version ? ` · ${probe.version}` : '';
    return { label: `就绪${suffix}`, className: 'bg-kumo-tint font-medium text-kumo-success' };
  }
  if (probe.status === 'needs_login') {
    return { label: '需登录', className: 'bg-kumo-tint font-medium text-kumo-warning' };
  }
  if (probe.status === 'auth_unverified') {
    return { label: '认证未核验', className: 'bg-kumo-tint font-medium text-kumo-warning' };
  }
  if (probe.status === 'not_installed') {
    return { label: '未安装', className: 'border border-kumo-hairline text-kumo-subtle' };
  }
  if (probe.status === 'invalid_shim') {
    return { label: '垫片异常', className: 'bg-kumo-tint font-medium text-kumo-danger' };
  }
  return { label: '握手失败', className: 'bg-kumo-tint font-medium text-kumo-danger' };
}

/**
 * 设置页「外部代理」图形化配置面板。
 *
 * 前置约束与设计边界：
 * - 读写与 CLI `/external` 同源的 `~/.kapibala/external/harnesses.json`，全程图形化操作；
 * - 严禁采集或存储任何第三方 API Key 明文，`envFrom` 仅登记允许从系统环境透传的变量名；
 * - 自定义代理支持保存前直接执行真实 ACP 握手测试，回显对端名称、版本与会话恢复能力。
 */
export function ExternalSettingsPanel({
  active,
  workspaceId,
  hostDown = false,
  report,
}: {
  /** 当前是否处于打开的「外部代理」标签页；切入时拉取最新配置清单。 */
  readonly active: boolean;
  /** 握手探测使用的受信工作区上下文；缺省时由宿主回退默认空间。 */
  readonly workspaceId?: string;
  /** 执行宿主断连时禁用保存与探测按钮。 */
  readonly hostDown?: boolean;
  /** 将未预期异常同步上报至顶层提示。 */
  readonly report: (message: string) => void;
}) {
  const [harnesses, setHarnesses] = useState<readonly HarnessItem[]>([]);
  const [templates, setTemplates] = useState<readonly TemplateItem[]>([]);
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({});
  const [testingId, setTestingId] = useState<string>();
  const [refreshingCacheId, setRefreshingCacheId] = useState<string>();
  const [refreshingAllCaches, setRefreshingAllCaches] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [panelError, setPanelError] = useState('');
  const [overrideDraft, setOverrideDraft] = useState<BuiltinOverrideDraft>();
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState<CustomHarnessDraft>();
  const [draftProbe, setDraftProbe] = useState<ProbeResult>();
  const [testingDraft, setTestingDraft] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>();
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchHarnesses = useCallback(async (): Promise<readonly HarnessItem[] | undefined> => {
    if (hostDown) return undefined;
    try {
      const result = await window.kapibala.external.harnesses(workspaceId);
      if (!mountedRef.current) return undefined;
      setHarnesses(result.harnesses);
      setTemplates(result.templates);
      return result.harnesses;
    } catch (error: unknown) {
      if (!mountedRef.current) return undefined;
      const message = error instanceof Error ? error.message : '读取外部代理列表失败。';
      setPanelError(message);
      report(message);
      return undefined;
    }
  }, [hostDown, workspaceId, report]);

  useEffect(() => {
    if (!active) return;
    void fetchHarnesses();
  }, [active, fetchHarnesses]);

  const builtinHarnesses = harnesses.filter((item) => item.builtin);
  const customHarnesses = harnesses.filter((item) => !item.builtin);

  async function runProbe(item: HarnessItem): Promise<void> {
    if (testingId || refreshingCacheId || refreshingAllCaches || hostDown) return;
    setTestingId(item.id);
    setPanelError('');
    try {
      const result = await withExternalWatchdog(
        window.kapibala.external.testHarness({ id: item.id, workspaceId }),
        `检测 ${item.name} 超时，请检查本机命令是否可正常退出或响应。`,
        25_000,
      );
      if (!mountedRef.current) return;
      setProbes((prev) => ({ ...prev, [item.id]: result }));
      await fetchHarnesses();
    } catch (error) {
      if (!mountedRef.current) return;
      const message = error instanceof Error ? error.message : '检测连接失败。';
      setPanelError(message);
    } finally {
      if (mountedRef.current) setTestingId(undefined);
    }
  }

  async function refreshCache(item: HarnessItem): Promise<void> {
    if (testingId || refreshingCacheId || refreshingAllCaches || hostDown) return;
    setRefreshingCacheId(item.id);
    setPanelError('');
    setNotice('');
    try {
      const result = await withExternalWatchdog(
        window.kapibala.external.testHarness({ id: item.id, workspaceId }),
        `刷新 ${item.name} 模型缓存超时，请检查本机命令是否响应。`,
        25_000,
      );
      if (!mountedRef.current) return;
      setProbes((prev) => ({ ...prev, [item.id]: result }));
      const latest = await fetchHarnesses();
      if (!mountedRef.current) return;
      if (!result.available) {
        setPanelError(
          result.reason ||
            (result.loginHint
              ? `${item.name} 需要先完成登录：${result.loginHint}`
              : `未能拉取 ${item.name} 的模型缓存。`),
        );
        return;
      }
      const refreshedItem = latest?.find((entry) => entry.id === item.id);
      const info = refreshedItem ? describeHarnessCache(refreshedItem) : undefined;
      setNotice(
        info && info.modelCount > 0
          ? `已刷新 ${item.name} 本地缓存（共 ${info.modelCount} 个模型）。`
          : `已刷新 ${item.name} 本地配置缓存。`,
      );
    } catch (error) {
      if (!mountedRef.current) return;
      setPanelError(error instanceof Error ? error.message : '刷新模型缓存失败。');
    } finally {
      if (mountedRef.current) setRefreshingCacheId(undefined);
    }
  }

  async function refreshAllEnabledCaches(): Promise<void> {
    if (testingId || refreshingCacheId || refreshingAllCaches || hostDown) return;
    const enabledItems = harnesses.filter((item) => item.enabled);
    if (enabledItems.length === 0) return;
    setRefreshingAllCaches(true);
    setPanelError('');
    setNotice('');
    let succeeded = 0;
    try {
      for (const item of enabledItems) {
        if (!mountedRef.current) return;
        setRefreshingCacheId(item.id);
        try {
          const result = await withExternalWatchdog(
            window.kapibala.external.testHarness({ id: item.id, workspaceId }),
            `刷新 ${item.name} 模型缓存超时。`,
            25_000,
          );
          if (!mountedRef.current) return;
          setProbes((prev) => ({ ...prev, [item.id]: result }));
          if (result.available) succeeded += 1;
        } catch {
          // 单个外部 CLI 失败不中断其余已启用代理的批量缓存刷新
        }
      }
      await fetchHarnesses();
      if (!mountedRef.current) return;
      setNotice(`已同步 ${succeeded}/${enabledItems.length} 个已启用外部代理的本地缓存。`);
    } finally {
      if (mountedRef.current) {
        setRefreshingCacheId(undefined);
        setRefreshingAllCaches(false);
      }
    }
  }

  async function toggleEnabled(item: HarnessItem, enabled: boolean): Promise<void> {
    if (busy || hostDown) return;
    setBusy(true);
    setPanelError('');
    setNotice('');
    try {
      const updated = await withExternalWatchdog(
        window.kapibala.external.toggleHarness({ id: item.id, enabled }),
        '更新外部代理状态超时。',
      );
      if (!mountedRef.current) return;
      setHarnesses(updated.harnesses);
      setNotice(enabled ? `已启用 ${item.name}。` : `已停用 ${item.name}。`);
    } catch (error) {
      if (!mountedRef.current) return;
      const message = error instanceof Error ? error.message : '更新状态失败。';
      setPanelError(message);
      report(message);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  function openOverrideEditor(item: HarnessItem): void {
    if (overrideDraft?.id === item.id) {
      setOverrideDraft(undefined);
      return;
    }
    setOverrideDraft({
      id: item.id,
      command: item.command,
      argsText: item.args.join('\n'),
      envFromText: item.envFrom.join(', '),
    });
  }

  async function saveBuiltinOverride(item: HarnessItem): Promise<void> {
    if (!overrideDraft || overrideDraft.id !== item.id || busy || hostDown) return;
    const parsedEnv = parseEnvNames(overrideDraft.envFromText);
    if (parsedEnv.error) {
      setPanelError(parsedEnv.error);
      return;
    }
    setBusy(true);
    setPanelError('');
    setNotice('');
    try {
      const updated = await withExternalWatchdog(
        window.kapibala.external.saveHarness({
          id: item.id,
          builtin: true,
          command: overrideDraft.command.trim(),
          args: parseArgsLines(overrideDraft.argsText),
          envFrom: parsedEnv.names,
        }),
        '保存覆盖设置超时。',
      );
      if (!mountedRef.current) return;
      setHarnesses(updated.harnesses);
      setProbes((prev) => {
        const { [item.id]: _dropped, ...rest } = prev;
        return rest;
      });
      setOverrideDraft(undefined);
      setNotice(`已保存 ${item.name} 的配置覆盖。`);
    } catch (error) {
      if (!mountedRef.current) return;
      const message = error instanceof Error ? error.message : '保存覆盖设置失败。';
      setPanelError(message);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function resetBuiltin(item: HarnessItem): Promise<void> {
    if (busy || hostDown) return;
    setBusy(true);
    setPanelError('');
    setNotice('');
    try {
      const updated = await withExternalWatchdog(
        window.kapibala.external.resetHarness(item.id),
        '恢复默认设置超时。',
      );
      if (!mountedRef.current) return;
      setHarnesses(updated.harnesses);
      setProbes((prev) => {
        const { [item.id]: _dropped, ...rest } = prev;
        return rest;
      });
      if (overrideDraft?.id === item.id) setOverrideDraft(undefined);
      setNotice(`已恢复 ${item.name} 的默认配置。`);
    } catch (error) {
      if (!mountedRef.current) return;
      const message = error instanceof Error ? error.message : '恢复默认配置失败。';
      setPanelError(message);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  function startBlankCustom(): void {
    setDraftProbe(undefined);
    setPanelError('');
    setCustomDraft({
      id: '',
      idLocked: false,
      idTouched: false,
      name: '',
      command: '',
      argsText: 'acp',
      envFromText: '',
      enabled: true,
    });
  }

  function applyTemplate(template: TemplateItem): void {
    setTemplatesOpen(false);
    setDraftProbe(undefined);
    setPanelError('');
    const existing = customHarnesses.find((item) => item.id === template.registryId);
    setCustomDraft({
      id: existing ? `${template.registryId}-custom` : template.registryId,
      idLocked: false,
      idTouched: true,
      name: template.name,
      command: template.command,
      argsText: template.args.join('\n'),
      envFromText: (template.envFrom ?? []).join(', '),
      registryId: template.registryId,
      enabled: true,
    });
  }

  function editCustom(item: HarnessItem): void {
    setDraftProbe(undefined);
    setPanelError('');
    setCustomDraft({
      id: item.id,
      idLocked: true,
      idTouched: true,
      name: item.name,
      command: item.command,
      argsText: item.args.join('\n'),
      envFromText: item.envFrom.join(', '),
      registryId: item.registryId,
      enabled: item.enabled,
    });
  }

  async function probeCustomDraft(): Promise<void> {
    if (!customDraft || testingDraft || hostDown) return;
    const name = customDraft.name.trim() || customDraft.id.trim() || '自定义代理';
    const command = customDraft.command.trim();
    if (!command) {
      setPanelError('请先填写可执行命令或绝对路径。');
      return;
    }
    const parsedEnv = parseEnvNames(customDraft.envFromText);
    if (parsedEnv.error) {
      setPanelError(parsedEnv.error);
      return;
    }
    setTestingDraft(true);
    setPanelError('');
    setDraftProbe(undefined);
    try {
      const result = await withExternalWatchdog(
        window.kapibala.external.testHarness({
          workspaceId,
          draft: {
            name,
            command,
            args: parseArgsLines(customDraft.argsText),
            envFrom: parsedEnv.names,
          },
        }),
        '握手测试超时，请确认命令支持标准输入输出 ACP 协议。',
        25_000,
      );
      if (!mountedRef.current) return;
      setDraftProbe(result);
    } catch (error) {
      if (!mountedRef.current) return;
      setPanelError(error instanceof Error ? error.message : '测试握手失败。');
    } finally {
      if (mountedRef.current) setTestingDraft(false);
    }
  }

  async function saveCustomDraft(): Promise<void> {
    if (!customDraft || busy || hostDown) return;
    const occupiedIds = new Set(harnesses.map((item) => item.id));
    const name = customDraft.name.trim();
    const id = (customDraft.id.trim() || suggestHarnessId(name, occupiedIds)).toLowerCase();
    const command = customDraft.command.trim();
    if (!name) {
      setPanelError('请填写自定义代理的显示名称。');
      return;
    }
    if (!HARNESS_ID_RE.test(id)) {
      setPanelError('代理标识 ID 需以小写字母或数字开头，仅含小写字母、数字、连字符或下划线。');
      return;
    }
    if (builtinHarnesses.some((item) => item.id === id)) {
      setPanelError(`标识「${id}」与内置代理冲突，请更换其它 ID。`);
      return;
    }
    if (!customDraft.idLocked && customHarnesses.some((item) => item.id === id)) {
      setPanelError(`标识「${id}」已被现有自定义代理占用，请更换其它 ID 或直接编辑原条目。`);
      return;
    }
    if (!command) {
      setPanelError('请填写可执行命令或绝对路径。');
      return;
    }
    const parsedEnv = parseEnvNames(customDraft.envFromText);
    if (parsedEnv.error) {
      setPanelError(parsedEnv.error);
      return;
    }
    setBusy(true);
    setPanelError('');
    setNotice('');
    try {
      const updated = await withExternalWatchdog(
        window.kapibala.external.saveHarness({
          id,
          builtin: false,
          name,
          command,
          args: parseArgsLines(customDraft.argsText),
          envFrom: parsedEnv.names,
          registryId: customDraft.registryId,
          enabled: customDraft.enabled,
        }),
        '保存自定义代理超时。',
      );
      if (!mountedRef.current) return;
      setHarnesses(updated.harnesses);
      setCustomDraft(undefined);
      setDraftProbe(undefined);
      setNotice(`已保存自定义 ACP 代理「${name}」。`);
    } catch (error) {
      if (!mountedRef.current) return;
      setPanelError(error instanceof Error ? error.message : '保存自定义代理失败。');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function removeCustom(item: HarnessItem): Promise<void> {
    if (busy || hostDown) return;
    setBusy(true);
    setPanelError('');
    setNotice('');
    try {
      const updated = await withExternalWatchdog(
        window.kapibala.external.deleteHarness(item.id),
        '删除自定义代理超时。',
      );
      if (!mountedRef.current) return;
      setHarnesses(updated.harnesses);
      setConfirmDeleteId(undefined);
      if (customDraft?.id === item.id) {
        setCustomDraft(undefined);
        setDraftProbe(undefined);
      }
      setNotice(`已删除自定义代理「${item.name}」。`);
    } catch (error) {
      if (!mountedRef.current) return;
      setPanelError(error instanceof Error ? error.message : '删除自定义代理失败。');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {notice && (
        <output className="block rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-default">
          {notice}
        </output>
      )}
      {panelError && (
        <div
          role="alert"
          className="rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-danger"
        >
          {panelError}
        </div>
      )}

      {/* 区域一：内置外部代理列表 */}
      <section className="space-y-3" aria-label="内置外部代理">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="text-sm font-semibold text-kumo-default">内置外部代理</h3>
            <p className="text-xs text-kumo-subtle">
              直接复用本机已安装的 CLI
              工具及其自有登录态；模型、推理档位与运行模式缓存在本地，无需每次重复拉取。
            </p>
          </div>
          <Button
            className="kapibala-action shrink-0"
            variant="secondary"
            size="sm"
            disabled={
              hostDown ||
              busy ||
              Boolean(testingId) ||
              Boolean(refreshingCacheId) ||
              refreshingAllCaches ||
              !harnesses.some((item) => item.enabled)
            }
            onClick={() => void refreshAllEnabledCaches()}
          >
            <ArrowsClockwiseIcon size={14} />
            {refreshingAllCaches ? '同步缓存中…' : '刷新已启用缓存'}
          </Button>
        </div>
        <div className="divide-y divide-kumo-hairline overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
          {builtinHarnesses.map((item) => {
            const probe = probes[item.id] ?? item.probe;
            const badge = probeBadge(probe);
            const cacheInfo = describeHarnessCache(item);
            const editing = overrideDraft?.id === item.id;
            const commandPreview = [item.command, ...item.args].join(' ');
            return (
              <div
                key={item.id}
                className="space-y-2.5 px-4 py-3 transition-colors hover:bg-kumo-tint"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`text-sm font-medium ${
                          item.enabled ? 'text-kumo-default' : 'text-kumo-subtle'
                        }`}
                      >
                        {item.name}
                      </span>
                      <span className="rounded-md bg-kumo-recessed px-1.5 py-0.5 text-2xs text-kumo-subtle">
                        {transportBadgeText(item.transport)}
                      </span>
                      <span className={`rounded-md px-1.5 py-0.5 text-2xs ${badge.className}`}>
                        {badge.label}
                      </span>
                      {item.hasOverride && (
                        <span className="rounded-md bg-kumo-tint px-1.5 py-0.5 text-2xs font-medium text-kumo-default">
                          已覆盖配置
                        </span>
                      )}
                    </div>
                    <p
                      className="truncate font-mono text-xs text-kumo-subtle"
                      title={
                        item.envFrom.length > 0
                          ? `${commandPreview} · 透传变量：${item.envFrom.join(', ')}`
                          : commandPreview
                      }
                    >
                      {commandPreview}
                      {item.envFrom.length > 0 ? ` · 透传变量：${item.envFrom.join(', ')}` : ''}
                    </p>
                    <p className="text-xs text-kumo-subtle">{cacheInfo.summary}</p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Button
                      className="kapibala-action"
                      variant="secondary"
                      size="sm"
                      aria-label={`检测 ${item.name} 连接`}
                      disabled={
                        hostDown ||
                        testingId === item.id ||
                        refreshingCacheId === item.id ||
                        refreshingAllCaches
                      }
                      onClick={() => void runProbe(item)}
                    >
                      <PlugsConnectedIcon size={14} />
                      {testingId === item.id ? '检测中…' : '检测连接'}
                    </Button>
                    <Button
                      className="kapibala-action"
                      variant="ghost"
                      size="sm"
                      aria-label={`刷新 ${item.name} 模型缓存`}
                      disabled={
                        hostDown ||
                        testingId === item.id ||
                        refreshingCacheId === item.id ||
                        refreshingAllCaches
                      }
                      onClick={() => void refreshCache(item)}
                    >
                      <ArrowsClockwiseIcon size={14} />
                      {refreshingCacheId === item.id
                        ? '刷新中…'
                        : cacheInfo.cached
                          ? '刷新缓存'
                          : '拉取缓存'}
                    </Button>
                    <Button
                      className="kapibala-action"
                      variant="ghost"
                      size="sm"
                      aria-expanded={editing}
                      aria-label={`配置 ${item.name} 覆盖项`}
                      disabled={hostDown}
                      onClick={() => openOverrideEditor(item)}
                    >
                      <SlidersHorizontalIcon size={14} />
                      配置覆盖
                    </Button>
                    <Switch
                      variant="neutral"
                      checked={item.enabled}
                      disabled={hostDown || busy}
                      aria-label={`启用 ${item.name}`}
                      onCheckedChange={(checked) => void toggleEnabled(item, checked)}
                    />
                  </div>
                </div>

                {probe && (!probe.available || probe.loginHint || probe.installHint) && (
                  <div className="space-y-1.5 rounded-lg border border-kumo-hairline bg-kumo-recessed px-3 py-2 text-xs">
                    {probe.reason && (
                      <p className="flex items-start gap-1.5 text-kumo-subtle">
                        <WarningCircleIcon
                          size={14}
                          className="mt-0.5 shrink-0 text-kumo-warning"
                        />
                        <span>{probe.reason}</span>
                      </p>
                    )}
                    {probe.loginHint && (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-kumo-subtle">终端登录命令：</span>
                        <InlineCopyText
                          value={probe.loginHint}
                          labels={{ copyAction: '复制登录命令', copied: '已复制' }}
                        >
                          <code className="font-mono text-xs">{probe.loginHint}</code>
                        </InlineCopyText>
                      </div>
                    )}
                    {probe.installHint && probe.status === 'not_installed' && (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-kumo-subtle">安装指引：</span>
                        <InlineCopyText
                          value={probe.installHint}
                          labels={{ copyAction: '复制安装指引', copied: '已复制' }}
                        >
                          <code className="font-mono text-xs">{probe.installHint}</code>
                        </InlineCopyText>
                      </div>
                    )}
                  </div>
                )}

                {editing && overrideDraft && (
                  <div className="space-y-3 border-t border-kumo-hairline pt-3">
                    <div className="space-y-1">
                      <label
                        htmlFor={`ext-override-cmd-${item.id}`}
                        className="block text-xs font-medium text-kumo-subtle"
                      >
                        可执行命令或绝对路径覆盖
                      </label>
                      <Input
                        id={`ext-override-cmd-${item.id}`}
                        size="sm"
                        className="w-full"
                        aria-label={`${item.name} 可执行路径`}
                        placeholder={item.command}
                        value={overrideDraft.command}
                        onValueChange={(value) =>
                          setOverrideDraft({ ...overrideDraft, command: value })
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <label
                        htmlFor={`ext-override-args-${item.id}`}
                        className="block text-xs font-medium text-kumo-subtle"
                      >
                        启动参数（每行作为独立参数原样传递，不经 Shell 解析）
                      </label>
                      <InputArea
                        id={`ext-override-args-${item.id}`}
                        className="w-full"
                        aria-label={`${item.name} 启动参数`}
                        minRows={2}
                        maxRows={5}
                        value={overrideDraft.argsText}
                        onValueChange={(value) =>
                          setOverrideDraft({ ...overrideDraft, argsText: value })
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <label
                        htmlFor={`ext-override-env-${item.id}`}
                        className="block text-xs font-medium text-kumo-subtle"
                      >
                        转发环境变量名白名单（只保存变量名，不保存密钥明文）
                      </label>
                      <Input
                        id={`ext-override-env-${item.id}`}
                        size="sm"
                        className="w-full"
                        aria-label={`${item.name} 转发环境变量名`}
                        placeholder="例如 DEEPSEEK_API_KEY, HTTPS_PROXY"
                        value={overrideDraft.envFromText}
                        onValueChange={(value) =>
                          setOverrideDraft({ ...overrideDraft, envFromText: value })
                        }
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {item.hasOverride && (
                        <Button
                          className="kapibala-action mr-auto"
                          variant="ghost"
                          size="sm"
                          disabled={busy || hostDown}
                          onClick={() => void resetBuiltin(item)}
                        >
                          恢复默认设置
                        </Button>
                      )}
                      <Button
                        className="kapibala-action"
                        variant="ghost"
                        size="sm"
                        onClick={() => setOverrideDraft(undefined)}
                      >
                        收起
                      </Button>
                      <Button
                        className="kapibala-action"
                        variant="primary"
                        size="sm"
                        disabled={busy || hostDown}
                        onClick={() => void saveBuiltinOverride(item)}
                      >
                        保存覆盖
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* 区域二：自定义 Local ACP Command 与 ACP 目录模板 */}
      <section
        className="space-y-3 border-t border-kumo-hairline pt-5"
        aria-label="自定义 ACP 代理"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-kumo-default">自定义与社区 ACP 代理</h3>
            <p className="text-xs text-kumo-subtle">
              通过标准输入输出（stdio NDJSON）接入任意兼容 Agent Client Protocol 的本机命令。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              className="kapibala-action"
              variant="secondary"
              size="sm"
              disabled={hostDown}
              onClick={() => setTemplatesOpen((open) => !open)}
            >
              <SparkleIcon size={14} />从 ACP 目录选择模板
            </Button>
            <Button
              className="kapibala-action"
              variant="primary"
              size="sm"
              disabled={hostDown}
              onClick={startBlankCustom}
            >
              <PlusIcon size={14} />
              添加自定义 ACP 代理
            </Button>
          </div>
        </div>

        {templatesOpen && (
          <div className="space-y-3 rounded-xl border border-kumo-line bg-kumo-base p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-kumo-subtle">
                选择社区 ACP 模板（点击自动回填至下方表单，仍可按本机路径修改）
              </span>
              <Button
                className="kapibala-action"
                variant="ghost"
                size="sm"
                onClick={() => setTemplatesOpen(false)}
              >
                关闭模板列表
              </Button>
            </div>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {templates.map((template) => (
                <div
                  key={template.registryId}
                  className="flex flex-col justify-between gap-2 rounded-lg border border-kumo-hairline bg-kumo-recessed p-3"
                >
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-kumo-default">{template.name}</span>
                      <code className="font-mono text-xs text-kumo-subtle">
                        {[template.command, ...template.args].join(' ')}
                      </code>
                    </div>
                    <p className="text-xs text-kumo-subtle">{template.description}</p>
                  </div>
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <InlineCopyText
                      value={template.installHint}
                      labels={{ copyAction: '复制安装命令', copied: '已复制' }}
                    >
                      <span className="text-xs text-kumo-subtle">复制安装命令</span>
                    </InlineCopyText>
                    <Button
                      className="kapibala-action"
                      variant="secondary"
                      size="sm"
                      aria-label={`选用 ${template.name} 模板`}
                      onClick={() => applyTemplate(template)}
                    >
                      选用模板
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {customDraft && (
          <div className="space-y-3 rounded-xl border border-kumo-line bg-kumo-base p-4">
            <h4 className="text-sm font-medium text-kumo-default">
              {customDraft.idLocked ? `编辑自定义代理 · ${customDraft.id}` : '新建自定义 ACP 代理'}
            </h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label
                  htmlFor="ext-custom-name"
                  className="block text-xs font-medium text-kumo-subtle"
                >
                  显示名称
                </label>
                <Input
                  id="ext-custom-name"
                  size="sm"
                  className="w-full"
                  aria-label="自定义代理显示名称"
                  placeholder="例如 Cline CLI"
                  value={customDraft.name}
                  onValueChange={(value) =>
                    setCustomDraft({
                      ...customDraft,
                      name: value,
                      id:
                        customDraft.idLocked || customDraft.idTouched
                          ? customDraft.id
                          : suggestHarnessId(value, new Set(harnesses.map((item) => item.id))),
                    })
                  }
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="ext-custom-id"
                  className="block text-xs font-medium text-kumo-subtle"
                >
                  代理标识 ID
                </label>
                <Input
                  id="ext-custom-id"
                  size="sm"
                  className="w-full"
                  aria-label="自定义代理标识 ID"
                  placeholder="例如 cline-acp"
                  disabled={customDraft.idLocked}
                  value={customDraft.id}
                  onValueChange={(value) =>
                    setCustomDraft({
                      ...customDraft,
                      id: value.toLowerCase(),
                      idTouched: true,
                    })
                  }
                />
              </div>
            </div>
            <div className="space-y-1">
              <label
                htmlFor="ext-custom-command"
                className="block text-xs font-medium text-kumo-subtle"
              >
                可执行命令或绝对路径
              </label>
              <Input
                id="ext-custom-command"
                size="sm"
                className="w-full"
                aria-label="自定义代理可执行命令"
                placeholder="例如 cline 或 C:\tools\my-agent.exe"
                value={customDraft.command}
                onValueChange={(value) => setCustomDraft({ ...customDraft, command: value })}
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor="ext-custom-args"
                className="block text-xs font-medium text-kumo-subtle"
              >
                启动参数（不经过 Shell 解析，每行作为一个独立参数原样传递）
              </label>
              <InputArea
                id="ext-custom-args"
                className="w-full"
                aria-label="自定义代理启动参数"
                minRows={2}
                maxRows={5}
                placeholder="acp"
                value={customDraft.argsText}
                onValueChange={(value) => setCustomDraft({ ...customDraft, argsText: value })}
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor="ext-custom-env"
                className="block text-xs font-medium text-kumo-subtle"
              >
                转发环境变量名（可选，只保存环境变量名，不保存密钥值）
              </label>
              <Input
                id="ext-custom-env"
                size="sm"
                className="w-full"
                aria-label="自定义代理转发环境变量名"
                placeholder="例如 OPENAI_API_KEY, ANTHROPIC_API_KEY"
                value={customDraft.envFromText}
                onValueChange={(value) => setCustomDraft({ ...customDraft, envFromText: value })}
              />
            </div>

            {draftProbe && (
              <div className="rounded-lg border border-kumo-hairline bg-kumo-recessed px-3 py-2 text-xs">
                {draftProbe.available ? (
                  <p className="flex items-center gap-1.5 text-kumo-success">
                    <CheckCircleIcon size={14} className="shrink-0" />
                    <span>
                      握手成功：{draftProbe.agentName ?? 'ACP Agent'}
                      {draftProbe.version ? ` · ${draftProbe.version}` : ''}（
                      {draftProbe.loadSupported ? '支持跨进程会话恢复' : '仅保留只读展示快照'}）
                    </span>
                  </p>
                ) : (
                  <p className="flex items-start gap-1.5 text-kumo-warning">
                    <WarningCircleIcon size={14} className="mt-0.5 shrink-0" />
                    <span>
                      未就绪（{probeBadge(draftProbe).label}）
                      {draftProbe.reason ? `：${draftProbe.reason}` : ''}
                    </span>
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                className="kapibala-action"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCustomDraft(undefined);
                  setDraftProbe(undefined);
                }}
              >
                取消编辑
              </Button>
              <Button
                className="kapibala-action"
                variant="secondary"
                size="sm"
                disabled={testingDraft || hostDown}
                onClick={() => void probeCustomDraft()}
              >
                <PlugsConnectedIcon size={14} />
                {testingDraft ? '握手中…' : '测试握手'}
              </Button>
              <Button
                className="kapibala-action"
                variant="primary"
                size="sm"
                disabled={busy || hostDown}
                onClick={() => void saveCustomDraft()}
              >
                保存代理
              </Button>
            </div>
          </div>
        )}

        {customHarnesses.length === 0 && !customDraft ? (
          <p className="rounded-xl border border-kumo-line bg-kumo-recessed px-4 py-3 text-xs text-kumo-subtle">
            尚未添加自定义 ACP 代理；可点击上方按钮手动配置，或从官方 ACP 目录选用模板。
          </p>
        ) : customHarnesses.length > 0 ? (
          <div className="divide-y divide-kumo-hairline overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
            {customHarnesses.map((item) => {
              const probe = probes[item.id] ?? item.probe;
              const badge = probeBadge(probe);
              const cacheInfo = describeHarnessCache(item);
              const commandPreview = [item.command, ...item.args].join(' ');
              const confirmingDelete = confirmDeleteId === item.id;
              return (
                <div
                  key={item.id}
                  className="space-y-2 px-4 py-3 transition-colors hover:bg-kumo-tint"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`text-sm font-medium ${
                            item.enabled ? 'text-kumo-default' : 'text-kumo-subtle'
                          }`}
                        >
                          {item.name}
                        </span>
                        <code className="rounded bg-kumo-recessed px-1.5 py-0.5 font-mono text-2xs text-kumo-subtle">
                          {item.id}
                        </code>
                        <span className={`rounded-md px-1.5 py-0.5 text-2xs ${badge.className}`}>
                          {badge.label}
                        </span>
                      </div>
                      <p
                        className="truncate font-mono text-xs text-kumo-subtle"
                        title={
                          item.envFrom.length > 0
                            ? `${commandPreview} · 透传变量：${item.envFrom.join(', ')}`
                            : commandPreview
                        }
                      >
                        {commandPreview}
                        {item.envFrom.length > 0 ? ` · 透传变量：${item.envFrom.join(', ')}` : ''}
                      </p>
                      <p className="text-xs text-kumo-subtle">{cacheInfo.summary}</p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Button
                        className="kapibala-action"
                        variant="secondary"
                        size="sm"
                        aria-label={`检测 ${item.name} 连接`}
                        disabled={
                          hostDown ||
                          testingId === item.id ||
                          refreshingCacheId === item.id ||
                          refreshingAllCaches
                        }
                        onClick={() => void runProbe(item)}
                      >
                        {testingId === item.id ? '检测中…' : '检测连接'}
                      </Button>
                      <Button
                        className="kapibala-action"
                        variant="ghost"
                        size="sm"
                        aria-label={`刷新 ${item.name} 模型缓存`}
                        disabled={
                          hostDown ||
                          testingId === item.id ||
                          refreshingCacheId === item.id ||
                          refreshingAllCaches
                        }
                        onClick={() => void refreshCache(item)}
                      >
                        <ArrowsClockwiseIcon size={14} />
                        {refreshingCacheId === item.id
                          ? '刷新中…'
                          : cacheInfo.cached
                            ? '刷新缓存'
                            : '拉取缓存'}
                      </Button>
                      <Button
                        className="kapibala-action"
                        variant="ghost"
                        size="sm"
                        aria-label={`编辑 ${item.name}`}
                        disabled={hostDown || busy}
                        onClick={() => editCustom(item)}
                      >
                        编辑
                      </Button>
                      {confirmingDelete ? (
                        <>
                          <Button
                            className="kapibala-action text-kumo-danger"
                            variant="secondary"
                            size="sm"
                            aria-label={`确认删除 ${item.name}`}
                            disabled={hostDown || busy}
                            onClick={() => void removeCustom(item)}
                          >
                            确认删除
                          </Button>
                          <Button
                            className="kapibala-action"
                            variant="ghost"
                            size="sm"
                            onClick={() => setConfirmDeleteId(undefined)}
                          >
                            取消
                          </Button>
                        </>
                      ) : (
                        <Button
                          className="kapibala-action text-kumo-subtle"
                          variant="ghost"
                          size="sm"
                          shape="square"
                          aria-label={`删除 ${item.name}`}
                          disabled={hostDown || busy}
                          onClick={() => setConfirmDeleteId(item.id)}
                        >
                          <TrashIcon size={15} />
                        </Button>
                      )}
                      <Switch
                        variant="neutral"
                        checked={item.enabled}
                        disabled={hostDown || busy}
                        aria-label={`启用 ${item.name}`}
                        onCheckedChange={(checked) => void toggleEnabled(item, checked)}
                      />
                    </div>
                  </div>
                  {probe?.reason && !probe.available && (
                    <p className="text-xs text-kumo-subtle">{probe.reason}</p>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
      </section>
    </div>
  );
}
