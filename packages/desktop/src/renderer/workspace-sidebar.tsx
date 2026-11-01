import { Button, Collapsible, DropdownMenu, Input, Sidebar } from '@cloudflare/kumo';
import brandMark from '@kapibala-assets/icon.svg';
import {
  CaretDownIcon,
  DotsThreeIcon,
  FolderPlusIcon,
  GearIcon,
  HouseIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import type { Output, Workspace } from '../shared/contracts.js';
import type { RuntimeSnapshot } from '../shared/observations.js';

type RuntimeItem = RuntimeSnapshot['items'][number];
/** 将 Host 的轻量运行事实转成文字，不用颜色或消息订阅推断后台空闲。 */
export function runtimeLabel(item?: RuntimeItem, valid = true): string {
  if (!valid) return '状态未知';
  if (!item) return '';
  if (item.cleanup === 'failed') return '清理未完成';
  if (item.cleanup === 'closing') return '正在关闭';
  if (item.approvals) return `待审批 ${item.approvals}`;
  if (item.phase !== 'idle')
    return { running: '运行中', cancelling: '正在取消', settling: '正在清理' }[item.phase];
  return item.result === 'failed' ? '失败' : item.result === 'aborted' ? '已停止' : '';
}
/** 相对时间只展示历史活动；异常或缺失时间不伪造最近活动。 */
function activityTime(timestamp: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days} 天前` : new Date(timestamp).toLocaleDateString();
}
/** 按登记空间组合 Kumo 侧栏；只折叠视图，不通过切换或折叠释放运行句柄。 */
export function WorkspaceSidebar({
  spaces,
  recent,
  histories,
  activeWorkspaceId,
  conversationId,
  runtime,
  runtimeValid,
  busy,
  onSpace,
  onRecent,
  onDefault,
  onNew,
  onOpen,
  onClose,
  onPage,
  onSettings,
  onRefreshRuntime,
}: {
  spaces: readonly Workspace[];
  recent: Output<'preferences.read'>['recent'];
  histories: Record<string, Output<'session.list'>>;
  activeWorkspaceId?: string;
  conversationId?: string;
  runtime?: RuntimeSnapshot;
  runtimeValid: boolean;
  busy: boolean;
  onSpace(space: Workspace): void;
  onRecent(id: string): void;
  onDefault(): void;
  onNew(): void;
  onOpen(space: Workspace, conversationId: string): void;
  onClose(item: RuntimeItem): void;
  onPage(space: Workspace, page: number): void;
  onSettings(): void;
  onRefreshRuntime(): void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [searchPages, setSearchPages] = useState<Record<string, number>>({});
  const [search, setSearch] = useState<{
    keyword: string;
    loading: boolean;
    lists: Record<string, Output<'session.list'>>;
    error?: string;
  }>({ keyword: '', loading: false, lists: {} });
  const keyword = query.trim().toLowerCase();
  useEffect(() => {
    if (!keyword) return;
    let cancelled = false;
    setSearch({ keyword, loading: true, lists: {} });
    const timer = window.setTimeout(() => {
      void (async () => {
        const lists: Record<string, Output<'session.list'>> = {};
        try {
          // 顺序读取已授权空间，避免大量空间同时占满 Host 请求预算。
          for (const space of spaces) {
            if (!space.trusted) continue;
            lists[space.id] = await window.kapibala.session.list(
              space.id,
              searchPages[space.id] ?? 1,
              keyword,
            );
            if (cancelled) return;
          }
          if (!cancelled) setSearch({ keyword, loading: false, lists });
        } catch {
          if (!cancelled)
            setSearch({ keyword, loading: false, lists, error: '搜索未完成，请重试。' });
        }
      })();
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [keyword, spaces, searchPages]);

  const items = runtime?.items ?? [];
  const running = items.filter((item) => item.phase !== 'idle').length;
  // 搜索只过滤视图：命中的空间自动展开，运行中的任务、句柄预算与历史读取都不受影响。
  const hit = (value: string) => value.toLowerCase().includes(keyword);
  const titleOf = (row: { title: string }) => row.title || '未命名对话';
  const visible = keyword
    ? spaces.filter(
        (space) =>
          hit(space.name) || (search.lists[space.id]?.items ?? []).some((row) => hit(titleOf(row))),
      )
    : spaces;
  const recentRows = recent.filter((item) => !spaces.some((space) => space.recentId === item.id));
  const recentVisible = keyword
    ? recentRows.filter((item) => hit(item.name) || hit(item.parent))
    : recentRows;
  const searching = Boolean(keyword && (search.loading || search.keyword !== keyword));
  const noMatch =
    keyword !== '' &&
    !searching &&
    !search.error &&
    visible.length === 0 &&
    recentVisible.length === 0;
  return (
    <Sidebar aria-label="空间与会话">
      <Sidebar.Header>
        <span className="flex h-10 items-center gap-2.5 px-1 font-semibold">
          <img src={brandMark} alt="" aria-hidden="true" className="size-7 shrink-0 rounded-md" />
          <span className="group-data-[state=collapsed]/sidebar:hidden">Kapibala</span>
        </span>
      </Sidebar.Header>
      <Sidebar.Content>
        <Sidebar.Group className="kapibala-sidebar-actions">
          <Sidebar.Menu>
            <Sidebar.MenuButton
              icon={NotePencilIcon}
              className="kapibala-sidebar-action"
              aria-label="新建对话"
              tooltip="新建对话"
              disabled={!activeWorkspaceId || busy}
              onClick={onNew}
            >
              新建对话
            </Sidebar.MenuButton>
            {!spaces.some((space) => space.kind === 'default') && (
              <Sidebar.MenuButton
                icon={HouseIcon}
                className="kapibala-sidebar-action"
                aria-label="默认空间"
                tooltip="默认空间"
                disabled={busy}
                onClick={onDefault}
              >
                默认空间
              </Sidebar.MenuButton>
            )}
          </Sidebar.Menu>
        </Sidebar.Group>
        <div className="kapibala-sidebar-search group-data-[state=collapsed]/sidebar:hidden">
          <MagnifyingGlassIcon size={16} aria-hidden="true" />
          <Input
            size="sm"
            className="h-auto w-full bg-transparent px-0 text-sm ring-0 focus:ring-0"
            type="search"
            aria-label="搜索空间与对话"
            placeholder="搜索空间与对话"
            maxLength={128}
            value={query}
            onValueChange={(value) => {
              setSearchPages({});
              setQuery(value);
            }}
          />
        </div>
        {searching && (
          <output className="block px-3 pb-2 text-xs text-kumo-subtle">正在搜索已打开空间…</output>
        )}
        {keyword && search.error && !searching && (
          <p role="alert" className="px-3 pb-2 text-xs text-kumo-danger">
            {search.error}
          </p>
        )}
        {noMatch && (
          <p className="group-data-[state=collapsed]/sidebar:hidden px-3 pb-2 text-xs text-kumo-subtle">
            已打开的空间中没有匹配的对话。最近项目需先打开才能搜索。
          </p>
        )}
        {visible.length > 0 && (
          <div className="kapibala-sidebar-section group-data-[state=collapsed]/sidebar:hidden">
            空间
          </div>
        )}
        {visible.map((space) => {
          const history =
            keyword && !hit(space.name) ? search.lists[space.id] : histories[space.id];
          const spaceItems = items.filter((item) => item.workspaceId === space.id);
          const status = spaceItems.some((item) => item.cleanup === 'failed')
            ? '清理未完成'
            : spaceItems.some((item) => item.approvals)
              ? '待审批'
              : spaceItems.some((item) => item.phase !== 'idle')
                ? '运行中'
                : '';
          // 搜索命中的空间直接展开并把会话列表收窄到命中项；空间名命中时保留全部会话。
          const all = history?.items ?? [];
          const list =
            keyword === '' ? all : all.filter((row) => hit(space.name) || hit(titleOf(row)));
          // 仍在运行但尚未进入历史的会话不参与搜索补位，否则会把未命中的行重新塞回列表。
          const missing =
            keyword === ''
              ? spaceItems.filter(
                  (item) => !all.some((row) => row.conversationId === item.conversationId),
                )
              : [];
          return (
            <Sidebar.Group key={space.id} className="kapibala-sidebar-space">
              <Collapsible.Root
                open={keyword !== '' || (expanded[space.id] ?? space.id === activeWorkspaceId)}
                onOpenChange={(open) => setExpanded((value) => ({ ...value, [space.id]: open }))}
              >
                <div className="flex min-w-0 items-center">
                  <Sidebar.Menu className="min-w-0 flex-1">
                    <Sidebar.MenuButton
                      icon={space.kind === 'default' ? HouseIcon : FolderPlusIcon}
                      className="kapibala-sidebar-space-button"
                      title={space.root}
                      tooltip={space.name}
                      aria-label={space.name}
                      disabled={busy}
                      onClick={() => onSpace(space)}
                    >
                      {space.name}
                      {status && (
                        <span
                          className="ml-auto flex items-center gap-1.5 text-xs text-kumo-subtle"
                          aria-label={`${space.name} ${status}`}
                        >
                          <span
                            className={`size-1.5 shrink-0 rounded-full ${
                              status === '运行中'
                                ? 'bg-(--kapibala-signal)'
                                : status === '待审批'
                                  ? 'bg-kumo-warning'
                                  : 'bg-kumo-danger'
                            }`}
                            aria-hidden="true"
                          />
                          {status}
                        </span>
                      )}
                    </Sidebar.MenuButton>
                  </Sidebar.Menu>
                  <Collapsible.Trigger
                    render={
                      <Button
                        className="kapibala-action kapibala-sidebar-chevron group-data-[state=collapsed]/sidebar:hidden"
                        variant="ghost"
                        shape="square"
                        size="base"
                        aria-label={`展开或收起 ${space.name} 的对话`}
                      />
                    }
                  >
                    <CaretDownIcon
                      size={14}
                      className={
                        keyword !== '' || (expanded[space.id] ?? space.id === activeWorkspaceId)
                          ? ''
                          : '-rotate-90'
                      }
                    />
                  </Collapsible.Trigger>
                </div>
                <Collapsible.Panel className="group-data-[state=collapsed]/sidebar:hidden">
                  <Sidebar.Menu className="kapibala-sidebar-conversations">
                    {[
                      ...list,
                      ...missing.map((item) => ({
                        conversationId: item.conversationId,
                        title: '未命名对话',
                        messageCount: 0,
                        lastActivityAt: 0,
                        unavailableReason: undefined,
                      })),
                    ]
                      .sort((a, b) => {
                        // 待审批和运行中的会话优先，其他会话保留原有历史顺序。
                        const priority = (id: string) => {
                          const item = spaceItems.find((entry) => entry.conversationId === id);
                          return item?.approvals ? 2 : item && item.phase !== 'idle' ? 1 : 0;
                        };
                        return priority(b.conversationId) - priority(a.conversationId);
                      })
                      .map((row) => {
                        const handle = spaceItems.find(
                          (item) => item.conversationId === row.conversationId,
                        );
                        return (
                          <Sidebar.MenuItem
                            key={row.conversationId}
                            className="group/row relative flex min-w-0 items-center"
                          >
                            <Sidebar.MenuButton
                              className="kapibala-sidebar-conversation min-w-0 flex-1"
                              active={
                                space.id === activeWorkspaceId &&
                                conversationId === row.conversationId
                              }
                              disabled={busy || Boolean(row.unavailableReason)}
                              title={row.unavailableReason ?? row.title}
                              aria-label={row.title || '未命名对话'}
                              aria-description={
                                runtimeLabel(handle, runtimeValid) ||
                                activityTime(row.lastActivityAt)
                              }
                              onClick={() => onOpen(space, row.conversationId)}
                            >
                              <span className="truncate">{row.title || '未命名对话'}</span>
                              <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-kumo-subtle">
                                {handle?.phase !== undefined &&
                                  handle.phase !== 'idle' &&
                                  handle.cleanup !== 'failed' && (
                                    <span
                                      className="size-1.5 rounded-full bg-(--kapibala-signal)"
                                      aria-hidden="true"
                                    />
                                  )}
                                {runtimeLabel(handle, runtimeValid) ||
                                  activityTime(row.lastActivityAt)}
                              </span>
                            </Sidebar.MenuButton>
                            {handle && (
                              <DropdownMenu>
                                <DropdownMenu.Trigger
                                  render={
                                    <Button
                                      className="kapibala-action absolute right-0 shrink-0 bg-(--kapibala-sidebar-surface) opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100"
                                      variant="ghost"
                                      shape="square"
                                      size="base"
                                      aria-label={`${row.title || '未命名对话'} 的运行时操作`}
                                    />
                                  }
                                >
                                  <DotsThreeIcon size={18} />
                                </DropdownMenu.Trigger>
                                <DropdownMenu.Content>
                                  <DropdownMenu.Group>
                                    <DropdownMenu.Label>关闭运行并保留历史</DropdownMenu.Label>
                                    <DropdownMenu.Item onClick={() => onClose(handle)}>
                                      {handle.cleanup === 'failed'
                                        ? '重试清理'
                                        : handle.phase === 'idle'
                                          ? '关闭运行时'
                                          : '停止并关闭'}
                                    </DropdownMenu.Item>
                                  </DropdownMenu.Group>
                                </DropdownMenu.Content>
                              </DropdownMenu>
                            )}
                          </Sidebar.MenuItem>
                        );
                      })}
                  </Sidebar.Menu>
                  {history && history.pages > 1 && (
                    <div className="flex items-center justify-between px-2 py-2 text-xs">
                      <Button
                        className="kapibala-action"
                        variant="ghost"
                        size="sm"
                        disabled={history.page <= 1 || busy}
                        onClick={() =>
                          keyword && !hit(space.name)
                            ? setSearchPages((pages) => ({
                                ...pages,
                                [space.id]: history.page - 1,
                              }))
                            : onPage(space, history.page - 1)
                        }
                      >
                        上一页
                      </Button>
                      <span>
                        {history.page} / {history.pages}
                      </span>
                      <Button
                        className="kapibala-action"
                        variant="ghost"
                        size="sm"
                        disabled={history.page >= history.pages || busy}
                        onClick={() =>
                          keyword && !hit(space.name)
                            ? setSearchPages((pages) => ({
                                ...pages,
                                [space.id]: history.page + 1,
                              }))
                            : onPage(space, history.page + 1)
                        }
                      >
                        下一页
                      </Button>
                    </div>
                  )}
                </Collapsible.Panel>
              </Collapsible.Root>
            </Sidebar.Group>
          );
        })}
        {recentVisible.length > 0 && (
          <Sidebar.Group>
            <div className="kapibala-sidebar-section group-data-[state=collapsed]/sidebar:hidden">
              最近项目
            </div>
            <Sidebar.Menu>
              {recentVisible.map((item) => (
                <Sidebar.MenuButton
                  key={item.id}
                  icon={FolderPlusIcon}
                  disabled={busy}
                  aria-label={item.name}
                  title={item.parent}
                  tooltip={item.name}
                  onClick={() => onRecent(item.id)}
                >
                  {item.name}
                </Sidebar.MenuButton>
              ))}
            </Sidebar.Menu>
          </Sidebar.Group>
        )}
      </Sidebar.Content>
      <Sidebar.Footer>
        <Button
          className="kapibala-action"
          variant="ghost"
          shape="square"
          size="base"
          aria-label="打开设置"
          title="打开设置"
          onClick={onSettings}
        >
          <GearIcon size={20} />
        </Button>
        <span className="text-xs text-kumo-subtle group-data-[state=collapsed]/sidebar:hidden">
          {runtimeValid ? (
            running > 0 && <span className="text-(--kapibala-signal)">{running} 个任务运行中</span>
          ) : (
            <Button
              className="kapibala-action"
              size="sm"
              variant="ghost"
              onClick={onRefreshRuntime}
            >
              状态未知，重新订阅
            </Button>
          )}
        </span>
      </Sidebar.Footer>
    </Sidebar>
  );
}
