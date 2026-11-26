import { Button, InlineCopyText, Input, Select, SensitiveInput, Switch } from '@cloudflare/kumo';
import { Dialog } from '@cloudflare/kumo/primitives/dialog';
import { Tabs } from '@cloudflare/kumo/primitives/tabs';
import {
  ArchiveIcon,
  ArrowLeftIcon,
  PackageIcon,
  PaletteIcon,
  PlugsConnectedIcon,
  PulseIcon,
  ShieldCheckIcon,
  ShuffleIcon,
  TerminalWindowIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Output, ProfileDraft, Workspace } from '../shared/contracts.js';
import type { Inspection } from '../shared/observations.js';
import { ExternalSettingsPanel } from './external-settings-panel.js';
import type { SessionTarget } from './session-actions.js';

type Catalog = Output<'settings.read'>;
type Model = Catalog['profiles'][number];
type McpCatalog = Output<'resources.readMcp'>;
type McpServerView = McpCatalog['servers'][number];
type SkillsCatalog = Output<'resources.readSkills'>;
type SkillImportScanView = Output<'resources.inspectSkills'>;
type SkillImportResultView = Output<'resources.importSkills'>;
type McpImportScanView = Output<'resources.inspectMcpImport'>;
type McpImportResultView = Output<'resources.importMcp'>;
/** 候选唯一键：同名条目可来自多个 Harness，必须带来源才不串选（技能与 MCP 共用）。 */
function importKey(item: { harness: string; name: string }): string {
  return `${item.harness}:${item.name}`;
}
/** MCP 编辑表单的草稿形态；args 以空白分隔输入，提交时按空白切分。 */
type McpFormDraft = {
  editName?: string;
  /** 写入目标；编辑时沿用原声明来源，新增时由用户选择（未受信项目只有全局）。 */
  scope: 'global' | 'project';
  name: string;
  type: 'stdio' | 'http';
  command: string;
  args: string;
  url: string;
  /** 快照未提供未脱敏回填面（目标串内嵌密钥）时置位：传输字段锁定，只允许改名。 */
  keepTransport?: boolean;
};
/** 自定义模型表单的字段级错误；键与必填输入一一对应，空对象表示无错误。 */
type CustomFieldErrors = Partial<Record<'baseURL' | 'modelName' | 'apiKey', string>>;
/**
 * 给页面级操作加一层看门狗。
 *
 * RPC 框架只在拿到控制通路后才启动 30 秒超时；宿主被重建或握手未完成时，
 * `call` 会一直挂在 `ready` 上，页面就会永远停在「保存中」。
 * 这里只负责让按钮和关闭入口回到可用状态，底层请求不会被取消，迟到的结果由调用方丢弃。
 */
function withWatchdog<T>(task: Promise<T>, message: string, ms = 10_000): Promise<T> {
  return Promise.race([
    task,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}
/** 下载失败原因码转成可执行中文；未知原因保留原始码与细节，便于排查。 */
function describeDownloadFailure(reason: string, detail?: string): string {
  if (reason === 'NO_UPDATE_STATE') return '请先重新检查更新，再下载。';
  if (reason === 'DOWNLOAD_IN_PROGRESS') return '已有下载正在进行。';
  if (reason === 'UNTRUSTED_SOURCE') return '下载地址不是受信任的发布源，已拒绝。';
  if (reason === 'CHECKSUM_FETCH_FAILED')
    return `无法获取 SHA256 校验清单，已取消下载${detail ? `（${detail}）` : ''}。`;
  if (reason === 'CHECKSUM_MISSING') return '发布包缺少该安装包的 SHA256 摘要，已拒绝下载。';
  if (reason === 'CHECKSUM_MISMATCH') return '安装包 SHA256 校验不一致，已删除下载文件，请重试。';
  if (reason === 'INVALID_ASSET_NAME') return '安装包文件名不合法，已拒绝下载。';
  return `下载失败${detail ? `（${detail}）` : ''}，可重试或到发布页手动下载。`;
}
/** 下载进度只做粗粒度展示，KB/MB 足够；总大小未知时由调用方换文案。 */
function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
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
    value: 'external',
    label: '外部代理',
    icon: TerminalWindowIcon,
    subtitle: '连接本机 Claude Code、Codex、Antigravity、OpenCode 等外部 CLI 代理。',
  },
  {
    value: 'permission',
    label: '权限审批',
    icon: ShieldCheckIcon,
    subtitle: '新建会话的默认审批档位；已打开的会话各自记住上次选择。',
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
/**
 * 全局默认审批档位：与输入框菜单同文案，但刻意不提供「完全访问」。
 * 配置层只允许常规档位，完全访问必须由本次会话显式确认后启用。
 */
const PERMISSION_OPTIONS = [
  { mode: 'Plan', label: '计划模式', hint: '编辑前先出计划。' },
  { mode: 'Approval', label: '变更前确认', hint: '改文件前先问我。' },
  {
    mode: 'Auto',
    label: '自主模式',
    hint: '文件读写与常见只读命令自动执行；写入类、网络类与无法识别的命令仍会询问。',
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
    vendorName: model.vendorName,
    disabled: model.disabled,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    supportsThinking: model.supportsThinking,
  };
}
/**
 * 上下文窗口与输出上限的常用刻度。
 *
 * 点击只写入数值，输入框仍可手填：端点的真实容量没有统一接口可查，预设是提示而非枚举。
 * 窗口档位对齐主流模型的实际容量，输出档位覆盖长生成任务，避免用户被默认 4096 截断。
 */
const CONTEXT_WINDOW_PRESETS = [128_000, 256_000, 500_000, 1_000_000] as const;
const OUTPUT_TOKEN_PRESETS = [8_000, 16_000, 32_000, 64_000] as const;

/** 预设芯片的显示名：百万级用 M，其余用 k，与配置文档的十进制写法一致。 */
function presetLabel(tokens: number): string {
  return tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${tokens / 1000}k`;
}

/** 数值预设芯片组：只负责把刻度写回表单，选中态与输入框当前值联动。 */
function TokenPresets({
  label,
  value,
  presets,
  disabled,
  onPick,
}: {
  label: string;
  value: number | undefined;
  presets: readonly number[];
  disabled: boolean;
  onPick(tokens: number): void;
}) {
  return (
    <fieldset className="m-0 flex flex-wrap items-center gap-1.5 border-0 p-0">
      <legend className="sr-only">{label}</legend>
      {presets.map((tokens) => (
        <Button
          key={tokens}
          className={
            tokens === value
              ? 'kapibala-action text-kumo-brand'
              : 'kapibala-action text-kumo-subtle'
          }
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-pressed={tokens === value}
          onClick={() => onPick(tokens)}
        >
          {presetLabel(tokens)}
        </Button>
      ))}
    </fieldset>
  );
}

/** 新建自定义模型的最小草稿：只要求端点与模型名，窗口留空由保存时探测回填或按统一默认值估算。 */
function blankCustomDraft(): ProfileDraft {
  return {
    id: `custom-${crypto.randomUUID().slice(0, 8)}`,
    name: '',
    provider: 'openai-compatible',
    modelName: '',
    baseURL: '',
    apiKeyEnv: 'CUSTOM_API_KEY',
    vendorName: '',
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
  inspection,
  initialTab,
  onInitialTabConsumed,
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
  /** 当前会话的运行时观察；MCP 连接状态与 `/mcp` 同源，未打开会话时缺省。 */
  inspection?: Inspection;
  /** 外部入口直达某个设置分类（如新建外部会话弹窗直达「外部代理」）；打开并切换后立即回调清除。 */
  initialTab?: string;
  onInitialTabConsumed?(): void;
}) {
  const [info, setInfo] = useState<Output<'app.getInfo'>>();
  /** 更新检查只在用户点按钮时发生；结果只保留最近一次，不做轮询或缓存。 */
  const [updateCheck, setUpdateCheck] = useState<Output<'app.checkUpdate'>>();
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState('');
  /**
   * 下载进度与最终结果跨弹窗开关保留，直到下次检查/下载被替换；组件常驻渲染，状态不随弹窗
   * 卸载丢失。刻意不重置：关闭再打开时用户仍能看到在途下载的进度与结果，不会丢视图。
   */
  const [updateProgress, setUpdateProgress] = useState<{ downloaded: number; total: number }>();
  const [updateDownload, setUpdateDownload] = useState<Output<'app.downloadUpdate'>>();
  const [downloading, setDownloading] = useState(false);
  const [tab, setTab] = useState('models');
  useEffect(() => {
    if (!open || !initialTab) return;
    setTab(initialTab);
    onInitialTabConsumed?.();
  }, [open, initialTab, onInitialTabConsumed]);
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
  /**
   * 下载进度由主进程节流推送；只更新进度展示，不改变检查结果与按钮状态。
   * 订阅按 open 门控：弹窗关闭期间摘除订阅，推送不落状态、不触发整页重渲染；
   * 进度状态本身跨开关保留，重开弹窗后由下一次推送（最迟 200ms）续上。
   */
  useEffect(() => {
    if (!open) return;
    return window.kapibala.onEvent((event) => {
      if (event.type === 'update.downloadProgress')
        setUpdateProgress({ downloaded: event.downloaded, total: event.total });
    });
  }, [open]);
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
  /**
   * 技能导入抽屉：只在打开时扫描一次（设计 009 §10.1），不预热、不轮询外部目录。
   * 全部写操作经 host 的导入服务完成，渲染层不直接落盘。
   */
  const [importOpen, setImportOpen] = useState(false);
  const [importScan, setImportScan] = useState<SkillImportScanView>();
  const [importSelected, setImportSelected] = useState<ReadonlySet<string>>(new Set());
  const [importScope, setImportScope] = useState<'global' | 'project'>('global');
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState('');
  const [importResult, setImportResult] = useState<SkillImportResultView>();
  /** 打开导入抽屉或切换目标作用域时扫描来源；默认全选，冲突项仍可勾选但执行时会被跳过。 */
  const scanSkillImport = useCallback(
    (scope: 'global' | 'project') => {
      if (!workspaceId) return;
      setImportScan(undefined);
      setImportResult(undefined);
      setImportError('');
      setImportBusy(true);
      void withWatchdog(
        window.kapibala.resources.inspectSkills(workspaceId, scope),
        '技能来源扫描超时',
        30_000,
      )
        .then((scan) => {
          setImportScan(scan);
          setImportSelected(new Set(scan.candidates.map(importKey)));
        })
        .catch((error) => setImportError((error as Error).message))
        .finally(() => setImportBusy(false));
    },
    [workspaceId],
  );
  const openImportDrawer = useCallback(() => {
    if (!workspaceId) return;
    setImportOpen(true);
    setImportScope('global');
    scanSkillImport('global');
  }, [workspaceId, scanSkillImport]);
  function toggleImportCandidate(key: string): void {
    setImportSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  /** 执行导入：只传来源身份；失败项保留在列表里可调整后重试。 */
  function runImport(): void {
    if (!workspaceId || !importScan || importBusy) return;
    const items = importScan.candidates
      .filter((item) => importSelected.has(importKey(item)))
      .map((item) => ({
        harness: item.harness,
        name: item.name,
        expectedSourceRef: item.sourceRef,
      }));
    if (!items.length) {
      setImportError('请至少选择一个候选技能。');
      return;
    }
    setImportBusy(true);
    setImportError('');
    void withWatchdog(
      window.kapibala.resources.importSkills({ workspaceId, scope: importScope, items }),
      '技能导入超时',
      30_000,
    )
      .then((result) => {
        setImportResult(result);
        loadResources();
      })
      .catch((error) => setImportError((error as Error).message))
      .finally(() => setImportBusy(false));
  }
  /**
   * MCP 导入抽屉：打开时扫描一次；切换目标作用域要重新扫描，因为冲突判定取决于目标配置。
   * 与技能导入同理，写操作全部经宿主服务，页面不直接落盘。
   */
  const [mcpImportOpen, setMcpImportOpen] = useState(false);
  const [mcpImportScan, setMcpImportScan] = useState<McpImportScanView>();
  const [mcpImportSelected, setMcpImportSelected] = useState<ReadonlySet<string>>(new Set());
  const [mcpImportScope, setMcpImportScope] = useState<'global' | 'project'>('global');
  const [mcpImportOverwrite, setMcpImportOverwrite] = useState(false);
  const [mcpImportBusy, setMcpImportBusy] = useState(false);
  const [mcpImportError, setMcpImportError] = useState('');
  const [mcpImportResult, setMcpImportResult] = useState<McpImportResultView>();
  /** 扫描外部 MCP 声明；默认全选，冲突项仍可勾选但执行时按 overwrite 决定是否跳过。 */
  const scanMcpImport = useCallback(
    (scope: 'global' | 'project') => {
      if (!workspaceId) return;
      setMcpImportScan(undefined);
      setMcpImportResult(undefined);
      setMcpImportError('');
      setMcpImportBusy(true);
      void withWatchdog(
        window.kapibala.resources.inspectMcpImport({ workspaceId, scope }),
        'MCP 来源扫描超时',
        30_000,
      )
        .then((scan) => {
          setMcpImportScan(scan);
          setMcpImportSelected(new Set(scan.candidates.map(importKey)));
        })
        .catch((error) => setMcpImportError((error as Error).message))
        .finally(() => setMcpImportBusy(false));
    },
    [workspaceId],
  );
  function openMcpImportDrawer(): void {
    setMcpImportOpen(true);
    setMcpImportScope('global');
    setMcpImportOverwrite(false);
    scanMcpImport('global');
  }
  function toggleMcpImportCandidate(key: string): void {
    setMcpImportSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  /** 执行导入：只传来源身份；失败项保留在列表里可调整后重试。 */
  function runMcpImport(): void {
    if (!workspaceId || !mcpImportScan || mcpImportBusy) return;
    const items = mcpImportScan.candidates
      .filter((item) => mcpImportSelected.has(importKey(item)))
      .map((item) => ({
        harness: item.harness,
        name: item.name,
        expectedSourceRef: item.sourceRef,
      }));
    if (!items.length) {
      setMcpImportError('请至少选择一个候选服务器。');
      return;
    }
    setMcpImportBusy(true);
    setMcpImportError('');
    void withWatchdog(
      window.kapibala.resources.importMcp({
        workspaceId,
        scope: mcpImportScope,
        items,
        ...(mcpImportOverwrite ? { overwrite: true } : {}),
      }),
      'MCP 导入超时',
      30_000,
    )
      .then((result) => {
        setMcpImportResult(result);
        loadResources();
      })
      .catch((error) => setMcpImportError((error as Error).message))
      .finally(() => setMcpImportBusy(false));
  }
  /**
   * 检查更新：只在用户点按钮时调用一次网络，不轮询、不在启动时自动联网。
   * 网络 / 解析异常由主进程降级为 `unknown`；这里只兜住控制通路超时。
   */
  function checkUpdate(): void {
    if (updateBusy) return;
    setUpdateBusy(true);
    setUpdateError('');
    void withWatchdog(window.kapibala.app.checkUpdate(), '检查更新超时', 20_000)
      .then(setUpdateCheck)
      .catch((error) => setUpdateError((error as Error).message))
      .finally(() => setUpdateBusy(false));
  }
  /** 发布页链接交给主进程校验协议后打开；空值直接忽略。 */
  function openReleasePage(url: string | undefined): void {
    if (url) void window.kapibala.app.openExternal(url);
  }
  /**
   * 下载安装包：主进程按上次检查结果流式下载、比对 SHA256，通过后才打开。
   * 不做自动重试；失败后用户可以再次点击，重新走完整下载与校验。
   */
  function startDownload(): void {
    if (downloading) return;
    setDownloading(true);
    setUpdateError('');
    setUpdateDownload(undefined);
    setUpdateProgress(undefined);
    void window.kapibala.app
      .downloadUpdate()
      .then(setUpdateDownload)
      .catch((error) => setUpdateError((error as Error).message))
      .finally(() => {
        setDownloading(false);
        setUpdateProgress(undefined);
      });
  }
  /** 取消在途下载：主进程删除临时文件并让下载请求返回 cancelled。 */
  function cancelDownload(): void {
    void window.kapibala.app.cancelUpdateDownload().catch(() => {});
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
  /** 探测序号：切换厂商/模型或重新探测后自增，迟到的旧请求结果直接丢弃。 */
  const probeToken = useRef(0);
  /** 探测失败或列表为空时退回手填模型名，避免被一次网络错误卡死。 */
  const [manualModel, setManualModel] = useState(false);
  const [notice, setNotice] = useState('');
  /** 默认审批档位的写入中状态：与模型保存分开，避免互相锁住按钮。 */
  const [permissionSaving, setPermissionSaving] = useState(false);
  /** 正在测试连接的模型 id；只锁该行按钮，其余行仍可操作。 */
  const [testingId, setTestingId] = useState<string>();
  /** 最近一次测试结果；切换厂商或模型时清空，避免结论串到别的模型。 */
  const [testState, setTestState] = useState<{ id: string; ok: boolean; message: string }>();
  /** 自定义表单的字段级校验：保存时才点亮必填项红框与行内提示，避免一进来就满屏报错。 */
  const [fieldErrors, setFieldErrors] = useState<CustomFieldErrors>({});
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('light');
  const initialized = useRef(false);
  const retriedCatalogOnOpen = useRef(false);
  useEffect(() => {
    if (!open) {
      initialized.current = false;
      retriedCatalogOnOpen.current = false;
      setKey('');
      setNotice('');
      setFieldErrors({});
      setModels(undefined);
      setFetchStatus('');
      setManualModel(false);
    } else if (!catalog && !hostDown && !retriedCatalogOnOpen.current) {
      retriedCatalogOnOpen.current = true;
      void reload().catch((error) =>
        report(error instanceof Error ? error.message : '读取模型配置失败，请重试。'),
      );
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
  }, [open, catalog, hostDown, reload, report]);
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
  /**
   * 搜索同时命中厂商名与模型名/显示名。
   * 排序按配置状态分层：默认模型所在厂商最前，其余已配置厂商其次，未配置与全部停用的厂商
   * 排到最后；内置清单顺序把「本地 Ollama」放在自定义分组之前，停用后自然沉到最后一位。
   * 只有「已配置靠前」才能让刚保存的自定义厂商不被一长串未配置内置厂商淹没。
   */
  const defaultProviderKey = useMemo(
    () => catalog?.profiles.find((item) => item.id === catalog.defaultModel)?.providerKey,
    [catalog],
  );
  const visibleProviders = useMemo(() => {
    const query = search.trim().toLowerCase();
    const all = catalog?.providers ?? [];
    const filtered = query
      ? all.filter(
          (meta) =>
            meta.name.toLowerCase().includes(query) ||
            (groupedModels.get(meta.key) ?? []).some(
              (item) =>
                item.name.toLowerCase().includes(query) ||
                item.modelName.toLowerCase().includes(query),
            ),
        )
      : all;
    const rank = (key: string) => {
      if (key === defaultProviderKey) return 0;
      const models = groupedModels.get(key) ?? [];
      // 全部停用的厂商（如本机未装 Ollama）不按「有密钥」靠前，按未配置层沉底。
      if (models.length > 0 && models.every((item) => item.disabled)) return 2;
      return models.some((item) => item.credential.configured) ? 1 : 2;
    };
    return [...filtered].sort((a, b) => rank(a.key) - rank(b.key));
  }, [catalog, groupedModels, search, defaultProviderKey]);
  /** 厂商列表滚动容器：保存后需要把新分组滚进视野。 */
  const modelsListRef = useRef<HTMLDivElement>(null);
  // 自动排序会改变分组位置；保存或切换后把当前厂商滚进视野，避免看起来「没新增」。
  useEffect(() => {
    if (!open) return;
    const node = modelsListRef.current?.querySelector<HTMLElement>(
      `[data-provider-key="${providerSel}"]`,
    );
    node?.scrollIntoView({ block: 'nearest' });
  }, [open, providerSel]);
  /** 组内模型按「默认模型 → 已配置 → 其它 → 已停用」排序，停用项沉底但仍可见可恢复。 */
  const providerModels = useMemo(() => {
    const rank = (item: Model) => {
      if (item.id === catalog?.defaultModel) return 0;
      if (item.disabled) return 3;
      return item.credential.configured ? 1 : 2;
    };
    return [...(groupedModels.get(providerSel) ?? [])].sort((a, b) => rank(a) - rank(b));
  }, [catalog, groupedModels, providerSel]);
  const providerMeta = (catalog?.providers ?? []).find((item) => item.key === providerSel);
  /** 自建端点分组（含用户命名的厂商与通用兜底桶）才放开端点、厂商名与协议编辑。 */
  const customGroup = Boolean(providerMeta?.custom) || providerSel === 'custom';
  /** 探测状态属于「正在编辑的端点」，切换厂商或模型时一并清空，避免串到别的表单。 */
  function resetProbe() {
    probeToken.current += 1;
    setFetching(false);
    setModels(undefined);
    setFetchStatus('');
    setManualModel(false);
    setTestState(undefined);
  }
  /** 切换厂商时优先带入已配置密钥的模型；项目级模型不能在本页编辑，自动选中只考虑全局条目。 */
  function selectProvider(key: string) {
    setProviderSel(key);
    const list = groupedModels.get(key) ?? [];
    const model =
      list.find((item) => item.scope === 'global' && item.credential.configured) ??
      list.find((item) => item.scope === 'global');
    const meta = (catalog?.providers ?? []).find((item) => item.key === key);
    setSelected(model);
    setDraft(model ? draftOf(model) : meta?.custom ? blankCustomDraft() : undefined);
    setKey('');
    setFieldErrors({});
    resetProbe();
  }
  /**
   * 新增自定义模型：默认归入通用「自定义端点 / 其它」。
   * 从某个已命名厂商分组里新增时带入厂商名，避免用户为同一网关重复填写。
   */
  function newCustomModel() {
    const draft = blankCustomDraft();
    if (customGroup && providerSel !== 'custom' && providerMeta)
      draft.vendorName = providerMeta.name;
    setProviderSel(providerSel !== 'custom' && customGroup ? providerSel : 'custom');
    setSelected(undefined);
    setDraft(draft);
    setKey('');
    setFieldErrors({});
    resetProbe();
  }
  /**
   * 测试连接：探测运行中只锁该行按钮。
   *
   * host 已用已存凭证发 GET /models 并在 8 秒内收口，失败也以 ok=false 正常返回，
   * 这里只把结果落到行下方，不弹错误对话框。
   */
  async function testModel(item: Model) {
    setTestingId(item.id);
    setTestState(undefined);
    try {
      const result = await withWatchdog(
        window.kapibala.settings.testProfile(item.id),
        '测试超时：Host 可能已断开，请重启应用后重试。',
        12_000,
      );
      setTestState({ id: item.id, ...result });
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
  /**
   * 启用/停用模型：只写开关，已存密钥与表单草稿的其它字段保持不变。
   *
   * 被停用的就是当前编辑项时同步草稿里的 disabled，否则下一次保存会把开关改回去。
   */
  async function toggleModel(item: Model, enabled: boolean) {
    setBusy(true);
    try {
      await withWatchdog(
        window.kapibala.settings.setEnabled({ profileId: item.id, enabled }),
        '操作超时：Host 可能已断开，请重启应用后重试。',
      );
      if (selected?.id === item.id) {
        setSelected({ ...item, disabled: !enabled });
        change('disabled', !enabled);
      }
      await reload();
      setNotice(enabled ? `已启用 ${item.name}。` : `已停用 ${item.name}。`);
    } catch (error) {
      report(error instanceof Error ? error.message : '更新模型状态失败，请重试。');
    } finally {
      setBusy(false);
    }
  }
  /**
   * 删除模型：自定义模型真正移除，内置模型等价于停用（保留已存密钥）。
   *
   * 删除当前编辑项时清空右侧表单，避免继续展示一条已不存在的配置；
   * 内置模型可重新启用，自定义模型的删除由用户显式点击触发。
   */
  async function removeModel(item: Model) {
    setBusy(true);
    try {
      await withWatchdog(
        window.kapibala.settings.deleteProfile(item.id),
        '操作超时：Host 可能已断开，请重启应用后重试。',
      );
      if (selected?.id === item.id) {
        setSelected(undefined);
        setDraft(undefined);
        setKey('');
        resetProbe();
      }
      await reload();
      setNotice(
        item.builtin ? `已停用 ${item.name}（已存密钥保留）。` : `已删除自定义模型 ${item.name}。`,
      );
    } catch (error) {
      report(error instanceof Error ? error.message : '删除模型失败，请重试。');
    } finally {
      setBusy(false);
    }
  }
  /** 端点探测失败按固定错误码翻译，避免把 host 的英文码直接甩给用户。 */
  function listErrorText(error: unknown): string {
    const code = error instanceof Error ? error.message : '';
    // 页面看门狗与 RPC 框架超时都归一到同一句，避免把英文码直接甩给用户。
    if (code === 'MODEL_LIST_TIMEOUT' || code === 'REQUEST_TIMEOUT')
      return '获取模型列表超时：请检查 Base URL 与网络后重试。';
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
    const token = ++probeToken.current;
    // Host 内部的探测超时之外再加一层页面看门狗：控制通路挂起时按钮也必须回到可点击状态，
    // 迟到的 RPC 回复由 requestId 与本地序号双重丢弃，不会串进下一次探测或别的表单。
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        window.kapibala.settings.listModels({
          baseURL: draft.baseURL.trim(),
          apiKey: key.trim() || undefined,
          profileId: selected?.id,
          // 协议族随表单走：anthropic 端点必须用 x-api-key 探测，纯 Bearer 会被官方 API 拒绝。
          provider: draft.provider,
        }),
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(() => reject(new Error('MODEL_LIST_TIMEOUT')), 12_000);
        }),
      ]);
      if (token !== probeToken.current) return;
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
      if (token !== probeToken.current) return;
      setModels(undefined);
      setManualModel(true);
      setFetchStatus(listErrorText(error));
    } finally {
      if (watchdog) clearTimeout(watchdog);
      if (token === probeToken.current) setFetching(false);
    }
  }
  /**
   * 保存就是一次落盘：配置和密钥一起写进本地 settings.json，不再生成预览令牌，
   * 也不再需要二次确认。端点变更时 host 拒绝原地改写，页面换新 id 另存，旧配置保持可用。
   */
  async function save() {
    if (!draft) return;
    if (customGroup) {
      // 必填项在保存时统一校验：字段自己变红并给出原因，比只在顶部报一句更容易定位。
      // API Key 只在没有可复用凭证时算必填，避免每次改端点都要重新粘贴同一把密钥。
      const needsKey = !key.trim() && !selected?.credential.configured;
      const errors: CustomFieldErrors = {
        baseURL: draft.baseURL.trim() ? undefined : '请填写 Base URL。',
        apiKey: needsKey ? '请填写 API Key。' : undefined,
        modelName: draft.modelName.trim() ? undefined : '请填写模型名。',
      };
      if (errors.baseURL || errors.apiKey || errors.modelName) {
        setFieldErrors(errors);
        setNotice('');
        return;
      }
    }
    setFieldErrors({});
    setBusy(true);
    setNotice('');
    try {
      const target: ProfileDraft = {
        ...draft,
        // 自定义端点没有独立的显示名字段：行标题直接跟随模型名，改模型后不会残留旧名字。
        name: customGroup ? draft.modelName.trim() : draft.name.trim() || draft.modelName.trim(),
        modelName: draft.modelName.trim(),
        baseURL: draft.baseURL.trim(),
        // 空厂商名表示归入通用「自定义端点 / 其它」，不落空串进配置文件。
        vendorName: draft.vendorName?.trim() || undefined,
        // 历史免密钥配置一旦补了密钥就切回带密钥模式，否则密钥存了却不会参与请求。
        apiKeyEnv: customGroup && key.trim() ? 'CUSTOM_API_KEY' : draft.apiKeyEnv,
      };
      const pendingKey = key.trim() || undefined;
      let saved: Output<'settings.saveProfile'>;
      let savedAsNew = false;
      try {
        saved = await withWatchdog(
          window.kapibala.settings.saveProfile({
            profile: target,
            apiKey: pendingKey,
            editId: selected?.id,
          }),
          '保存超时：Host 可能已断开，请重启应用后确认配置。',
        );
      } catch (error) {
        // 自定义端点改了地址、协议或鉴权方式时 host 拒绝原地改写；换新 id 另存，旧配置保持可用。
        if (
          error instanceof Error &&
          error.message === 'SAVE_AS_NEW_PROFILE' &&
          customGroup &&
          selected
        ) {
          savedAsNew = true;
          saved = await withWatchdog(
            window.kapibala.settings.saveProfile({
              profile: {
                ...target,
                id: `custom-${crypto.randomUUID().slice(0, 8)}`,
              },
              apiKey: pendingKey,
            }),
            '保存超时：Host 可能已断开，请重启应用后确认配置。',
          );
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
        setFieldErrors({ apiKey: '请填写 API Key。' });
        setNotice('');
      } else {
        report(error instanceof Error ? error.message : '配置保存失败，请检查输入后重试。');
      }
    } finally {
      setBusy(false);
    }
  }
  /** 只提交全局默认档位；写盘后回读目录，让面板选中态以磁盘为准。 */
  async function savePermissionMode(mode: 'Approval' | 'Plan' | 'Auto') {
    setPermissionSaving(true);
    try {
      await window.kapibala.settings.setPermissionMode(mode);
      await reload();
      setNotice('已更新新建会话的默认审批档位。');
    } catch (error) {
      report(error instanceof Error ? error.message : '更新默认审批档位失败，请重试。');
    } finally {
      setPermissionSaving(false);
    }
  }
  const builtin = Boolean(selected?.builtin && selected.id === draft?.id);
  const active = SETTINGS_TABS.find((item) => item.value === tab) ?? SETTINGS_TABS[0];
  return (
    <>
      <Dialog.Root
        open={open}
        onOpenChange={(isOpen) => {
          // 关闭永远可用：写盘是原子的，卡在「保存中」时不给关闭入口会把一次网络/宿主异常
          // 放大成整页锁死；重新打开会从 catalog 重新读取，不依赖未完成的表单状态。
          if (!isOpen) onOpenChange(false);
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
                  {/* 返回式入口取代右上角 X：语义是「回到应用」，与系统设置类面板一致；
                      可访问标题以 sr-only 保留，Escape 与点击遮罩关闭行为不变。 */}
                  <Dialog.Title className="sr-only">设置</Dialog.Title>
                  <Dialog.Close
                    render={
                      <Button
                        className="kapibala-action h-auto w-full justify-start gap-2 rounded-lg px-2 py-1.5 font-normal"
                        variant="ghost"
                        aria-label="返回应用"
                      />
                    }
                  >
                    <ArrowLeftIcon size={16} className="shrink-0 text-kumo-subtle" />
                    <span className="text-sm font-medium">返回应用</span>
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
                    <div className="kapibala-models-list" ref={modelsListRef}>
                      {visibleProviders.map((meta) => {
                        const models = groupedModels.get(meta.key) ?? [];
                        const configured = models.some((item) => item.credential.configured);
                        return (
                          <Button
                            key={meta.key}
                            variant="ghost"
                            data-provider-key={meta.key}
                            aria-pressed={providerSel === meta.key}
                            className="kapibala-models-item"
                            onClick={() => selectProvider(meta.key)}
                          >
                            <span className="kapibala-models-item-badge" aria-hidden="true">
                              {meta.name.slice(0, 1)}
                            </span>
                            <span className="kapibala-models-item-name">{meta.name}</span>
                            {meta.custom && (
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
                        <p className="kapibala-models-empty">
                          {catalog ? '没有匹配的提供商或模型' : '正在加载提供商与模型目录…'}
                        </p>
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
                        <div className="kapibala-models-rows">
                          {providerModels.map((item) => (
                            <div
                              key={item.id}
                              className={`kapibala-models-row${
                                selected?.id === item.id ? ' is-selected' : ''
                              }${item.disabled ? ' is-off' : ''}`}
                            >
                              <Button
                                variant="ghost"
                                aria-pressed={selected?.id === item.id}
                                className="kapibala-models-row-select"
                                disabled={item.scope === 'project'}
                                title={
                                  item.scope === 'project'
                                    ? '项目级配置由项目内的 settings.json 管理，本页只读展示'
                                    : undefined
                                }
                                onClick={() => {
                                  setSelected(item);
                                  setDraft(draftOf(item));
                                  setKey('');
                                  resetProbe();
                                }}
                              >
                                <span className="kapibala-models-row-name">{item.name}</span>
                                {!item.credential.configured && (
                                  <em className="kapibala-models-row-tag">未配置密钥</em>
                                )}
                                {item.scope === 'project' && (
                                  <em className="kapibala-models-row-tag">项目级</em>
                                )}
                                {catalog?.defaultModel === item.id && (
                                  <em className="kapibala-models-row-tag">默认</em>
                                )}
                                {item.disabled && (
                                  <em className="kapibala-models-row-tag">已停用</em>
                                )}
                              </Button>
                              {item.scope !== 'project' && (
                                <div className="kapibala-models-row-actions">
                                  <Button
                                    variant="ghost"
                                    className="kapibala-models-row-icon"
                                    aria-label={`测试连接 ${item.name}`}
                                    title="测试连接"
                                    disabled={busy || testingId === item.id}
                                    onClick={() => void testModel(item)}
                                  >
                                    <PlugsConnectedIcon size={16} aria-hidden="true" />
                                  </Button>
                                  <Switch
                                    variant="neutral"
                                    checked={!item.disabled}
                                    disabled={busy}
                                    aria-label={`${item.disabled ? '启用' : '停用'}模型 ${item.name}`}
                                    onCheckedChange={(checked) => void toggleModel(item, checked)}
                                  />
                                  <Button
                                    variant="ghost"
                                    className="kapibala-models-row-icon"
                                    aria-label={`删除模型 ${item.name}`}
                                    title="删除"
                                    disabled={busy}
                                    onClick={() => void removeModel(item)}
                                  >
                                    <TrashIcon size={16} aria-hidden="true" />
                                  </Button>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      {testState && (
                        <output
                          className={`kapibala-models-hint${testState.ok ? ' is-ok' : ' is-error'}`}
                        >
                          {testState.message}
                        </output>
                      )}
                      {draft && customGroup ? (
                        <div className="kapibala-models-form">
                          <Input
                            label="厂商名称"
                            placeholder="如 magpie；留空归入「自定义端点 / 其它」"
                            value={draft.vendorName ?? ''}
                            maxLength={64}
                            disabled={busy}
                            onChange={(event) => change('vendorName', event.target.value)}
                          />
                          <Input
                            label="Base URL（必填）"
                            placeholder="https://api.example.com/v1"
                            value={draft.baseURL}
                            error={fieldErrors.baseURL}
                            disabled={busy}
                            onChange={(event) => {
                              change('baseURL', event.target.value);
                              setFieldErrors({});
                            }}
                          />
                          <SensitiveInput
                            label="API Key（必填）"
                            value={key}
                            onValueChange={(value) => {
                              setKey(value);
                              setFieldErrors({});
                            }}
                            error={fieldErrors.apiKey}
                            disabled={busy}
                            autoComplete="off"
                            description={
                              selected?.credential.configured
                                ? '已有密钥不会回显；留空继续复用该分组的已存凭证。'
                                : '该密钥存放在全局 settings.json 中，并非系统钥匙串。'
                            }
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
                              label="模型（必填）"
                              items={Object.fromEntries(models.map((item) => [item, item]))}
                              value={draft.modelName || null}
                              error={fieldErrors.modelName}
                              disabled={busy}
                              onValueChange={(value) => {
                                if (!value) return;
                                change('modelName', String(value));
                                setFieldErrors({});
                              }}
                            />
                          ) : (
                            <Input
                              label="模型名（必填）"
                              placeholder="deepseek-chat"
                              value={draft.modelName}
                              error={fieldErrors.modelName}
                              disabled={busy}
                              onChange={(event) => {
                                change('modelName', event.target.value);
                                setFieldErrors({});
                              }}
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
                              <TokenPresets
                                label="上下文窗口预设"
                                value={draft.contextWindow}
                                presets={CONTEXT_WINDOW_PRESETS}
                                disabled={busy}
                                onPick={(tokens) => change('contextWindow', tokens)}
                              />
                              <p className="text-xs text-kumo-subtle">
                                留空将在保存时自动探测端点声明的窗口；探测失败按 256K
                                估算，也可直接填写真实窗口。
                              </p>
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
                              <TokenPresets
                                label="最大输出 Token 预设"
                                value={draft.maxOutputTokens}
                                presets={OUTPUT_TOKEN_PRESETS}
                                disabled={busy}
                                onPick={(tokens) => change('maxOutputTokens', tokens)}
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
                              <TokenPresets
                                label="最大输出 Token 预设"
                                value={draft.maxOutputTokens}
                                presets={OUTPUT_TOKEN_PRESETS}
                                disabled={busy}
                                onPick={(tokens) => change('maxOutputTokens', tokens)}
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
                        .filter(
                          (item) =>
                            item.scope === 'global' && item.credential.configured && !item.disabled,
                        )
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
                            .filter(
                              (item) =>
                                item.scope === 'global' &&
                                item.credential.configured &&
                                !item.disabled,
                            )
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
                <Tabs.Panel value="external" className="kapibala-settings-panel">
                  <ExternalSettingsPanel
                    active={open && tab === 'external'}
                    workspaceId={workspaceId}
                    hostDown={hostDown}
                    report={report}
                  />
                </Tabs.Panel>
                <Tabs.Panel value="permission" className="kapibala-settings-panel space-y-4">
                  <section className="space-y-2">
                    <h3 className="text-sm font-medium">新建会话的默认审批档位</h3>
                    <p className="text-sm text-kumo-subtle">
                      只影响之后新建的会话。已打开的会话各自记住上次选择的档位，重启后重新打开仍会沿用。
                      完全访问不能设为默认，需要在会话内显式确认后启用。
                    </p>
                  </section>
                  <div className="space-y-2">
                    {PERMISSION_OPTIONS.map((option) => {
                      const current = catalog?.permissionMode === option.mode;
                      return (
                        <Button
                          key={option.mode}
                          className={`kapibala-action flex h-auto w-full items-start justify-start gap-2 whitespace-normal rounded-lg border px-3 py-2.5 text-left font-normal ${
                            current ? 'border-kumo-brand' : 'border-kumo-line'
                          }`}
                          variant="ghost"
                          aria-pressed={current}
                          disabled={permissionSaving || hostDown}
                          onClick={() => void savePermissionMode(option.mode)}
                        >
                          <ShieldCheckIcon size={16} className="mt-0.5 shrink-0 text-kumo-subtle" />
                          <span className="flex flex-col items-start gap-0.5">
                            <span className="text-sm font-medium">{option.label}</span>
                            <span className="text-xs text-kumo-subtle">{option.hint}</span>
                          </span>
                        </Button>
                      );
                    })}
                  </div>
                  <p className="text-xs text-kumo-subtle">
                    与 CLI 共用同一份全局配置；保存即写盘，不需要二次确认。
                  </p>
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
                      全局配置：~/.kapibala/mcp.json；项目级声明在受信项目上可编辑，未受信只读。
                      启停与增删对新建会话生效，运行中的会话不受影响。
                    </p>
                    {!inspection && (
                      <p className="text-xs text-kumo-subtle">连接状态在打开会话后可见。</p>
                    )}
                    {(resMcp?.servers ?? []).length === 0 && (
                      <p className="text-sm text-kumo-subtle">未配置任何 MCP 服务器。</p>
                    )}
                    {(resMcp?.servers ?? []).map((server: McpServerView) => {
                      const editable =
                        server.source === 'global' || Boolean(resMcp?.projectTrusted);
                      const runtime = inspection?.mcp.servers.find(
                        (item) => item.name === server.name,
                      );
                      return (
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
                                    ? editable
                                      ? '项目级'
                                      : '项目级（只读）'
                                    : server.enabled
                                      ? '已启用'
                                      : '已禁用'}
                                </span>
                              </div>
                              <div className="truncate text-xs text-kumo-subtle">
                                {server.type === 'http' ? 'HTTP' : 'stdio'} ·{' '}
                                {server.target || '（无目标）'}
                              </div>
                              {runtime && (
                                <div className="truncate text-xs text-kumo-subtle">
                                  连接: {runtime.state} · 工具: {runtime.toolsState ?? '未知'}（
                                  {runtime.toolCount ?? 0} 个）
                                  {runtime.error ? ` · ${runtime.error}` : ''}
                                </div>
                              )}
                            </div>
                            {editable && (
                              <div className="flex shrink-0 items-center gap-2">
                                <Switch
                                  label={`启用 ${server.name}`}
                                  checked={server.enabled}
                                  disabled={resBusy}
                                  onCheckedChange={(checked) =>
                                    resourceAction((activeWorkspaceId) =>
                                      window.kapibala.resources.toggleMcpServer({
                                        workspaceId: activeWorkspaceId,
                                        scope: server.source,
                                        name: server.name,
                                        enabled: checked,
                                      }),
                                    )
                                  }
                                />
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`编辑 ${server.name}`}
                                  onClick={() =>
                                    setResDraft({
                                      editName: server.name,
                                      scope: server.source,
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
                                          scope: server.source,
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
                                    aria-label={`删除 ${server.name}`}
                                    onClick={() => setResConfirmDelete(server.name)}
                                  >
                                    删除
                                  </Button>
                                )}
                              </div>
                            )}
                          </div>
                          {server.approval && (
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span
                                className={
                                  server.approval.approved ? 'text-kumo-subtle' : 'text-kumo-danger'
                                }
                              >
                                批准: {server.approval.approved ? '已批准' : '待批准'}
                                {!server.approval.approved && server.approval.approvedAt
                                  ? '（配置已变化，需重新批准）'
                                  : ''}
                              </span>
                              {server.approval.approved ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`撤销批准 ${server.name}`}
                                  disabled={resBusy}
                                  onClick={() =>
                                    resourceAction((activeWorkspaceId) =>
                                      window.kapibala.resources.revokeMcpServer({
                                        workspaceId: activeWorkspaceId,
                                        name: server.name,
                                      }),
                                    )
                                  }
                                >
                                  撤销批准
                                </Button>
                              ) : (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  aria-label={`批准 ${server.name}`}
                                  disabled={resBusy}
                                  onClick={() =>
                                    resourceAction((activeWorkspaceId) =>
                                      window.kapibala.resources.approveMcpServer({
                                        workspaceId: activeWorkspaceId,
                                        name: server.name,
                                      }),
                                    )
                                  }
                                >
                                  批准
                                </Button>
                              )}
                            </div>
                          )}
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
                              [{diagnostic.severity}] [{diagnostic.code}] {diagnostic.message}
                            </p>
                          ))}
                        </div>
                      );
                    })}
                    {resMcp?.diagnostics.map((diagnostic) => (
                      <p
                        key={`${diagnostic.code}:${diagnostic.message}`}
                        className="text-xs text-kumo-subtle"
                      >
                        [{diagnostic.severity}] [{diagnostic.code}] {diagnostic.message}
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
                          label="写入位置"
                          value={resDraft.scope}
                          items={
                            resMcp?.projectTrusted
                              ? {
                                  global: '全局（~/.kapibala/mcp.json）',
                                  project: '项目（需已信任）',
                                }
                              : { global: '全局（~/.kapibala/mcp.json）' }
                          }
                          disabled={Boolean(resDraft.editName)}
                          onValueChange={(value) => {
                            if (value === 'global' || value === 'project')
                              setResDraft({ ...resDraft, scope: value });
                          }}
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
                            ? `该声明包含敏感内容，面板编辑只保留传输配置原文（可改名）；如需修改传输配置请手工编辑 ${
                                resDraft.scope === 'project'
                                  ? '<项目>/.kapibala/mcp.json'
                                  : '~/.kapibala/mcp.json'
                              }。`
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
                                    scope: resDraft.scope,
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
                            scope: 'global',
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
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs text-kumo-subtle">
                        外部工具的 MCP 声明只在此处一次性拷贝，不会长期读取或自动同步。
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label="从其它工具导入 MCP"
                        disabled={!workspaceId || resBusy}
                        onClick={openMcpImportDrawer}
                      >
                        从其它工具导入
                      </Button>
                    </div>
                    {mcpImportOpen && (
                      <section
                        aria-label="从其它工具导入 MCP 服务器"
                        className="space-y-3 rounded-lg border border-kumo-line p-3"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <h4 className="text-sm font-medium">从其它工具导入 MCP 服务器</h4>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={mcpImportBusy}
                            onClick={() => setMcpImportOpen(false)}
                          >
                            关闭导入
                          </Button>
                        </div>
                        <Select
                          label="导入到"
                          value={mcpImportScope}
                          items={
                            resMcp?.projectTrusted
                              ? { global: '全局', project: '项目（需信任）' }
                              : { global: '全局' }
                          }
                          disabled={mcpImportBusy}
                          onValueChange={(value) => {
                            if (value !== 'global' && value !== 'project') return;
                            setMcpImportScope(value);
                            // 冲突与目标配置有关：换作用域必须重新扫描，不能复用旧预览。
                            scanMcpImport(value);
                          }}
                        />
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-medium">覆盖同名服务器</div>
                            <p className="text-xs text-kumo-subtle">
                              默认跳过已存在的同名声明；开启后会用来源配置替换目标条目。
                            </p>
                          </div>
                          <Switch
                            label="覆盖同名 MCP 服务器"
                            checked={mcpImportOverwrite}
                            disabled={mcpImportBusy}
                            onCheckedChange={setMcpImportOverwrite}
                          />
                        </div>
                        {mcpImportError && (
                          <p role="alert" className="text-xs text-kumo-danger">
                            {mcpImportError}
                          </p>
                        )}
                        {mcpImportBusy && !mcpImportScan && (
                          <p className="text-sm text-kumo-subtle">正在扫描来源…</p>
                        )}
                        {mcpImportScan && (
                          <>
                            <div className="space-y-1">
                              {mcpImportScan.sources.map((source) => (
                                <p key={source.harness} className="text-xs text-kumo-subtle">
                                  {source.label}：
                                  {source.files.length === 0
                                    ? '未发现配置文件'
                                    : source.files
                                        .map(
                                          (file) =>
                                            `${file.origin}:${file.path}${file.readable ? '' : '（不可读）'}（${file.servers} 个）`,
                                        )
                                        .join(' · ')}
                                </p>
                              ))}
                            </div>
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-xs text-kumo-subtle">
                                候选 {mcpImportScan.candidates.length} 个
                              </span>
                              <div className="flex gap-2">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={mcpImportBusy}
                                  onClick={() =>
                                    setMcpImportSelected(
                                      new Set(mcpImportScan.candidates.map(importKey)),
                                    )
                                  }
                                >
                                  全选
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={mcpImportBusy}
                                  onClick={() => setMcpImportSelected(new Set())}
                                >
                                  全不选
                                </Button>
                              </div>
                            </div>
                            {mcpImportScan.candidates.length === 0 && (
                              <p className="text-sm text-kumo-subtle">
                                未发现可导入的 MCP 服务器（来源文件不存在或为空）。
                              </p>
                            )}
                            <ul className="space-y-1">
                              {mcpImportScan.candidates.map((candidate) => (
                                <li
                                  key={importKey(candidate)}
                                  className="rounded-lg border border-kumo-line p-2"
                                >
                                  <div className="flex items-start justify-between gap-3">
                                    <span className="min-w-0">
                                      <span className="text-sm font-medium">{candidate.name}</span>
                                      <span className="ml-2 text-xs text-kumo-subtle">
                                        [{candidate.harness}] {candidate.transport} ·{' '}
                                        {candidate.origin === 'project' ? '项目来源' : '用户来源'}
                                        {candidate.conflict === 'none'
                                          ? ''
                                          : candidate.conflict === 'exists-disabled'
                                            ? ' · 目标已存在（已停用）'
                                            : ' · 目标已存在（将跳过）'}
                                      </span>
                                      <span className="block truncate text-xs text-kumo-subtle">
                                        {candidate.target || '（无传输摘要）'}
                                      </span>
                                      {candidate.nameProblem && (
                                        <span className="block text-xs text-kumo-danger">
                                          名称不合法：{candidate.nameProblem}
                                        </span>
                                      )}
                                      {candidate.hasSecretSurface && (
                                        <span className="block text-xs text-kumo-subtle">
                                          含环境变量或请求头（值不回显）
                                        </span>
                                      )}
                                      {candidate.strippedFields.length > 0 && (
                                        <span className="block text-xs text-kumo-subtle">
                                          将剥离：{candidate.strippedFields.join(', ')}
                                        </span>
                                      )}
                                    </span>
                                    <Switch
                                      label={`选择导入 ${candidate.name}`}
                                      checked={mcpImportSelected.has(importKey(candidate))}
                                      disabled={mcpImportBusy}
                                      onCheckedChange={() =>
                                        toggleMcpImportCandidate(importKey(candidate))
                                      }
                                    />
                                  </div>
                                </li>
                              ))}
                            </ul>
                            {mcpImportScan.diagnostics.slice(0, 20).map((diagnostic) => (
                              <p
                                key={`${diagnostic.code}:${diagnostic.message}`}
                                className="text-xs text-kumo-subtle"
                              >
                                [{diagnostic.severity}] [{diagnostic.code}] {diagnostic.message}
                              </p>
                            ))}
                            <Button
                              size="sm"
                              aria-label="开始导入 MCP 服务器"
                              disabled={mcpImportBusy || mcpImportSelected.size === 0}
                              onClick={runMcpImport}
                            >
                              开始导入
                            </Button>
                          </>
                        )}
                        {mcpImportResult && (
                          <div className="space-y-1 text-xs">
                            <p className="font-medium">
                              导入结果：导入 {mcpImportResult.imported} · 未变{' '}
                              {mcpImportResult.unchanged} · 跳过 {mcpImportResult.skippedConflict} ·
                              失败 {mcpImportResult.failed}
                            </p>
                            {mcpImportResult.items.map((item) => (
                              <p
                                key={`${item.harness}:${item.name}:${item.status}`}
                                className="text-kumo-subtle"
                              >
                                {item.name} [{item.harness}] {item.status}
                                {item.message ? ` · ${item.message}` : ''}
                              </p>
                            ))}
                          </div>
                        )}
                      </section>
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
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs text-kumo-subtle">
                        外部工具的技能只在此处一次性拷贝，不会长期读取或自动同步。
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!workspaceId || resBusy}
                        onClick={openImportDrawer}
                      >
                        从其它工具导入
                      </Button>
                    </div>
                    {importOpen && (
                      <section
                        aria-label="从其它工具导入技能"
                        className="space-y-3 rounded-lg border border-kumo-line p-3"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <h4 className="text-sm font-medium">从其它工具导入</h4>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={importBusy}
                            onClick={() => setImportOpen(false)}
                          >
                            关闭导入
                          </Button>
                        </div>
                        <Select
                          label="目标作用域"
                          value={importScope}
                          items={{ global: '全局', project: '项目（需信任）' }}
                          disabled={importBusy || !resMcp?.projectTrusted}
                          onValueChange={(value) => {
                            if (value !== 'global' && value !== 'project') return;
                            setImportScope(value);
                            // 冲突状态与已导入差异取决于目标作用域目录，切换后重新扫描刷新预览。
                            scanSkillImport(value);
                          }}
                        />
                        {importError && (
                          <p role="alert" className="text-xs text-kumo-danger">
                            {importError}
                          </p>
                        )}
                        {importBusy && !importScan && (
                          <p className="text-sm text-kumo-subtle">正在扫描来源…</p>
                        )}
                        {importScan && (
                          <>
                            <div className="space-y-1">
                              {importScan.sources.map((source) => (
                                <p key={source.harness} className="text-xs text-kumo-subtle">
                                  {source.label}：
                                  {source.roots.length === 0
                                    ? '未提供可用目录'
                                    : source.roots
                                        .map(
                                          (root) =>
                                            `${root.scope}:${root.path}${root.readable ? '' : '（不可读）'}`,
                                        )
                                        .join(' · ')}
                                  {source.partial ? ` · 已截断 ${source.truncated}` : ''}
                                </p>
                              ))}
                            </div>
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-xs text-kumo-subtle">
                                候选 {importScan.candidates.length} 个
                              </span>
                              <div className="flex gap-2">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={importBusy}
                                  onClick={() =>
                                    setImportSelected(new Set(importScan.candidates.map(importKey)))
                                  }
                                >
                                  全选
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={importBusy}
                                  onClick={() => setImportSelected(new Set())}
                                >
                                  全不选
                                </Button>
                              </div>
                            </div>
                            {importScan.candidates.length === 0 && (
                              <p className="text-sm text-kumo-subtle">
                                未发现可导入技能（来源目录不存在或为空）。
                              </p>
                            )}
                            <ul className="space-y-1">
                              {importScan.candidates.map((candidate) => (
                                <li
                                  key={importKey(candidate)}
                                  className="rounded-lg border border-kumo-line p-2"
                                >
                                  <div className="flex items-start justify-between gap-3">
                                    <span className="min-w-0">
                                      <span className="text-sm font-medium">{candidate.name}</span>
                                      <span className="ml-2 text-xs text-kumo-subtle">
                                        [{candidate.harness}] {candidate.files} 文件
                                        {candidate.hasScripts ? ' · 含 scripts' : ''}
                                        {candidate.conflict === 'none' ? '' : ' · 已存在（将跳过）'}
                                      </span>
                                      <span className="block truncate text-xs text-kumo-subtle">
                                        {candidate.description || candidate.sourceRef}
                                      </span>
                                      {candidate.strippedFields.length > 0 && (
                                        <span className="block text-xs text-kumo-subtle">
                                          将剥离：{candidate.strippedFields.join(', ')}
                                        </span>
                                      )}
                                    </span>
                                    <Switch
                                      label={`选择导入 ${candidate.name}`}
                                      checked={importSelected.has(importKey(candidate))}
                                      disabled={importBusy}
                                      onCheckedChange={() =>
                                        toggleImportCandidate(importKey(candidate))
                                      }
                                    />
                                  </div>
                                </li>
                              ))}
                            </ul>
                            {importScan.diagnostics.slice(0, 20).map((diagnostic) => (
                              <p
                                key={`${diagnostic.code}:${diagnostic.path}:${diagnostic.message}`}
                                className="text-xs text-kumo-subtle"
                              >
                                [{diagnostic.code}] {diagnostic.path} · {diagnostic.message}
                              </p>
                            ))}
                            <Button
                              size="sm"
                              disabled={importBusy || importSelected.size === 0}
                              onClick={runImport}
                            >
                              开始导入
                            </Button>
                          </>
                        )}
                        {importResult && (
                          <div className="space-y-1 text-xs">
                            <p className="font-medium">
                              导入结果：导入 {importResult.imported} · 未变 {importResult.unchanged}{' '}
                              · 跳过 {importResult.skippedConflict + importResult.skippedLimit} ·
                              失败 {importResult.failed}
                            </p>
                            {importResult.items.map((item) => (
                              <p
                                key={`${item.harness}:${item.name}:${item.status}`}
                                className="text-kumo-subtle"
                              >
                                {item.name} [{item.harness}] {item.status}
                                {item.message ? ` · ${item.message}` : ''}
                              </p>
                            ))}
                          </div>
                        )}
                      </section>
                    )}
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
                  <section aria-label="关于与更新" className="space-y-2">
                    <h3 className="text-sm font-medium">关于与更新</h3>
                    {/* 当前版本与更新入口同处一个分区：更新状态永远和「我正在用哪一版」放在一起读。 */}
                    <p className="text-sm">
                      Kapibala {info?.version ?? '读取中'}
                      {info?.testBuild ? ' · 内部测试构建' : ''}
                    </p>
                    <p className="text-xs text-kumo-subtle">
                      未签名个人自用版；检查、下载与安装都由你手动触发，不自动下载或静默安装。
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={updateBusy || !info}
                        onClick={checkUpdate}
                      >
                        {updateBusy ? '检查中…' : '检查更新'}
                      </Button>
                      {updateCheck?.releaseUrl && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openReleasePage(updateCheck.releaseUrl)}
                        >
                          打开发布页
                        </Button>
                      )}
                    </div>
                    {updateError && (
                      <p role="alert" className="text-xs text-kumo-danger">
                        {updateError}
                      </p>
                    )}
                    {updateCheck?.status === 'up-to-date' && (
                      <p className="text-xs text-kumo-subtle">
                        已是最新版本（{updateCheck.latestVersion}）。
                      </p>
                    )}
                    {updateCheck?.status === 'update-available' && (
                      <div className="space-y-1 text-xs">
                        <p className="text-sm">
                          发现新版本 {updateCheck.latestVersion}（当前 {updateCheck.currentVersion}
                          ）。
                        </p>
                        {updateCheck.installer && (
                          <p className="text-kumo-subtle">安装包：{updateCheck.installer.name}</p>
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                          {downloading ? (
                            <>
                              <span className="text-kumo-subtle">
                                {updateProgress
                                  ? `下载中 ${formatSize(updateProgress.downloaded)}${
                                      updateProgress.total > 0
                                        ? ` / ${formatSize(updateProgress.total)}`
                                        : ''
                                    }`
                                  : '下载中…'}
                              </span>
                              <Button variant="ghost" size="sm" onClick={cancelDownload}>
                                取消下载
                              </Button>
                            </>
                          ) : (
                            <Button variant="outline" size="sm" onClick={startDownload}>
                              {updateDownload?.status === 'failed' ? '重试下载' : '下载安装包'}
                            </Button>
                          )}
                        </div>
                        <p className="text-kumo-subtle">
                          下载到系统下载目录；SHA256
                          与发布包摘要严格一致才会打开。未签名，需手动完成安装。
                        </p>
                        {updateDownload?.status === 'downloaded' && (
                          <p className="text-kumo-subtle">
                            已通过 SHA256 校验，
                            {updateDownload.opened ? '已打开安装包' : '请到下载目录手动打开'}：
                            {updateDownload.filePath}
                          </p>
                        )}
                        {updateDownload?.status === 'cancelled' && (
                          <p className="text-kumo-subtle">已取消下载，未保留临时文件。</p>
                        )}
                        {updateDownload?.status === 'failed' && (
                          <p role="alert" className="text-kumo-danger">
                            {describeDownloadFailure(updateDownload.reason, updateDownload.detail)}
                          </p>
                        )}
                      </div>
                    )}
                    {updateCheck?.status === 'no-asset' && (
                      <p className="text-xs text-kumo-subtle">
                        最新版本 {updateCheck.latestVersion}{' '}
                        没有匹配当前平台的安装包，请到发布页查看。
                      </p>
                    )}
                    {updateCheck?.status === 'unknown' && (
                      <p className="text-xs text-kumo-subtle">
                        暂时无法检查更新（{updateCheck.reason ?? 'UNKNOWN'}），不影响继续使用。
                      </p>
                    )}
                  </section>
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
