import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalBuiltinSection } from './ExternalBuiltinSection.js';
import { ExternalCustomSection } from './ExternalCustomSection.js';
import {
  type BuiltinOverrideDraft,
  type CustomHarnessDraft,
  type ExternalHarnessItem,
  type ExternalProbeResult,
  type ExternalTemplateItem,
  createBlankCustomHarnessDraft,
  describeHarnessCache,
  draftFromCustomHarness,
  draftFromTemplate,
  parseArgsLines,
  parseEnvNames,
  validateCustomHarnessDraft,
} from './external-helpers.js';
import { withSettingsWatchdog } from './settings-helpers.js';

/**
 * `ExternalHarnessesPage` 入参契约（017 §6.7 & §7）：
 * 组合 `ExternalBuiltinSection` 与 `ExternalCustomSection`，与 CLI `/external` 共用 `~/.kapibala/external/harnesses.json`。
 */
export interface ExternalHarnessesPageProps {
  readonly active?: boolean;
  readonly workspaceId?: string;
  readonly hostDown?: boolean;
  readonly report?: (message: string) => void;
  readonly initialHarnesses?: readonly ExternalHarnessItem[];
  readonly initialTemplates?: readonly ExternalTemplateItem[];
}

/**
 * 壳内设置中心「外部代理」页面（`max-width: 960px`）。
 */
export function ExternalHarnessesPage({
  active = true,
  workspaceId,
  hostDown = false,
  report,
  initialHarnesses = [],
  initialTemplates = [],
}: ExternalHarnessesPageProps) {
  const [harnesses, setHarnesses] = useState<readonly ExternalHarnessItem[]>(initialHarnesses);
  const [templates, setTemplates] = useState<readonly ExternalTemplateItem[]>(initialTemplates);
  const [probes, setProbes] = useState<Record<string, ExternalProbeResult>>({});
  const [testingId, setTestingId] = useState<string>();
  const [refreshingCacheId, setRefreshingCacheId] = useState<string>();
  const [refreshingAllCaches, setRefreshingAllCaches] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [panelError, setPanelError] = useState('');
  const [overrideDraft, setOverrideDraft] = useState<BuiltinOverrideDraft>();
  const [customDraft, setCustomDraft] = useState<CustomHarnessDraft>();
  const [draftProbe, setDraftProbe] = useState<ExternalProbeResult>();
  const [testingDraft, setTestingDraft] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchHarnesses = useCallback(async (): Promise<
    readonly ExternalHarnessItem[] | undefined
  > => {
    if (hostDown || typeof window === 'undefined' || !window.kapibala) return undefined;
    try {
      const result = await window.kapibala.external.harnesses(workspaceId);
      if (!mountedRef.current) return undefined;
      setHarnesses(result.harnesses);
      setTemplates(result.templates);
      return result.harnesses;
    } catch (error) {
      if (!mountedRef.current) return undefined;
      const msg = error instanceof Error ? error.message : '读取外部代理列表失败。';
      setPanelError(msg);
      report?.(msg);
      return undefined;
    }
  }, [hostDown, report, workspaceId]);

  useEffect(() => {
    if (active) void fetchHarnesses();
  }, [active, fetchHarnesses]);

  const builtinHarnesses = useMemo(() => harnesses.filter((item) => item.builtin), [harnesses]);
  const customHarnesses = useMemo(() => harnesses.filter((item) => !item.builtin), [harnesses]);
  const allHarnessIds = useMemo(() => new Set(harnesses.map((item) => item.id)), [harnesses]);

  async function mutateCatalog(options: {
    readonly request: () => Promise<{ readonly harnesses: readonly ExternalHarnessItem[] }>;
    readonly timeoutMsg: string;
    readonly fallbackErr: string;
    readonly reportOnError?: boolean;
    readonly onSuccess: () => void;
  }): Promise<void> {
    if (busy || hostDown || typeof window === 'undefined' || !window.kapibala) return;
    setBusy(true);
    setPanelError('');
    setNotice('');
    try {
      const updated = await withSettingsWatchdog(options.request(), options.timeoutMsg);
      if (!mountedRef.current) return;
      setHarnesses(updated.harnesses);
      options.onSuccess();
    } catch (error) {
      if (!mountedRef.current) return;
      const msg = error instanceof Error ? error.message : options.fallbackErr;
      setPanelError(msg);
      if (options.reportOnError) report?.(msg);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  function dropCachedProbe(harnessId: string): void {
    setProbes((prev) => {
      const { [harnessId]: _dropped, ...rest } = prev;
      return rest;
    });
  }

  async function runProbe(item: ExternalHarnessItem): Promise<void> {
    if (testingId || refreshingCacheId || refreshingAllCaches || hostDown) return;
    if (typeof window === 'undefined' || !window.kapibala) return;
    setTestingId(item.id);
    setPanelError('');
    try {
      const result = await withSettingsWatchdog(
        window.kapibala.external.testHarness({ id: item.id, workspaceId }),
        `检测 ${item.name} 超时，请检查本机命令是否可正常响应。`,
        25_000,
      );
      if (!mountedRef.current) return;
      setProbes((prev) => ({ ...prev, [item.id]: result }));
      await fetchHarnesses();
    } catch (error) {
      if (mountedRef.current) {
        setPanelError(error instanceof Error ? error.message : '检测连接失败。');
      }
    } finally {
      if (mountedRef.current) setTestingId(undefined);
    }
  }

  async function refreshCache(item: ExternalHarnessItem): Promise<void> {
    if (testingId || refreshingCacheId || refreshingAllCaches || hostDown) return;
    if (typeof window === 'undefined' || !window.kapibala) return;
    setRefreshingCacheId(item.id);
    setPanelError('');
    setNotice('');
    try {
      const result = await withSettingsWatchdog(
        window.kapibala.external.testHarness({ id: item.id, workspaceId }),
        `刷新 ${item.name} 模型缓存超时。`,
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
      const refreshed = latest?.find((entry) => entry.id === item.id);
      const info = refreshed ? describeHarnessCache(refreshed) : undefined;
      setNotice(
        info && info.modelCount > 0
          ? `已刷新 ${item.name} 本地缓存（共 ${info.modelCount} 个模型）。`
          : `已刷新 ${item.name} 本地配置缓存。`,
      );
    } catch (error) {
      if (mountedRef.current) {
        setPanelError(error instanceof Error ? error.message : '刷新模型缓存失败。');
      }
    } finally {
      if (mountedRef.current) setRefreshingCacheId(undefined);
    }
  }

  async function refreshAllEnabledCaches(): Promise<void> {
    if (testingId || refreshingCacheId || refreshingAllCaches || hostDown) return;
    if (typeof window === 'undefined' || !window.kapibala) return;
    const enabled = harnesses.filter((item) => item.enabled);
    if (enabled.length === 0) return;
    setRefreshingAllCaches(true);
    setPanelError('');
    setNotice('');
    let succeeded = 0;
    try {
      for (const item of enabled) {
        if (!mountedRef.current) return;
        setRefreshingCacheId(item.id);
        try {
          const res = await withSettingsWatchdog(
            window.kapibala.external.testHarness({ id: item.id, workspaceId }),
            `刷新 ${item.name} 模型缓存超时。`,
            25_000,
          );
          if (!mountedRef.current) return;
          setProbes((prev) => ({ ...prev, [item.id]: res }));
          if (res.available) succeeded += 1;
        } catch {
          // 单个 CLI 异常不阻断其余已启用代理同步
        }
      }
      await fetchHarnesses();
      if (mountedRef.current) {
        setNotice(`已同步 ${succeeded}/${enabled.length} 个已启用外部代理的本地缓存。`);
      }
    } finally {
      if (mountedRef.current) {
        setRefreshingCacheId(undefined);
        setRefreshingAllCaches(false);
      }
    }
  }

  async function probeCustomDraft(): Promise<void> {
    if (!customDraft || testingDraft || hostDown) return;
    if (typeof window === 'undefined' || !window.kapibala) return;
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
      const res = await withSettingsWatchdog(
        window.kapibala.external.testHarness({
          workspaceId,
          draft: {
            name: customDraft.name.trim() || customDraft.id.trim() || '自定义代理',
            command,
            args: parseArgsLines(customDraft.argsText),
            envFrom: parsedEnv.names,
          },
        }),
        '握手测试超时，请确认命令支持标准输入输出 ACP 协议。',
        25_000,
      );
      if (mountedRef.current) setDraftProbe(res);
    } catch (error) {
      if (mountedRef.current) {
        setPanelError(error instanceof Error ? error.message : '测试握手失败。');
      }
    } finally {
      if (mountedRef.current) setTestingDraft(false);
    }
  }

  function handleSaveBuiltinOverride(item: ExternalHarnessItem): void {
    if (!overrideDraft || overrideDraft.id !== item.id) return;
    const parsedEnv = parseEnvNames(overrideDraft.envFromText);
    if (parsedEnv.error) {
      setPanelError(parsedEnv.error);
      return;
    }
    void mutateCatalog({
      request: () =>
        window.kapibala.external.saveHarness({
          id: item.id,
          builtin: true,
          command: overrideDraft.command.trim(),
          args: parseArgsLines(overrideDraft.argsText),
          envFrom: parsedEnv.names,
        }),
      timeoutMsg: '保存覆盖设置超时。',
      fallbackErr: '保存覆盖设置失败。',
      onSuccess: () => {
        dropCachedProbe(item.id);
        setOverrideDraft(undefined);
        setNotice(`已保存 ${item.name} 的配置覆盖。`);
      },
    });
  }

  function handleSaveCustomDraft(): void {
    if (!customDraft) return;
    const check = validateCustomHarnessDraft(
      customDraft,
      builtinHarnesses,
      customHarnesses,
      allHarnessIds,
    );
    if (!check.ok) {
      setPanelError(check.error);
      return;
    }
    void mutateCatalog({
      request: () => window.kapibala.external.saveHarness(check.payload),
      timeoutMsg: '保存自定义代理超时。',
      fallbackErr: '保存自定义代理失败。',
      onSuccess: () => {
        setCustomDraft(undefined);
        setDraftProbe(undefined);
        setNotice(`已保存自定义 ACP 代理「${check.payload.name}」。`);
      },
    });
  }

  return (
    <div className="kpbl-settings-stack">
      {notice ? (
        <output className="kpbl-settings-banner" data-tone="success">
          <span>{notice}</span>
        </output>
      ) : null}
      {panelError ? (
        <div role="alert" className="kpbl-settings-banner" data-tone="danger">
          <span>{panelError}</span>
        </div>
      ) : null}

      <ExternalBuiltinSection
        builtinHarnesses={builtinHarnesses}
        anyEnabled={harnesses.some((item) => item.enabled)}
        probes={probes}
        overrideDraft={overrideDraft}
        testingId={testingId}
        refreshingCacheId={refreshingCacheId}
        refreshingAllCaches={refreshingAllCaches}
        busy={busy}
        hostDown={hostDown}
        onRefreshAllCaches={() => void refreshAllEnabledCaches()}
        onRunProbe={(item) => void runProbe(item)}
        onRefreshCache={(item) => void refreshCache(item)}
        onToggleEnabled={(item, enabled) =>
          void mutateCatalog({
            request: () => window.kapibala.external.toggleHarness({ id: item.id, enabled }),
            timeoutMsg: '更新外部代理状态超时。',
            fallbackErr: '更新状态失败。',
            reportOnError: true,
            onSuccess: () => setNotice(enabled ? `已启用 ${item.name}。` : `已停用 ${item.name}。`),
          })
        }
        onChangeOverrideDraft={setOverrideDraft}
        onSaveOverride={handleSaveBuiltinOverride}
        onResetBuiltin={(item) =>
          void mutateCatalog({
            request: () => window.kapibala.external.resetHarness(item.id),
            timeoutMsg: '恢复默认设置超时。',
            fallbackErr: '恢复默认配置失败。',
            onSuccess: () => {
              dropCachedProbe(item.id);
              if (overrideDraft?.id === item.id) setOverrideDraft(undefined);
              setNotice(`已恢复 ${item.name} 的默认配置。`);
            },
          })
        }
      />

      <ExternalCustomSection
        allHarnessIds={allHarnessIds}
        customHarnesses={customHarnesses}
        templates={templates}
        probes={probes}
        customDraft={customDraft}
        draftProbe={draftProbe}
        testingDraft={testingDraft}
        testingId={testingId}
        refreshingCacheId={refreshingCacheId}
        refreshingAllCaches={refreshingAllCaches}
        busy={busy}
        hostDown={hostDown}
        onChangeDraft={(next) => {
          setCustomDraft(next);
          if (!next) setDraftProbe(undefined);
        }}
        onApplyTemplate={(template) => {
          setDraftProbe(undefined);
          setPanelError('');
          setCustomDraft(draftFromTemplate(template, customHarnesses));
        }}
        onStartBlankCustom={() => {
          setDraftProbe(undefined);
          setPanelError('');
          setCustomDraft(createBlankCustomHarnessDraft());
        }}
        onEditCustom={(item) => {
          setDraftProbe(undefined);
          setPanelError('');
          setCustomDraft(draftFromCustomHarness(item));
        }}
        onProbeDraft={() => void probeCustomDraft()}
        onSaveDraft={handleSaveCustomDraft}
        onRunProbe={(item) => void runProbe(item)}
        onRefreshCache={(item) => void refreshCache(item)}
        onToggleEnabled={(item, enabled) =>
          void mutateCatalog({
            request: () => window.kapibala.external.toggleHarness({ id: item.id, enabled }),
            timeoutMsg: '更新外部代理状态超时。',
            fallbackErr: '更新状态失败。',
            reportOnError: true,
            onSuccess: () => setNotice(enabled ? `已启用 ${item.name}。` : `已停用 ${item.name}。`),
          })
        }
        onRemoveCustom={(item) =>
          void mutateCatalog({
            request: () => window.kapibala.external.deleteHarness(item.id),
            timeoutMsg: '删除自定义代理超时。',
            fallbackErr: '删除自定义代理失败。',
            onSuccess: () => {
              if (customDraft?.id === item.id) {
                setCustomDraft(undefined);
                setDraftProbe(undefined);
              }
              setNotice(`已删除自定义代理「${item.name}」。`);
            },
          })
        }
      />
    </div>
  );
}
