import {
  Button,
  DropdownMenu,
  Input,
  InputArea,
  LayerCard,
  LayerDialog,
  Sidebar,
} from '@cloudflare/kumo';
import brandMark from '@kapibala-assets/icon.svg';
import { type ViewNotice, selectMessages } from '@kiturone/kapibala-host/view-model';
import {
  ArrowUpIcon,
  CaretDownIcon,
  CheckIcon,
  FolderPlusIcon,
  FolderSimpleIcon,
  HandIcon,
  LightbulbIcon,
  ShieldCheckIcon,
  ShieldWarningIcon,
  StopIcon,
  XIcon,
} from '@phosphor-icons/react';
import {
  type CSSProperties,
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { DesktopAPI, Output, Workspace } from '../shared/contracts.js';
import { DetailsDrawer, type DetailsTarget } from './details-drawer.js';
import { HistoryListClient } from './history-list-client.js';
import { KubaiIcon } from './icons/KubaiIcon.js';
import { MessageList } from './message-list.js';
import { ProjectDialog } from './project-dialog.js';
import { SessionDeleteDialog, SessionRenameDialog, type SessionTarget } from './session-actions.js';
import { SettingsDialog } from './settings-dialog.js';
import { useUI } from './ui-state.js';
import { ViewClient } from './view-client.js';
import { WorkspaceSidebar, runtimeLabel } from './workspace-sidebar.js';

type Opened = Output<'session.open'>;
type Catalog = Output<'settings.read'>;
const api: DesktopAPI = window.kapibala;
const client = new ViewClient(api);
const scopeOf = (opened: Opened) => ({
  workspaceId: opened.workspaceId,
  sessionId: opened.sessionId,
});
const MODE_NAMES = {
  Approval: '变更前确认',
  Plan: '计划模式',
  Auto: '自主模式',
  FullAccess: '完全访问',
} as const;
type Mode = keyof typeof MODE_NAMES;
/** 模式菜单的灰色副标题：用一句话说明该模式何时介入，帮助用户区分三个审批档位的强度。 */
const MODE_HINTS = {
  Plan: '编辑前先出计划。',
  Approval: '改文件前先问我。',
  Auto: '在有风险时询问。',
  FullAccess: '减少确认次数。',
} as const;
/** 各模式的语义图标：计划用灯泡，其余按审批强度从手（逐次确认）递进到盾。 */
const MODE_ICONS = {
  Plan: LightbulbIcon,
  Approval: HandIcon,
  Auto: ShieldCheckIcon,
  FullAccess: ShieldWarningIcon,
} as const;
/** 菜单展示顺序：计划模式单列一组（它是工作流档位而非审批强度），与三个审批档位之间用分隔线隔开。 */
const MODE_ORDER: readonly Mode[] = ['Plan', 'Approval', 'Auto', 'FullAccess'];

/** 会话模式图标：菜单项与触发按钮共用，保证同一模式在两处的视觉语义一致。 */
function ModeGlyph({ mode, size = 16 }: { mode: Mode; size?: number }) {
  const Glyph = MODE_ICONS[mode];
  return <Glyph size={size} className="shrink-0 text-kumo-subtle" />;
}

/**
 * 右上角通知浮层：承载会话诊断，逐条渲染并可单独关闭。
 * 不参与对话流布局，也不拦截空白区域的点击；关闭状态只保存在页面内存里。
 * 浮层默认 3 秒自动收起；审批请求仍走正中弹窗，不在这里承接。
 */
function NoticeToasts({
  notices,
  dismissed,
  onDismiss,
}: {
  notices: readonly ViewNotice[];
  dismissed: Readonly<Record<string, true>>;
  onDismiss(id: string): void;
}) {
  const visible = notices.filter((notice) => !dismissed[notice.id]);
  // 只按 id 序列重建计时器：文案流式更新不该给同一条提示续命。
  const visibleIds = JSON.stringify(visible.map((notice) => notice.id));
  useEffect(() => {
    if (visibleIds === '[]') return;
    const timers = (JSON.parse(visibleIds) as string[]).map((id) =>
      setTimeout(() => onDismiss(id), 3000),
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [visibleIds, onDismiss]);
  if (visible.length === 0) return null;
  return (
    <section className="kapibala-toasts" aria-label="通知">
      {visible.map((notice) => (
        <div
          key={notice.id}
          data-level={notice.level}
          // 错误级提示用 alert 立即播报；其余走 status，避免打断读屏。
          role={notice.level === 'error' ? 'alert' : 'status'}
          className="kapibala-toast"
        >
          <span className="min-w-0 flex-1 text-sm leading-5 break-words text-kumo-default">
            {notice.text}
          </span>
          <Button
            className="kapibala-action -mt-1 -mr-1 shrink-0 text-kumo-subtle"
            variant="ghost"
            size="sm"
            shape="square"
            aria-label="关闭提示"
            onClick={() => onDismiss(notice.id)}
          >
            <XIcon size={14} />
          </Button>
        </div>
      ))}
    </section>
  );
}
const ROLE_NAMES = {
  default: '默认',
  planning: '规划',
  execution: '执行',
  fast: '快速',
} as const;
const failure = (error: unknown) =>
  error instanceof Error ? error.message : '操作失败，请检查配置后重试。';
/** 首页示例只填入草稿，不创建会话、不自动发送；用户仍可改写后再提交。 */
const STARTERS = ['梳理当前仓库的目录结构', '为这个项目补一份 README', '检查最近的改动有没有风险'];

/** 桌面应用只组合投影事实与临时 UI 状态；运行和审批的最终决定由 Host 校验。 */
export function App() {
  const ui = useUI();
  const facts = useSyncExternalStore(client.subscribe, client.snapshot);
  const [workspace, setWorkspace] = useState<Workspace>();
  const [trust, setTrust] = useState<Workspace>();
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');
  const [opened, setOpened] = useState<Opened>();
  const [histories, setHistories] = useState<Record<string, Output<'session.list'>>>({});
  const [historyClient] = useState(
    () =>
      new HistoryListClient(
        (id, page) => api.session.list(id, page),
        (id, list) => setHistories((previous) => ({ ...previous, [id]: list })),
      ),
  );
  const [spaces, setSpaces] = useState<Workspace[]>([]);
  const [catalog, setCatalog] = useState<Catalog>();
  const [recent, setRecent] = useState<Output<'preferences.read'>['recent']>([]);
  /** 归档集合的变更代数：设置页据此重新拉取，不依赖设置页自己猜测何时过期。 */
  const [archiveRevision, setArchiveRevision] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<SessionTarget>();
  /** 待改名的会话；弹窗自身维护草稿，这里只保存身份与当前标题。 */
  const [pendingRename, setPendingRename] = useState<SessionTarget>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [fullAccess, setFullAccess] = useState(false);
  // 新对话在创建前没有会话配置，先把用户选的模型暂存；创建成功后立即 configure 再启动，
  // 避免「输入区显示 A 模型、实际用 B 模型」的静默不一致。空间切换不清空该选择。
  const [pendingProfile, setPendingProfile] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  // 编辑回填后聚焦输入框：composer 在首页与对话页互斥复用，同一时刻只挂载一份。
  const composerShell = useRef<HTMLDivElement | null>(null);
  const [details, setDetails] = useState<DetailsTarget>();
  const [wide, setWide] = useState(() => matchMedia('(min-width: 1200px)').matches);
  const current = useRef<Workspace | undefined>(undefined);
  const run =
    opened &&
    (facts.runs[opened.sessionId] ??
      facts.runtime?.items.find((item) => item.sessionId === opened.sessionId));
  const runtimeItem = facts.runtime?.items.find((item) => item.sessionId === opened?.sessionId);
  const readyToSend = facts.runtimeValid && runtimeItem?.cleanup === 'none';
  const running = run && run.phase !== 'idle';
  // 未打开会话时输入框直连"新建对话"流程；草稿按目标会话或 ':new' 键暂存。
  const draft = opened
    ? (ui.drafts[`${opened.workspaceId}:${opened.conversationId}`] ?? '')
    : (ui.drafts[':new'] ?? '');
  const selectedModel = catalog?.profiles.find(
    (model) => model.id === opened?.configuration.profileId,
  );
  // 没有密钥的模型列在菜单里只会让用户点了才失败；选择入口只提供当前真能调用的模型。
  // 设置页仍展示全量清单，否则用户没有地方为新模型补密钥。
  const usableModels = (catalog?.profiles ?? []).filter((model) => model.credential.configured);
  // 新对话展示的模型必须是「发送时真会用的那个」：优先取用户临时选择，其次取当前空间生效的默认模型。
  const defaultModel =
    usableModels.find((model) => model.id === catalog?.defaultModel) ?? usableModels[0];
  const composerModel = opened
    ? selectedModel
    : (usableModels.find((model) => model.id === pendingProfile) ?? defaultModel);
  // 未打开会话时发送会创建新会话，只要求宿主连接健康、目标空间已信任且至少有一个可用模型；
  // 已打开会话沿用运行事实门控，不因收尾状态重复触发任务。
  const canSend = opened
    ? Boolean(draft.trim()) && facts.valid && readyToSend && !running
    : Boolean(draft.trim()) &&
      Boolean(workspace?.trusted) &&
      facts.runtimeValid === true &&
      Boolean(composerModel);
  const messages = facts.state ? selectMessages(facts.state) : [];
  const report = setError;
  // 审批请求到达时立即弹出审批面板：队列没有常驻入口，错过弹窗就只能等超时被拒，
  // 用户最终只会看到莫名其妙的 PERMISSION_DENIED。
  // 只在「新增」审批时弹出（对比上次已见数量），用户手动关闭后不被反复打断。
  const seenApprovals = useRef(0);
  const approvalsCount = facts.approvals.length;
  const approvalsOpen = ui.approvalsOpen;
  const openApprovals = ui.approvals;
  useEffect(() => {
    const hasNew = approvalsCount > seenApprovals.current;
    seenApprovals.current = approvalsCount;
    if (hasNew && approvalsCount > 0 && !approvalsOpen) openApprovals(true);
  }, [approvalsCount, approvalsOpen, openApprovals]);
  const reloadCatalog = useCallback(async () => {
    setCatalog(await api.settings.read(current.current?.trusted ? current.current.id : undefined));
  }, []);
  const refreshHistory = useCallback(
    async (space = current.current, page?: number) => {
      if (!space?.trusted) return;
      await historyClient.refresh(space.id, page);
    },
    [historyClient],
  );
  const selectSpace = useCallback(
    async (space: Workspace | null) => {
      if (!space) return;
      if (!space.trusted) {
        setTrust(space);
        return;
      }
      setDetails(undefined);
      await client.clear();
      current.current = space;
      setWorkspace(space);
      setSpaces((previous) =>
        [space, ...previous.filter((item) => item.id !== space.id)].sort(
          (a, b) => Number(b.kind === 'default') - Number(a.kind === 'default'),
        ),
      );
      setOpened(undefined);
      setPendingProfile(undefined);
      setCatalog(undefined);
      setError('');
      await refreshHistory(space);
      await reloadCatalog();
      setRecent((await api.preferences.read()).recent);
    },
    [refreshHistory, reloadCatalog],
  );
  const act = useCallback(
    async function act(task: () => Promise<void>) {
      setBusy(true);
      setError('');
      try {
        await task();
      } catch (reason) {
        report(failure(reason));
      } finally {
        setBusy(false);
      }
    },
    [report],
  );
  useEffect(() => {
    void act(async () => {
      await api.ready();
      await client.connectRuntime();
      await reloadCatalog();
      const state = await api.preferences.read();
      setRecent(state.recent);
      await selectSpace(await api.workspace.openDefault());
      // Host 的空间登记簿是进程内的：重启后 spaces 只剩默认空间，最近项目若不重新登记
      // 就只存在于偏好文件里，「项目」区无法按项目聚合。逐个重新登记但不切换视图；
      // 倒序恢复是因为每次成功登记都会把该项目移到偏好 recent 首位，倒序执行后顺序不变。
      const restored: Workspace[] = [];
      for (const item of [...state.recent].reverse()) {
        try {
          const workspace = await api.workspace.openRecent(item.id);
          if (workspace && !restored.some((space) => space.id === workspace.id))
            restored.push(workspace);
        } catch {
          // 目录已删除或登记失败的历史项目直接跳过，不阻断启动。
        }
      }
      restored.reverse();
      setSpaces((previous) => {
        const known = new Set(previous.map((space) => space.root));
        const additions = restored.filter((space) => !known.has(space.root));
        return additions.length > 0 ? [...previous, ...additions] : previous;
      });
    });
  }, [act, reloadCatalog, selectSpace]);
  useEffect(() => {
    const query = matchMedia('(min-width: 960px)');
    const change = () => ui.sidebar(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, [ui.sidebar]);
  useEffect(() => {
    const query = matchMedia('(min-width: 1200px)');
    const change = () => setWide(query.matches);
    // 窗口可能在首帧渲染后被系统钳制到工作区，挂载时主动同步一次，避免初始值与媒体查询脱节。
    change();
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    for (const space of spaces) {
      if (
        facts.runtime?.items.some((item) => item.workspaceId === space.id && item.phase === 'idle')
      )
        void refreshHistory(space).catch((reason) => report(failure(reason)));
    }
  }, [facts.runtime, spaces, refreshHistory, report]);
  // 新对话的唯一创建入口：先按用户暂存的模型配置会话，再交给界面。
  // 「新建对话」按钮与「直接输入后发送」都必须走这里，否则会出现选择被丢弃的静默不一致。
  async function createSession(space: Workspace) {
    // 提交界面实际展示的可用模型，而非失效的临时选择或无凭证的默认值。
    const profileId = composerModel?.id;
    const result = await api.session.create(space.id, profileId);
    if (!profileId || profileId === result.configuration.profileId) {
      setPendingProfile(undefined);
      return result;
    }
    const configuration = await api.session.configure({
      ...scopeOf(result),
      profileId,
    });
    setPendingProfile(undefined);
    return { ...result, configuration };
  }
  async function openConversation(conversationId?: string, space = workspace) {
    if (!space) return;
    if (space.id !== current.current?.id) await selectSpace(space);
    const result = conversationId
      ? await api.session.open({ workspaceId: space.id, conversationId })
      : await createSession(space);
    ui.select(space.id, result.conversationId);
    setDetails(undefined);
    setOpened(result);
    await client.select(scopeOf(result));
    // 标题栏不再常驻审批计数，打开一个仍在等审批的会话就进入队列：否则用户手动关掉
    // 自动弹出的面板后没有第二个入口，只能等审批超时被自动拒绝。
    if (client.snapshot().approvals.some((item) => item.sessionId === result.conversationId))
      openApprovals(true);
    await refreshHistory(space);
  }
  async function configure(change: Parameters<DesktopAPI['session']['configure']>[0]) {
    if (!opened) return;
    const configuration = await api.session.configure(change);
    setOpened({ ...opened, configuration });
  }
  // 归档或删除后逐空间重取列表：设置页的归档页聚合全部空间，只刷新一个会留下过期行。
  async function refreshSpaces() {
    for (const space of spaces) if (space.trusted) await refreshHistory(space);
    setArchiveRevision((value) => value + 1);
  }
  /** 归档/删除都会让 Host 关闭该会话句柄，页面必须同步收敛，否则停在失效快照上。 */
  async function dropOpenView(workspaceId: string, conversationId: string) {
    if (opened?.workspaceId !== workspaceId || opened.conversationId !== conversationId) return;
    ui.select(workspaceId, '');
    setDetails(undefined);
    setOpened(undefined);
    await client.clear();
  }
  async function archiveConversation(
    space: Workspace,
    row: { conversationId: string; title: string },
  ) {
    await act(async () => {
      await api.session.archive({
        workspaceId: space.id,
        conversationId: row.conversationId,
      });
      await dropOpenView(space.id, row.conversationId);
      await refreshSpaces();
    });
  }
  async function deleteConversation(target: SessionTarget) {
    setPendingDelete(undefined);
    await act(async () => {
      await api.session.delete({
        workspaceId: target.workspaceId,
        conversationId: target.conversationId,
      });
      await dropOpenView(target.workspaceId, target.conversationId);
      await refreshSpaces();
    });
  }
  /** 改名只写标题记录：保留已打开的视图与运行句柄，仅重取该空间列表以更新标题。 */
  async function renameConversation(target: SessionTarget, title: string) {
    setPendingRename(undefined);
    await act(async () => {
      await api.session.rename({
        workspaceId: target.workspaceId,
        conversationId: target.conversationId,
        title,
      });
      const space = spaces.find((item) => item.id === target.workspaceId);
      if (space) await refreshHistory(space);
    });
  }
  /** 置顶只改列表次序，Host 已按置顶优先排序，页面不再自行重排。 */
  async function pinConversation(
    space: Workspace,
    row: { conversationId: string; pinned?: boolean },
  ) {
    await act(async () => {
      await api.session.pin({
        workspaceId: space.id,
        conversationId: row.conversationId,
        pinned: !row.pinned,
      });
      await refreshHistory(space);
    });
  }
  // 已打开会话直接改本会话配置；新对话只暂存选择，创建成功后随首个任务一起生效。
  function chooseModel(profileId: string) {
    if (!opened) {
      setPendingProfile(profileId);
      return;
    }
    void act(() => configure({ ...scopeOf(opened), profileId }));
  }
  async function send() {
    const input = draft.trim();
    if (!input || busy) return;
    // 斜杠输入不再发给模型：会话内走与 CLI 同源的命令系统，反馈以命令消息呈现。
    // `/skill <名称>` 无任务直发由宿主层承接（合成启动任务走收据管线），此处不拦。
    if (input.startsWith('/')) {
      if (!opened) {
        report('斜杠命令需要在已打开的会话中使用。');
        return;
      }
      await act(async () => {
        const result = await api.run.command({
          workspaceId: opened.workspaceId,
          sessionId: opened.sessionId,
          input,
        });
        if (!result.handled) report(`未知命令：${input.split(/\s+/)[0]}`);
        else if (result.feedback.length) pushFeedback(result.feedback);
        ui.draft(`${opened.workspaceId}:${opened.conversationId}`, '');
      });
      return;
    }
    if (opened) {
      if (!facts.valid || !readyToSend || running) return;
      await act(async () => {
        await client.start(scopeOf(opened), input);
        ui.draft(`${opened.workspaceId}:${opened.conversationId}`, '');
      });
      return;
    }
    // 未打开会话：发送即以当前所选空间创建会话并启动任务，不插入中间确认步骤；
    // 项目空间未信任时仍必须先走信任确认，不能静默代用户授权。
    if (!workspace?.trusted || !facts.runtimeValid) return;
    // 没有可用模型时创建会话只会拿到一个必然失败的运行，先让用户去配置密钥。
    if (!composerModel) {
      report('还没有可用模型，请先在设置中为模型填写密钥。');
      return;
    }
    await act(async () => {
      const result = await createSession(workspace);
      ui.select(workspace.id, result.conversationId);
      setOpened(result);
      await client.select(scopeOf(result));
      await client.whenReady();
      await client.start(scopeOf(result), input);
      ui.draft(':new', '');
    });
  }
  const currentTitle =
    histories[workspace?.id ?? '']?.items.find(
      (item) => item.conversationId === opened?.conversationId,
    )?.title || '新对话';
  // 顶栏只回答「现在处于什么状态」，绝对路径与内部计数留在详情和诊断里。
  const headerHint = !workspace
    ? '选择空间后开始'
    : opened
      ? runtimeLabel(runtimeItem, facts.runtimeValid !== false) || '可以继续对话'
      : '新建对话或从历史继续';
  const detailTool =
    details?.kind === 'tool'
      ? messages
          .flatMap((message) => message.blocks)
          .find((block) => block.tool?.callId === details.callId)?.tool
      : undefined;
  // 输入卡在首页与对话页共用：只改变落点，不复制发送、模式与模型选择逻辑。
  const [commandList, setCommandList] = useState<Output<'run.commandList'>>();
  const [skillList, setSkillList] = useState<Output<'run.skillCatalog'>>();
  const [fileList, setFileList] = useState<{
    files: string[];
    truncated: boolean;
  }>();
  const [completion, setCompletion] = useState<{
    kind: 'command' | 'file';
    items: { group?: 'command' | 'skill'; insert: string; label: string; detail: string }[];
    index: number;
  }>();
  /**
   * 输入框上方的命令反馈卡片堆：最新在最上，每张可独立关闭，超过 5 张淘汰最旧。
   * 卡片宽度随内容收缩（上限 44rem），长输出内部滚动——不再是一条通栏横幅。
   */
  const [commandFeedbacks, setCommandFeedbacks] = useState<{ id: string; lines: string[] }[]>([]);
  const pushFeedback = useCallback((lines: string[]) => {
    setCommandFeedbacks((prev) => [{ id: crypto.randomUUID(), lines }, ...prev].slice(0, 5));
  }, []);
  // 反馈是输入框场景的即时引导：切换会话后旧反馈只会造成误导，按 scope 变化清空。
  const feedbackScope = opened ? `${opened.workspaceId}:${opened.conversationId}` : ':new';
  const [feedbackScopeOwner, setFeedbackScopeOwner] = useState(feedbackScope);
  if (feedbackScopeOwner !== feedbackScope) {
    setFeedbackScopeOwner(feedbackScope);
    setCommandFeedbacks([]);
  }
  const [interactionValue, setInteractionValue] = useState('');
  // 新一轮交互到达时清掉上一轮残留输入：secret 明文绝不跨请求存续。
  // 渲染期重置模式（按请求切换清空）：超时/取消路径不会触发成功应答的清空，
  // 必须以请求标识变化为锚点兜底。
  const interactionKey = facts.interactions[0]?.requestId ?? '';
  const [interactionValueOwner, setInteractionValueOwner] = useState(interactionKey);
  if (interactionValueOwner !== interactionKey) {
    setInteractionValueOwner(interactionKey);
    setInteractionValue('');
  }

  /** 命令目录、技能目录与文件清单的补全数据源；目录随会话加载，文件随工作区变化刷新。 */
  const fileListGeneration = useRef(0);
  const openedWorkspaceId = opened?.workspaceId;
  const openedSessionId = opened?.sessionId;
  const refreshCompletionSources = useCallback(() => {
    void api.run
      .commandList()
      .then(setCommandList)
      .catch(() => {});
    // 代际守卫：快速切换工作区/会话时，上一轮的慢响应可能后到并覆盖当前清单
    //（@ 补全会插入错误路径、技能组跨会话串目录）。每轮 refresh 只自增一次，
    // 技能与文件两个回包共用同一代数，新一轮 refresh 使两者的旧回包同时失效。
    const generation = ++fileListGeneration.current;
    // 技能目录双数据源：会话内用运行时目录（「现在就能跑」）；未打开会话时退化为
    // 配置层快照预览（新会话将可用的技能），两条路径同一条过滤口径——否则 home
    // 态 `/` 面板只剩命令组，技能搜索看起来像坏了。
    if (!openedWorkspaceId || !openedSessionId) {
      const previewSpace = openedWorkspaceId ?? spaces[0]?.id;
      if (!previewSpace) {
        setSkillList(undefined);
      } else {
        void api.resources
          .readSkills(previewSpace)
          .then((snapshot) => {
            if (generation !== fileListGeneration.current) return;
            // 全局开关关闭时新会话不会注册技能工具，预览如实留空。
            const usable = snapshot.enabled
              ? snapshot.skills.filter(
                  (skill) => skill.userInvocable && skill.available && !skill.disabled,
                )
              : [];
            setSkillList({
              installed: snapshot.skills.length > 0,
              skills: usable.slice(0, 500).map((skill) => ({
                name: skill.name,
                description:
                  skill.description.length > 256
                    ? `${skill.description.slice(0, 256)}…`
                    : skill.description,
                scope: skill.scope,
              })),
              truncated: usable.length > 500,
            });
          })
          .catch(() => {
            if (generation === fileListGeneration.current) setSkillList(undefined);
          });
      }
    } else {
      void api.run
        .skillCatalog({ workspaceId: openedWorkspaceId, sessionId: openedSessionId })
        .then((result) => {
          if (generation === fileListGeneration.current) setSkillList(result);
        })
        .catch(() => {
          if (generation === fileListGeneration.current) setSkillList(undefined);
        });
    }
    const workspaceId = openedWorkspaceId ?? spaces[0]?.id;
    if (!workspaceId) {
      setFileList(undefined);
      return;
    }
    void api.workspace
      .listFiles(workspaceId)
      .then((result) => {
        if (generation === fileListGeneration.current) setFileList(result);
      })
      .catch(() => {
        if (generation === fileListGeneration.current) setFileList(undefined);
      });
  }, [openedWorkspaceId, openedSessionId, spaces]);
  useEffect(() => {
    refreshCompletionSources();
  }, [refreshCompletionSources]);

  /**
   * 触发符识别：`/` 分组面板（命令在前、技能在后）与 `@` 文件态互斥。
   * `/skill ` 的名字段是第二触发形态（CLI 同款）：`/skill ` 或 `/skill <前缀>`
   * 只列技能名，出现任务段（第二个空白后的内容）后不再弹出。
   */
  useEffect(() => {
    const skillTail = /^\/skill\s+(\S*)$/.exec(draft);
    if (skillTail) {
      const prefix = skillTail[1].toLowerCase();
      const items = (skillList?.skills ?? [])
        .filter((skill) => skill.name.toLowerCase().startsWith(prefix))
        .slice(0, 8)
        .map((skill) => ({
          group: 'skill' as const,
          insert: `/skill ${skill.name} `,
          label: `/skill ${skill.name}`,
          detail: skill.description,
        }));
      setCompletion(items.length ? { kind: 'command', items, index: 0 } : undefined);
      return;
    }
    if (draft.startsWith('/') && !/\s/.test(draft)) {
      const prefix = draft.slice(1).toLowerCase();
      const commandItems = (commandList?.commands ?? [])
        .filter((item) => item.name.toLowerCase().startsWith(prefix))
        .slice(0, 8)
        .map((item) => ({
          group: 'command' as const,
          insert: `/${item.name} `,
          label: `/${item.name}`,
          detail: item.description,
        }));
      const skillItems = (skillList?.skills ?? [])
        .filter(
          (skill) =>
            skill.name.toLowerCase().startsWith(prefix) ||
            skill.description.toLowerCase().includes(prefix),
        )
        .slice(0, 8)
        .map((skill) => ({
          group: 'skill' as const,
          insert: `/skill ${skill.name} `,
          label: `/skill ${skill.name}`,
          detail: skill.description,
        }));
      // 保序拼接：命令组在前、技能组在后，键盘导航按扁平 index 环形移动。
      const items = [...commandItems, ...skillItems];
      setCompletion(items.length ? { kind: 'command', items, index: 0 } : undefined);
      return;
    }
    const at = draft.lastIndexOf('@');
    if (at >= 0 && !/\s/.test(draft.slice(at + 1))) {
      const prefix = draft.slice(at + 1).toLowerCase();
      const items = (fileList?.files ?? [])
        .filter((file) => file.toLowerCase().includes(prefix))
        .slice(0, 8)
        .map((file) => ({ insert: `@${file}`, label: file, detail: '' }));
      setCompletion(items.length ? { kind: 'file', items, index: 0 } : undefined);
      return;
    }
    setCompletion(undefined);
  }, [draft, commandList, fileList, skillList]);

  const draftScope = opened ? `${opened.workspaceId}:${opened.conversationId}` : ':new';

  /** 补全确认：命令替换整段草稿，文件替换最后一个 @ 触发段。 */
  function acceptCompletion(current: NonNullable<typeof completion>): void {
    const item = current.items[current.index];
    if (current.kind === 'command') {
      ui.draft(draftScope, item.insert);
      return;
    }
    const at = draft.lastIndexOf('@');
    if (at < 0) return;
    ui.draft(draftScope, `${draft.slice(0, at)}${item.insert} `);
  }

  const composer = (
    <div ref={composerShell} className="relative w-full space-y-2">
      {completion && (
        // 浮层与输入卡同宽并居中对齐：宿主外壳是整列宽度，直接 left-3/right-3 会横跨阅读列。
        <div className="absolute inset-x-0 bottom-full z-20 mx-auto mb-1 w-full max-w-[var(--kapibala-content-max)]">
          <div className="max-h-56 overflow-y-auto rounded-lg border border-kumo-line bg-kumo-recessed p-1 shadow-lg">
            {completion.kind === 'file' && fileList?.truncated && (
              <p className="px-2 py-1 text-xs text-kumo-subtle">
                文件较多，列表未列全；可继续输入路径缩小范围。
              </p>
            )}
            {completion.kind === 'file' &&
              completion.items.map((item, index) => (
                <Button
                  key={item.label}
                  variant="ghost"
                  size="sm"
                  className={
                    index === completion.index
                      ? 'flex w-full items-center gap-2 rounded-md bg-kumo-brand/15 px-2 py-1.5 text-left'
                      : 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left'
                  }
                  onMouseDown={(event) => {
                    event.preventDefault();
                    acceptCompletion(completion);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </Button>
              ))}
            {completion.kind === 'command' &&
              (
                [
                  { key: 'command', title: '命令' },
                  { key: 'skill', title: '技能' },
                ] as const
              ).map(({ key, title }) => {
                const indexed = completion.items.flatMap((item, index) =>
                  item.group === key ? [{ item, index }] : [],
                );
                if (indexed.length === 0) return undefined;
                return (
                  <div key={key}>
                    <p className="px-2 pt-1 pb-0.5 text-xs font-medium text-kumo-subtle">
                      {title}（{indexed.length}）
                    </p>
                    {indexed.map(({ item, index }) => (
                      <Button
                        key={item.label}
                        variant="ghost"
                        size="sm"
                        className={
                          index === completion.index
                            ? 'flex w-full items-center gap-2 rounded-md bg-kumo-brand/15 px-2 py-1.5 text-left'
                            : 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left'
                        }
                        onMouseDown={(event) => {
                          event.preventDefault();
                          acceptCompletion(completion);
                        }}
                      >
                        <span className="w-32 shrink-0 truncate">{item.label}</span>
                        {item.detail && (
                          <span className="min-w-0 flex-1 truncate text-right text-xs text-kumo-subtle">
                            {item.detail}
                          </span>
                        )}
                      </Button>
                    ))}
                  </div>
                );
              })}
            {/* 空技能组的提示只在未过滤时出现：用户正按前缀过滤时不该被无关提示打扰。 */}
            {completion.kind === 'command' &&
              skillList &&
              skillList.skills.length === 0 &&
              (draft === '/' || /^\/skill\s*$/.test(draft)) && (
                <p className="px-2 py-1 text-xs text-kumo-subtle">
                  {skillList.installed
                    ? '技能已全部禁用或当前不可调用；可在设置的「资源管理」页调整。'
                    : '没有已安装的技能；全局技能目录见设置的「资源管理」页。'}
                </p>
              )}
            {completion.kind === 'command' && completion.items.length > 0 && (
              <p className="px-2 pt-1 pb-0.5 text-xs text-kumo-subtle">
                ↑↓ 切换 · Tab/Enter 补全 · Esc 关闭
              </p>
            )}
          </div>
        </div>
      )}
      {/* 触发符激活但零匹配时也要出现面板：搜索「看起来坏了」比「无匹配」更伤可用性。
          覆盖两种触发形态（/ 前缀、/skill 名字段）；任务段态与 @ 态不在此列。 */}
      {!completion && (/^\/\S*$/.test(draft) || /^\/skill\s+\S*$/.test(draft)) && (
        <div className="absolute inset-x-0 bottom-full z-20 mx-auto mb-1 w-full max-w-[var(--kapibala-content-max)]">
          <div className="rounded-lg border border-kumo-line bg-kumo-recessed p-1 shadow-lg">
            <p className="px-2 py-1 text-xs text-kumo-subtle">
              无匹配的命令或技能；继续输入可缩小范围。
            </p>
          </div>
        </div>
      )}
      {commandFeedbacks.length > 0 && (
        <div className="mx-auto flex w-full max-w-[var(--kapibala-content-max)] flex-col gap-2">
          {commandFeedbacks.map((entry) => (
            <div
              key={entry.id}
              className="relative w-full rounded-lg border border-kumo-line bg-kumo-recessed py-2 pr-11 pl-3 text-sm"
            >
              <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
                {entry.lines.map((line, index) => (
                  <p key={`${index}:${line}`}>{line}</p>
                ))}
              </div>
              <Button
                variant="ghost"
                size="sm"
                aria-label="关闭该条反馈"
                className="absolute top-1 right-1"
                onClick={() =>
                  setCommandFeedbacks((prev) => prev.filter((item) => item.id !== entry.id))
                }
              >
                <XIcon size={14} />
              </Button>
            </div>
          ))}
        </div>
      )}
      {/* 输入、空间、模型、模式与发送同属一张卡：焦点由卡片整体承担，工具条保持低权重。 */}
      <div className="kapibala-composer px-3 pt-3 pb-2">
        <InputArea
          aria-label="发送消息"
          placeholder={opened ? '继续对话…' : '描述你想完成的任务…'}
          value={draft}
          onValueChange={(value) =>
            ui.draft(opened ? `${opened.workspaceId}:${opened.conversationId}` : ':new', value)
          }
          disabled={busy}
          autoResize
          minRows={1}
          maxRows={8}
          className="max-h-[200px] rounded-none bg-transparent px-2 py-1 ring-0 focus:ring-0"
          onKeyDown={(event) => {
            // IME 组合中的按键（含提交候选词的 Enter）不参与补全与发送：
            // 补全面板开着时敲中文输入法回车，会被吞成「接受补全」丢字。
            if (event.nativeEvent.isComposing) return;
            if (completion) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const next =
                  (completion.index +
                    (event.key === 'ArrowDown' ? 1 : completion.items.length - 1)) %
                  completion.items.length;
                setCompletion({ ...completion, index: next });
                return;
              }
              if (event.key === 'Tab' || event.key === 'Enter') {
                event.preventDefault();
                // 草稿已与高亮补全等价（完整命令或完整技能名）时 Enter 直接发送：
                // 此时补全只剩「加一个空格」的语义，要求再按一次才能发送是纯粹的手感摩擦
                //（典型场景：/skill <名称> 输完回车应立即执行）。
                const highlighted = completion.items[completion.index];
                if (
                  event.key === 'Enter' &&
                  highlighted &&
                  highlighted.insert.trim() === draft.trim()
                ) {
                  void send();
                  return;
                }
                acceptCompletion(completion);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setCompletion(undefined);
                return;
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-0.5">
            {/* 空间入口在会话内外都保留：换目标空间不必先回侧栏；切空间会关闭当前会话视图，运行中的任务仍在后台。 */}
            <DropdownMenu>
              <DropdownMenu.Trigger
                render={
                  <Button
                    className="kapibala-action kapibala-chip max-w-48"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={workspace ? `会话空间：${workspace.name}` : '选择空间'}
                  >
                    <KubaiIcon name="项目空间" size={18} />
                    <span className="min-w-0 truncate">{workspace?.name ?? '选择空间'}</span>
                    <CaretDownIcon size={13} className="shrink-0 text-kumo-subtle" />
                  </Button>
                }
              />
              <DropdownMenu.Content>
                <div className="px-2 py-2" onKeyDown={(event) => event.stopPropagation()}>
                  <Input
                    size="sm"
                    aria-label="搜索项目"
                    placeholder="搜索项目"
                    className="w-full bg-transparent text-sm"
                    value={projectSearch}
                    onValueChange={setProjectSearch}
                  />
                </div>
                <DropdownMenu.Group>
                  <DropdownMenu.Label>空间</DropdownMenu.Label>
                  {spaces
                    .filter((space) =>
                      space.name.toLowerCase().includes(projectSearch.trim().toLowerCase()),
                    )
                    .map((space) => (
                      <DropdownMenu.Item
                        key={space.id}
                        onClick={() => void act(() => selectSpace(space))}
                      >
                        <FolderSimpleIcon size={16} className="text-kumo-subtle" />
                        <span className="min-w-0 flex-1 truncate">{space.name}</span>
                        {space.id === workspace?.id && <CheckIcon size={14} />}
                      </DropdownMenu.Item>
                    ))}
                </DropdownMenu.Group>
                {recent.length > 0 && (
                  <DropdownMenu.Group>
                    <DropdownMenu.Label>最近项目</DropdownMenu.Label>
                    {recent
                      .filter(
                        (item) =>
                          !spaces.some((space) => space.recentId === item.id) &&
                          item.name.toLowerCase().includes(projectSearch.trim().toLowerCase()),
                      )
                      .map((item) => (
                        <DropdownMenu.Item
                          key={item.id}
                          onClick={() =>
                            void act(async () =>
                              selectSpace(await api.workspace.openRecent(item.id)),
                            )
                          }
                        >
                          <FolderSimpleIcon size={16} className="text-kumo-subtle" />
                          <span className="min-w-0 flex-1 truncate">{item.name}</span>
                        </DropdownMenu.Item>
                      ))}
                  </DropdownMenu.Group>
                )}
                <DropdownMenu.Separator />
                <DropdownMenu.Item onClick={() => setProjectOpen(true)}>
                  <FolderPlusIcon size={16} className="text-kumo-subtle" />
                  新建项目
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu>
            {opened && (
              <DropdownMenu>
                <DropdownMenu.Trigger
                  render={
                    <Button
                      className="kapibala-action kapibala-chip"
                      variant="ghost"
                      size="sm"
                      disabled={Boolean(running) || busy}
                      aria-label={`会话模式：${MODE_NAMES[opened.configuration.mode]}`}
                    >
                      <ModeGlyph mode={opened.configuration.mode} size={18} />
                      <span className="min-w-0 truncate">
                        {MODE_NAMES[opened.configuration.mode]}
                      </span>
                      <CaretDownIcon size={13} className="shrink-0 text-kumo-subtle" />
                    </Button>
                  }
                />
                <DropdownMenu.Content>
                  {MODE_ORDER.map((mode, index) => (
                    <Fragment key={mode}>
                      {index === 1 && <DropdownMenu.Separator />}
                      <DropdownMenu.Item
                        onClick={() => {
                          if (mode === 'FullAccess') setFullAccess(true);
                          else void act(() => configure({ ...scopeOf(opened), mode }));
                        }}
                      >
                        <ModeGlyph mode={mode} />
                        <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
                          <span className="truncate">{MODE_NAMES[mode]}</span>
                          <span className="truncate text-xs text-kumo-subtle">
                            {MODE_HINTS[mode]}
                          </span>
                        </span>
                        {opened.configuration.mode === mode && <CheckIcon size={14} />}
                      </DropdownMenu.Item>
                    </Fragment>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu>
            )}
            <DropdownMenu>
              <DropdownMenu.Trigger
                render={
                  <Button
                    className="kapibala-action kapibala-chip max-w-56"
                    variant="ghost"
                    size="sm"
                    disabled={Boolean(running) || busy}
                    aria-label={
                      opened
                        ? `当前会话模型：${composerModel?.name ?? '选择模型'}`
                        : `新对话模型：${composerModel?.name ?? '选择模型'}`
                    }
                  >
                    <span className="min-w-0 truncate">{composerModel?.name ?? '未配置模型'}</span>
                    <CaretDownIcon size={13} className="shrink-0 text-kumo-subtle" />
                  </Button>
                }
              />
              {/* 内置清单有二十个模型，限制高度让其内部滚动，避免菜单铺满整窗。 */}
              <DropdownMenu.Content className="max-h-[min(20rem,var(--available-height))]">
                {opened && (
                  <>
                    <DropdownMenu.Sub>
                      <DropdownMenu.SubTrigger>
                        会话角色：{ROLE_NAMES[opened.configuration.role]}
                      </DropdownMenu.SubTrigger>
                      <DropdownMenu.SubContent>
                        {(
                          [
                            ['default', '默认'],
                            ['planning', '规划'],
                            ['execution', '执行'],
                            ['fast', '快速'],
                          ] as const
                        ).map(([role, name]) => (
                          <DropdownMenu.Item
                            key={role}
                            onClick={() => void act(() => configure({ ...scopeOf(opened), role }))}
                          >
                            <span className="min-w-0 flex-1">{name}</span>
                            {opened.configuration.role === role && <CheckIcon size={14} />}
                          </DropdownMenu.Item>
                        ))}
                      </DropdownMenu.SubContent>
                    </DropdownMenu.Sub>
                    <DropdownMenu.Separator />
                  </>
                )}
                <DropdownMenu.Group>
                  <DropdownMenu.Label>
                    {opened ? '本会话模型' : '新对话使用的模型'}
                  </DropdownMenu.Label>
                  {usableModels.map((model) => (
                    <DropdownMenu.Item key={model.id} onClick={() => chooseModel(model.id)}>
                      <span className="min-w-0 flex-1 truncate">{model.name}</span>
                      {model.id === composerModel?.id && <CheckIcon size={14} />}
                    </DropdownMenu.Item>
                  ))}
                  {usableModels.length === 0 && (
                    <DropdownMenu.Item onClick={() => ui.settings(true)}>
                      <span className="min-w-0 flex-1 truncate">还没有可用模型，去设置</span>
                    </DropdownMenu.Item>
                  )}
                </DropdownMenu.Group>
              </DropdownMenu.Content>
            </DropdownMenu>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {running ? (
              <Button
                className="kapibala-action kapibala-chip"
                size="sm"
                variant="secondary"
                disabled={run.phase !== 'running'}
                onClick={() =>
                  opened &&
                  void api.run
                    .cancel({ ...scopeOf(opened), runId: run.runId })
                    .catch((reason) => report(failure(reason)))
                }
              >
                <StopIcon size={15} />
                {run.phase === 'running'
                  ? '停止'
                  : run.phase === 'cancelling'
                    ? '正在取消'
                    : '正在清理'}
              </Button>
            ) : (
              <Button
                className="kapibala-action kapibala-send text-(--text-color-kumo-inverse)!"
                size="base"
                variant="primary"
                shape="square"
                style={
                  {
                    '--kumo-button-emphasis-ring': 'var(--color-kumo-focus)',
                  } as CSSProperties
                }
                aria-label="发送"
                disabled={busy || !canSend}
                onClick={() => void send()}
              >
                <ArrowUpIcon size={17} weight="bold" />
              </Button>
            )}
          </div>
        </div>
      </div>
      {!opened && workspace && !workspace.trusted && (
        <p className="kapibala-composer-hint px-1 text-kumo-warning">
          当前空间尚未信任，确认信任后才能发送。
        </p>
      )}
      {/* 没有密钥时直接说清阻断原因并给出入口，不让用户点了发送才发现不可用。 */}
      {usableModels.length === 0 && (
        <p className="kapibala-composer-hint flex flex-wrap items-center gap-1 px-1 text-kumo-warning">
          <span>还没有可用模型，请先在</span>
          <Button
            className="kapibala-action h-auto px-1 py-0 text-xs underline underline-offset-2"
            variant="ghost"
            size="sm"
            onClick={() => ui.settings(true)}
          >
            设置
          </Button>
          <span>中为模型填写密钥。</span>
        </p>
      )}
    </div>
  );

  return (
    <Sidebar.Provider
      open={ui.sidebarOpen}
      onOpenChange={ui.sidebar}
      collapsible="icon"
      resizable={false}
      animationDuration={0}
      mobileBreakpoint={768}
      style={
        {
          '--sidebar-width': 'var(--kapibala-sidebar-width)',
          '--sidebar-width-icon': 'var(--kapibala-sidebar-icon-width)',
          '--sidebar-bg': 'var(--kapibala-sidebar-surface)',
        } as CSSProperties
      }
      className="h-full min-h-0"
    >
      <WorkspaceSidebar
        spaces={spaces}
        histories={histories}
        activeWorkspaceId={workspace?.id}
        conversationId={opened?.conversationId}
        runtime={facts.runtime}
        runtimeValid={facts.runtimeValid === true}
        busy={busy}
        onSpace={(space) =>
          void act(async () => {
            await selectSpace(space);
            const selected = ui.selected[space.id];
            if (selected) await openConversation(selected, space);
          })
        }
        onDefault={() => void act(async () => selectSpace(await api.workspace.openDefault()))}
        onNew={() => void act(() => openConversation())}
        onNewInSpace={(space) => void act(() => openConversation(undefined, space))}
        onOpen={(space, conversationId) => void act(() => openConversation(conversationId, space))}
        onRename={(space, row) =>
          setPendingRename({
            workspaceId: space.id,
            conversationId: row.conversationId,
            title: row.title,
          })
        }
        onPin={(space, row) => void pinConversation(space, row)}
        onArchive={(space, row) => void archiveConversation(space, row)}
        onDelete={(space, row) =>
          setPendingDelete({
            workspaceId: space.id,
            conversationId: row.conversationId,
            title: row.title,
          })
        }
        onPage={(space, page) => void act(() => refreshHistory(space, page))}
        onSettings={() => ui.settings(true)}
        onRefreshRuntime={() => void act(() => client.connectRuntime())}
        onClose={(item) =>
          void act(async () => {
            await api.session.close({
              workspaceId: item.workspaceId,
              sessionId: item.sessionId,
            });
            ui.select(item.workspaceId, '');
            if (opened?.sessionId === item.sessionId) {
              setOpened(undefined);
              await client.clear();
            }
            const space = spaces.find((space) => space.id === item.workspaceId);
            await refreshHistory(space);
          })
        }
      />
      <div ref={containerRef} className="relative flex min-w-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col bg-kumo-base">
          <header className="kapibala-titlebar flex shrink-0 items-center justify-between gap-3 px-4">
            <div className="flex min-w-0 items-center gap-2">
              <Sidebar.Trigger aria-label="展开或收起侧栏" />
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium">
                  {workspace?.name ?? '选择空间'}
                  {opened ? ` / ${currentTitle}` : ''}
                </p>
                <p className="truncate text-[11px] text-kumo-subtle">{headerHint}</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {opened && (
                <Button
                  className="kapibala-action kapibala-chip"
                  variant="ghost"
                  size="sm"
                  onClick={(event) => {
                    detailTrigger.current = event.currentTarget;
                    setDetails({ kind: 'status' });
                  }}
                >
                  会话状态
                </Button>
              )}
              {opened && (
                <Button
                  className="kapibala-action"
                  variant="ghost"
                  shape="square"
                  size="sm"
                  aria-label="关闭当前会话"
                  onClick={() =>
                    void act(async () => {
                      await api.session.close(scopeOf(opened));
                      ui.select(opened.workspaceId, '');
                      setDetails(undefined);
                      setOpened(undefined);
                      await client.clear();
                      await refreshHistory();
                    })
                  }
                >
                  <XIcon size={16} />
                </Button>
              )}
            </div>
          </header>
          {(error || facts.error) && (
            <div
              role="alert"
              className="flex shrink-0 flex-wrap items-center gap-3 border-b border-kumo-line bg-kumo-recessed px-5 py-3 text-sm"
            >
              <span className="min-w-0 flex-1">{error || facts.error}</span>
              {opened && (
                <Button
                  className="kapibala-action"
                  variant="secondary"
                  onClick={() => void act(() => client.refreshRun(scopeOf(opened)))}
                >
                  查询运行状态
                </Button>
              )}
              {opened && (
                <Button
                  className="kapibala-action"
                  variant="secondary"
                  onClick={() => void act(() => client.resync())}
                >
                  重新同步
                </Button>
              )}
              <Button className="kapibala-action" variant="ghost" onClick={() => ui.settings(true)}>
                检查设置
              </Button>
              <Button
                className="kapibala-action"
                variant="ghost"
                onClick={() => void api.app.reconnect().catch((reason) => report(failure(reason)))}
              >
                核查并重新连接
              </Button>
            </div>
          )}
          {opened ? (
            facts.state ? (
              <MessageList
                key={`${opened.workspaceId}:${opened.conversationId}`}
                memoryKey={`${opened.workspaceId}:${opened.conversationId}`}
                messages={messages}
                scrollRef={scrollRef}
                onTool={(callId, trigger) => {
                  detailTrigger.current = trigger;
                  setDetails({ kind: 'tool', callId });
                }}
                onEdit={(text) => {
                  // 编辑 = 回填草稿并聚焦，不截断已落盘历史；发送即作为新消息继续。
                  ui.draft(
                    opened ? `${opened.workspaceId}:${opened.conversationId}` : ':new',
                    text,
                  );
                  requestAnimationFrame(() => {
                    composerShell.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
                  });
                }}
                report={report}
              />
            ) : (
              <div className="min-h-0 flex-1 p-6 text-sm text-kumo-subtle" aria-busy="true">
                正在加载历史…
              </div>
            )
          ) : (
            <div className="kapibala-home">
              {/* 首页只保留吉祥物、标题与输入卡：动作入口在侧栏与输入卡内，首屏不再堆叠重复按钮。 */}
              <div className="kapibala-home-stack">
                <div className="kapibala-home-hero">
                  <img src={brandMark} alt="" aria-hidden="true" className="kapibala-home-mark" />
                  <h1 className="kapibala-home-title">今天想做点什么？</h1>
                  <p className="kapibala-home-subtitle">
                    描述任务后按 Enter 发送；其它空间运行中的任务会在后台继续。
                  </p>
                  <div className="kapibala-home-starters">
                    {STARTERS.map((starter) => (
                      <Button
                        key={starter}
                        className="kapibala-action kapibala-starter"
                        variant="secondary"
                        size="sm"
                        onClick={() => ui.draft(':new', starter)}
                      >
                        {starter}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="kapibala-home-composer">{composer}</div>
              </div>
            </div>
          )}
          {/* 诊断通知改由右上角浮层承载：不再挤压对话流与输入区，出现即提醒，可逐条关闭。 */}
          <NoticeToasts
            notices={facts.state?.notices ?? []}
            dismissed={ui.dismissedNotices}
            onDismiss={ui.dismissNotice}
          />
          {opened && <footer className="kapibala-composer-dock shrink-0">{composer}</footer>}
        </main>
        {details && wide && (
          <div className="w-(--kapibala-dock-width) shrink-0" aria-hidden="true" />
        )}
        <DetailsDrawer
          target={details}
          tool={detailTool}
          inspection={facts.inspection}
          runtime={runtimeItem}
          title={`${workspace?.name ?? ''} / ${currentTitle}`}
          root={workspace?.root ?? ''}
          wide={wide}
          container={containerRef}
          trigger={detailTrigger}
          fallback={scrollRef}
          onClose={() => setDetails(undefined)}
        />
      </div>
      <ProjectDialog open={projectOpen} onOpenChange={setProjectOpen} onCreated={selectSpace} />
      <SettingsDialog
        open={ui.settingsOpen}
        onOpenChange={ui.settings}
        catalog={catalog}
        reload={reloadCatalog}
        report={report}
        hostDown={facts.error !== undefined || facts.runtimeValid === false}
        spaces={spaces}
        workspaceId={opened?.workspaceId ?? spaces[0]?.id}
        archiveRevision={archiveRevision}
        onArchivedChanged={() => void refreshSpaces().catch((reason) => report(failure(reason)))}
        onRequestDelete={setPendingDelete}
      />
      {facts.interactions[0] && (
        <div className="fixed inset-x-0 bottom-24 z-30 mx-auto max-w-xl rounded-xl border border-kumo-line bg-kumo-default p-4 shadow-xl">
          <p className="mb-2 text-sm font-medium">{facts.interactions[0].prompt}</p>
          {facts.interactions[0].kind === 'select' ? (
            <div className="space-y-1">
              {(facts.interactions[0].options ?? []).map((option) => (
                <Button
                  key={option.value}
                  variant="outline"
                  size="sm"
                  className="w-full justify-start"
                  onClick={() => {
                    const request = facts.interactions[0];
                    if (!request) return;
                    void api.interaction
                      .reply({
                        workspaceId: request.workspaceId,
                        sessionId: request.sessionId,
                        requestId: request.requestId,
                        value: option.value,
                      })
                      .catch((reason) => report(failure(reason)));
                  }}
                >
                  {option.label}
                </Button>
              ))}
              {/* 与 CLI 的 Esc 取消同语义：不带 value 的应答由宿主映射为取消。 */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const request = facts.interactions[0];
                  if (!request) return;
                  void api.interaction
                    .reply({
                      workspaceId: request.workspaceId,
                      sessionId: request.sessionId,
                      requestId: request.requestId,
                    })
                    .catch((reason) => report(failure(reason)));
                }}
              >
                取消
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Input
                type={facts.interactions[0].kind === 'secret' ? 'password' : 'text'}
                aria-label={facts.interactions[0].prompt}
                value={interactionValue}
                onValueChange={setInteractionValue}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    const request = facts.interactions[0];
                    if (!request) return;
                    void api.interaction
                      .reply({
                        workspaceId: request.workspaceId,
                        sessionId: request.sessionId,
                        requestId: request.requestId,
                        value: interactionValue,
                      })
                      .then(() => setInteractionValue(''))
                      .catch((reason) => report(failure(reason)));
                  }
                }}
              />
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  const request = facts.interactions[0];
                  if (!request) return;
                  void api.interaction
                    .reply({
                      workspaceId: request.workspaceId,
                      sessionId: request.sessionId,
                      requestId: request.requestId,
                      value: interactionValue,
                    })
                    .then(() => setInteractionValue(''))
                    .catch((reason) => report(failure(reason)));
                }}
              >
                确定
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const request = facts.interactions[0];
                  if (!request) return;
                  void api.interaction
                    .reply({
                      workspaceId: request.workspaceId,
                      sessionId: request.sessionId,
                      requestId: request.requestId,
                    })
                    .then(() => setInteractionValue(''))
                    .catch((reason) => report(failure(reason)));
                }}
              >
                取消
              </Button>
            </div>
          )}
        </div>
      )}
      <SessionDeleteDialog
        target={pendingDelete}
        onCancel={() => setPendingDelete(undefined)}
        onConfirm={() => {
          if (pendingDelete) void deleteConversation(pendingDelete);
        }}
      />
      <SessionRenameDialog
        target={pendingRename}
        busy={busy}
        onCancel={() => setPendingRename(undefined)}
        onConfirm={(title) => {
          if (pendingRename) void renameConversation(pendingRename, title);
        }}
      />
      <LayerDialog
        open={Boolean(trust)}
        onOpenChange={(open) => {
          if (!open) setTrust(undefined);
        }}
      >
        <LayerDialog.Content size="sm" closeLabel="取消信任">
          <LayerDialog.Title>
            <span data-kapibala-modal="true">信任这个空间？</span>
          </LayerDialog.Title>
          <LayerDialog.Description>
            信任后会加载此目录的项目配置、指令、技能与 MCP。请确认目录来源可靠。
          </LayerDialog.Description>
          <LayerDialog.Body>
            <p className="mb-5 break-all font-mono text-sm">{trust?.root}</p>
            <div className="flex justify-end gap-3">
              <Button
                className="kapibala-action"
                variant="secondary"
                onClick={() =>
                  void act(async () => {
                    if (trust)
                      await api.workspace.confirmTrust({
                        workspaceId: trust.id,
                        trustToken: trust.trustToken,
                        accept: false,
                      });
                    setTrust(undefined);
                  })
                }
              >
                暂不信任
              </Button>
              <Button
                className="kapibala-action"
                onClick={() =>
                  void act(async () => {
                    if (!trust) return;
                    const space = await api.workspace.confirmTrust({
                      workspaceId: trust.id,
                      trustToken: trust.trustToken,
                      accept: true,
                    });
                    setTrust(undefined);
                    await selectSpace(space);
                  })
                }
              >
                信任并打开
              </Button>
            </div>
          </LayerDialog.Body>
        </LayerDialog.Content>
      </LayerDialog>
      <LayerDialog open={ui.approvalsOpen} onOpenChange={ui.approvals}>
        <LayerDialog.Content size="base" closeLabel="关闭审批队列">
          <LayerDialog.Title>
            <span data-kapibala-modal="true">待处理审批</span>
          </LayerDialog.Title>
          <LayerDialog.Description>
            关闭面板不会默认允许。超时、取消或控制连接断开后，请求会拒绝。
          </LayerDialog.Description>
          <LayerDialog.Body>
            {/* 弹窗正文按可用宽度换行：长路径与 JSON 参数不能把滚动内容撑得比弹窗更宽，
                否则右侧按钮会被裁到浮层外，看起来像被遮挡。 */}
            <div className="min-w-0 space-y-5">
              {facts.approvals.length === 0 && (
                <p className="text-sm text-kumo-subtle">当前没有待处理请求。</p>
              )}
              {facts.approvals.map((approval) => (
                <LayerCard key={approval.approvalId} className="min-w-0 space-y-3 p-4">
                  <p className="font-medium">{approval.toolName}</p>
                  <p className="break-all text-xs text-kumo-subtle">
                    空间：{approval.workspaceName}
                    <br />
                    {approval.workspaceRoot}
                    <br />
                    会话 {approval.conversationId} · 运行 {approval.runId}
                  </p>
                  <p className="break-all text-sm text-kumo-subtle">
                    {approval.capabilities.join('、')}
                  </p>
                  <pre className="max-h-48 min-w-0 overflow-auto font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {approval.description}
                  </pre>
                  <div className="flex flex-wrap justify-end gap-3">
                    {(
                      [
                        'deny_once',
                        'allow_once',
                        ...(approval.sessionAllowed ? ['allow_session'] : []),
                      ] as const
                    ).map((choice) => (
                      <Button
                        key={choice}
                        className="kapibala-action"
                        variant={choice === 'allow_once' ? 'primary' : 'secondary'}
                        onClick={() =>
                          void api.approval
                            .reply({
                              workspaceId: approval.workspaceId,
                              sessionId: approval.sessionId,
                              runId: approval.runId,
                              approvalId: approval.approvalId,
                              choice: choice as 'deny_once' | 'allow_once' | 'allow_session',
                            })
                            // 队列清空就必须收起面板：审批已生效却留着一张挡住正文的空卡片，
                            // 用户会以为「批了没反应」，还得再手动叉一次。仍有其它待处理请求时保持打开。
                            .then(() => {
                              const remaining = client
                                .snapshot()
                                .approvals.filter(
                                  (item) => item.approvalId !== approval.approvalId,
                                );
                              if (remaining.length === 0) openApprovals(false);
                            })
                            .catch((reason) => report(failure(reason)))
                        }
                      >
                        {
                          {
                            deny_once: '拒绝',
                            allow_once: '批准一次',
                            allow_session: '本会话允许相同调用',
                          }[choice as 'deny_once' | 'allow_once' | 'allow_session']
                        }
                      </Button>
                    ))}
                  </div>
                </LayerCard>
              ))}
            </div>
          </LayerDialog.Body>
        </LayerDialog.Content>
      </LayerDialog>
      <LayerDialog open={fullAccess} onOpenChange={setFullAccess}>
        <LayerDialog.Content size="sm" closeLabel="取消完全访问">
          <LayerDialog.Title>
            <span data-kapibala-modal="true">启用完全访问？</span>
          </LayerDialog.Title>
          <LayerDialog.Description>
            本会话将跳过通常的工具审批，可能修改文件或执行命令。仅在确认当前空间和任务可信时启用。
          </LayerDialog.Description>
          <LayerDialog.Body>
            <Button
              className="kapibala-action"
              onClick={() =>
                void act(async () => {
                  if (opened)
                    await configure({
                      ...scopeOf(opened),
                      mode: 'FullAccess',
                      confirmFullAccess: true,
                    });
                  setFullAccess(false);
                })
              }
            >
              确认启用本会话完全访问
            </Button>
          </LayerDialog.Body>
        </LayerDialog.Content>
      </LayerDialog>
    </Sidebar.Provider>
  );
}
