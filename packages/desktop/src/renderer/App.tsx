import {
  Button,
  DropdownMenu,
  Empty,
  Input,
  InputArea,
  LayerCard,
  LayerDialog,
  Sidebar,
} from '@cloudflare/kumo';
import brandMark from '@kapibala-assets/icon.svg';
import { selectMessages } from '@kiturone/kapibala-cli/view-model';
import {
  CaretDownIcon,
  CheckIcon,
  FolderPlusIcon,
  FolderSimpleIcon,
  PaperPlaneTiltIcon,
  PlusIcon,
  ShieldCheckIcon,
  StopIcon,
  XIcon,
} from '@phosphor-icons/react';
import {
  type CSSProperties,
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
import { MessageList } from './message-list.js';
import { ProjectDialog } from './project-dialog.js';
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
  Approval: '逐次审批',
  Plan: '计划',
  Auto: '自动',
  FullAccess: '完全访问',
} as const;
type Mode = keyof typeof MODE_NAMES;
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
/** 空态只保留路径末两段：完整绝对路径留在悬浮提示与详情抽屉，避免首屏出现整条临时目录。 */
function shortRoot(root: string): string {
  const parts = root.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 3 ? root : `…/${parts.slice(-2).join('/')}`;
}

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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [fullAccess, setFullAccess] = useState(false);
  // 新对话在创建前没有会话配置，先把用户选的模型暂存；创建成功后立即 configure 再启动，
  // 避免「输入区显示 A 模型、实际用 B 模型」的静默不一致。空间切换不清空该选择。
  const [pendingProfile, setPendingProfile] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const [details, setDetails] = useState<DetailsTarget>();
  const [wide, setWide] = useState(innerWidth >= 1200);
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
      setRecent((await api.preferences.read()).recent);
      await selectSpace(await api.workspace.openDefault());
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
    await refreshHistory(space);
  }
  async function configure(change: Parameters<DesktopAPI['session']['configure']>[0]) {
    if (!opened) return;
    const configuration = await api.session.configure(change);
    setOpened({ ...opened, configuration });
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
        recent={recent}
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
        onPick={() => setProjectOpen(true)}
        onRecent={(id) => void act(async () => selectSpace(await api.workspace.openRecent(id)))}
        onNew={() => void act(() => openConversation())}
        onOpen={(space, conversationId) => void act(() => openConversation(conversationId, space))}
        onPage={(space, page) => void act(() => refreshHistory(space, page))}
        onSettings={() => ui.settings(true)}
        onRefreshRuntime={() => void act(() => client.connectRuntime())}
        onClose={(item) =>
          void act(async () => {
            await api.session.close({ workspaceId: item.workspaceId, sessionId: item.sessionId });
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
          <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-kumo-line px-5">
            <div className="flex min-w-0 items-center gap-3">
              <Sidebar.Trigger aria-label="展开或收起侧栏" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {workspace?.name ?? '选择空间'}
                  {opened ? ` / ${currentTitle}` : ''}
                </p>
                <p className="truncate text-xs text-kumo-subtle">{headerHint}</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                className="kapibala-action"
                variant="ghost"
                onClick={() => ui.approvals(true)}
              >
                <ShieldCheckIcon size={18} />
                审批 {facts.approvals.length}
              </Button>
              {opened && (
                <Button
                  className="kapibala-action"
                  variant="ghost"
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
                  size="base"
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
                  <XIcon size={18} />
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
                report={report}
              />
            ) : (
              <div className="min-h-0 flex-1 p-6 text-sm text-kumo-subtle" aria-busy="true">
                正在加载历史…
              </div>
            )
          ) : (
            <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-6">
              {/* 引导卡用 my-auto 居中；卡片高于可视区时仍从顶部开始滚动，不会被 flex 居中裁掉。 */}
              <Empty
                className="my-auto max-w-xl [@media(max-height:700px)]:gap-4 [@media(max-height:700px)]:py-8"
                icon={
                  <img src={brandMark} alt="" aria-hidden="true" className="size-14 rounded-xl" />
                }
                title="今天想完成什么？"
                description="描述任务后按 Enter 发送；其它空间运行中的任务会在后台继续。"
                contents={
                  <div className="flex flex-col items-center gap-5">
                    <div className="flex flex-wrap justify-center gap-2">
                      {STARTERS.map((starter) => (
                        <Button
                          key={starter}
                          className="kapibala-action"
                          variant="secondary"
                          size="sm"
                          onClick={() => ui.draft(':new', starter)}
                        >
                          {starter}
                        </Button>
                      ))}
                    </div>
                    {/* 空态交代「在哪个空间、哪个目录」以及两个次要动作；路径用悬浮提示承载，不占首屏。 */}
                    <div className="flex flex-col items-center gap-3 border-t border-kumo-line pt-4">
                      <p className="text-xs text-kumo-subtle">
                        当前空间：{workspace?.name ?? '未选择'}
                        {workspace?.root && (
                          <>
                            {' · '}
                            <span
                              className="inline-block max-w-64 truncate align-bottom font-mono"
                              title={workspace.root}
                            >
                              {shortRoot(workspace.root)}
                            </span>
                          </>
                        )}
                      </p>
                      <div className="flex items-center gap-2">
                        <Button
                          className="kapibala-action"
                          variant="ghost"
                          size="sm"
                          disabled={!workspace?.trusted || busy}
                          onClick={() => void act(() => openConversation())}
                        >
                          <PlusIcon size={16} />
                          新建对话
                        </Button>
                        <Button
                          className="kapibala-action"
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setProjectOpen(true)}
                        >
                          <FolderPlusIcon size={16} />
                          添加项目
                        </Button>
                      </div>
                    </div>
                  </div>
                }
              />
            </div>
          )}
          {facts.state?.notices.map((notice) => (
            <output key={notice.id} className="shrink-0 px-6 py-2 text-xs text-kumo-subtle">
              {notice.text}
            </output>
          ))}
          <footer className="shrink-0 px-6 pt-3 pb-4">
            <div className="relative mx-auto w-full max-w-[848px] space-y-2">
              {/* 输入、空间、模型、模式与发送同属一张卡：焦点由卡片整体承担，工具条保持低权重。 */}
              <div className="rounded-[20px] border border-kumo-line bg-kumo-base px-3 pt-3 pb-2 shadow-sm transition-colors focus-within:border-kumo-focus/40">
                <InputArea
                  aria-label="发送消息"
                  placeholder={opened ? '继续对话…' : '描述你想完成的任务…'}
                  value={draft}
                  onValueChange={(value) =>
                    ui.draft(
                      opened ? `${opened.workspaceId}:${opened.conversationId}` : ':new',
                      value,
                    )
                  }
                  disabled={busy}
                  autoResize
                  minRows={2}
                  maxRows={6}
                  className="max-h-[180px] rounded-none bg-transparent px-2 py-1 ring-0 focus:ring-0"
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1">
                    {/* 空间入口在会话内外都保留：换目标空间不必先回侧栏；切空间会关闭当前会话视图，运行中的任务仍在后台。 */}
                    <DropdownMenu>
                      <DropdownMenu.Trigger
                        render={
                          <Button
                            className="kapibala-action max-w-48"
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            aria-label={workspace ? `会话空间：${workspace.name}` : '选择空间'}
                          >
                            <FolderSimpleIcon size={16} className="shrink-0" />
                            <span className="min-w-0 truncate">
                              {workspace?.name ?? '选择空间'}
                            </span>
                            <CaretDownIcon size={14} className="shrink-0 text-kumo-subtle" />
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
                                  item.name
                                    .toLowerCase()
                                    .includes(projectSearch.trim().toLowerCase()),
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
                              className="kapibala-action"
                              variant="ghost"
                              size="sm"
                              disabled={Boolean(running) || busy}
                              aria-label={`会话模式：${MODE_NAMES[opened.configuration.mode]}`}
                            >
                              <ShieldCheckIcon size={16} className="shrink-0" />
                              <span className="min-w-0 truncate">
                                {MODE_NAMES[opened.configuration.mode]}
                              </span>
                              <CaretDownIcon size={14} className="shrink-0 text-kumo-subtle" />
                            </Button>
                          }
                        />
                        <DropdownMenu.Content>
                          {(
                            [
                              ['Approval', '逐次审批'],
                              ['Plan', '计划'],
                              ['Auto', '自动'],
                              ['FullAccess', '完全访问'],
                            ] as const
                          ).map(([mode, name]) => (
                            <DropdownMenu.Item
                              key={mode}
                              onClick={() => {
                                if (mode === 'FullAccess') setFullAccess(true);
                                else void act(() => configure({ ...scopeOf(opened), mode }));
                              }}
                            >
                              <span className="min-w-0 flex-1">{name}</span>
                              {opened.configuration.mode === mode && <CheckIcon size={14} />}
                            </DropdownMenu.Item>
                          ))}
                        </DropdownMenu.Content>
                      </DropdownMenu>
                    )}
                    <DropdownMenu>
                      <DropdownMenu.Trigger
                        render={
                          <Button
                            className="kapibala-action max-w-56"
                            variant="ghost"
                            size="sm"
                            disabled={Boolean(running) || busy}
                            aria-label={
                              opened
                                ? `当前会话模型：${composerModel?.name ?? '选择模型'}`
                                : `新对话模型：${composerModel?.name ?? '选择模型'}`
                            }
                          >
                            <span className="min-w-0 truncate">
                              {composerModel?.name ?? '未配置模型'}
                            </span>
                            <CaretDownIcon size={14} className="shrink-0 text-kumo-subtle" />
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
                                    onClick={() =>
                                      void act(() => configure({ ...scopeOf(opened), role }))
                                    }
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
                              <span className="min-w-0 flex-1 truncate">
                                还没有可用模型，去设置
                              </span>
                            </DropdownMenu.Item>
                          )}
                        </DropdownMenu.Group>
                      </DropdownMenu.Content>
                    </DropdownMenu>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {running ? (
                      <Button
                        className="kapibala-action"
                        size="base"
                        variant="secondary"
                        disabled={run.phase !== 'running'}
                        onClick={() =>
                          opened &&
                          void api.run
                            .cancel({ ...scopeOf(opened), runId: run.runId })
                            .catch((reason) => report(failure(reason)))
                        }
                      >
                        <StopIcon size={18} />
                        {run.phase === 'running'
                          ? '停止'
                          : run.phase === 'cancelling'
                            ? '正在取消'
                            : '正在清理'}
                      </Button>
                    ) : (
                      <Button
                        className="kapibala-action rounded-full"
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
                        <PaperPlaneTiltIcon size={18} />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
              {!opened && workspace && !workspace.trusted && (
                <p className="px-1 text-xs text-kumo-warning">
                  当前空间尚未信任，确认信任后才能发送。
                </p>
              )}
              {/* 没有密钥时直接说清阻断原因并给出入口，不让用户点了发送才发现不可用。 */}
              {usableModels.length === 0 && (
                <p className="flex flex-wrap items-center gap-1 px-1 text-xs text-kumo-warning">
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
          </footer>
        </main>
        {details && wide && <div className="w-[360px] shrink-0" aria-hidden="true" />}
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
        workspaceId={workspace?.id}
        reload={reloadCatalog}
        report={report}
        hostDown={facts.error !== undefined || facts.runtimeValid === false}
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
            <div className="space-y-5">
              {facts.approvals.length === 0 && (
                <p className="text-sm text-kumo-subtle">当前没有待处理请求。</p>
              )}
              {facts.approvals.map((approval) => (
                <LayerCard key={approval.approvalId} className="space-y-3 p-4">
                  <p className="font-medium">{approval.toolName}</p>
                  <p className="break-all text-xs text-kumo-subtle">
                    空间：{approval.workspaceName}
                    <br />
                    {approval.workspaceRoot}
                    <br />
                    会话 {approval.conversationId} · 运行 {approval.runId}
                  </p>
                  <p className="text-sm text-kumo-subtle">{approval.capabilities.join('、')}</p>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs">
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
