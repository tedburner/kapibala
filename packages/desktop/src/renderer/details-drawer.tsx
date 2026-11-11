import { Button, InlineCopyText } from '@cloudflare/kumo';
import { Dialog } from '@cloudflare/kumo/primitives/dialog';
import type { ViewTool } from '@kiturone/kapibala-cli/view-model';
import { XIcon } from '@phosphor-icons/react';
import { type RefObject, useEffect, useState } from 'react';
import type { Inspection, RuntimeSnapshot } from '../shared/observations.js';
import { PlainCodeBlock } from './code-display.js';

/** 抽屉目标只存稳定定位，实际工具与诊断每次从当前 Host 投影重新选择。 */
export type DetailsTarget = { kind: 'tool'; callId: string } | { kind: 'status' };
/** Kumo 无现成非模态桌面侧栏，此领域组合仅提供布局，关闭、焦点和遮罩行为全部交给 Dialog 原语。 */
export function DetailsDrawer({
  target,
  tool,
  inspection,
  runtime,
  title,
  root,
  wide,
  container,
  trigger,
  fallback,
  onClose,
}: {
  target?: DetailsTarget;
  tool?: ViewTool;
  inspection?: Inspection;
  runtime?: RuntimeSnapshot['items'][number];
  title: string;
  root: string;
  wide: boolean;
  container: RefObject<HTMLDivElement | null>;
  trigger: RefObject<HTMLElement | null>;
  fallback: RefObject<HTMLDivElement | null>;
  onClose(): void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!target || !runtime?.startedAt || runtime.phase === 'idle') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [target, runtime?.startedAt, runtime?.phase]);
  const elapsed = runtime?.startedAt
    ? Math.max(0, Math.floor(((runtime.settledAt ?? now) - runtime.startedAt) / 1000))
    : undefined;
  const status = inspection?.status;
  return (
    <Dialog.Root
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      modal={!wide}
      disablePointerDismissal={wide}
    >
      <Dialog.Portal container={container.current}>
        {!wide && <Dialog.Backdrop className="absolute inset-0 z-40 bg-kumo-contrast/30" />}
        <Dialog.Popup
          aria-modal={!wide}
          finalFocus={() => (trigger.current?.isConnected ? trigger.current : fallback.current)}
          initialFocus={wide ? false : undefined}
          className="kapibala-dock absolute inset-y-0 right-0 z-50 flex w-(--kapibala-dock-width) max-w-full flex-col text-kumo-default"
        >
          <div className="kapibala-dock-header flex shrink-0 items-start justify-between gap-3 p-4">
            <div className="min-w-0">
              <Dialog.Title className="text-base font-semibold">
                {target?.kind === 'tool' ? '工具详情' : '会话状态'}
              </Dialog.Title>
              <Dialog.Description className="mt-1 break-all text-xs text-kumo-subtle">
                {title}
              </Dialog.Description>
            </div>
            <Dialog.Close
              render={
                <Button
                  className="kapibala-action"
                  variant="ghost"
                  shape="square"
                  size="lg"
                  aria-label="关闭详情"
                />
              }
            >
              <XIcon size={18} />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 text-sm">
            {target?.kind === 'tool' ? (
              tool ? (
                <>
                  <div>
                    <p className="font-medium">{tool.name}</p>
                    <p className="mt-1 text-kumo-subtle">
                      {
                        {
                          running: '执行中',
                          succeeded: '已完成',
                          failed: '失败',
                          interrupted: '已中断',
                        }[tool.status]
                      }
                      {tool.durationMs !== undefined ? ` · ${tool.durationMs} ms` : ''}
                      {tool.outputBytes !== undefined ? ` · ${tool.outputBytes} B` : ''}
                    </p>
                  </div>
                  <section>
                    <h3 className="mb-2 font-medium">实际调用</h3>
                    {/* 工具入参没有可依赖的语言声明，统一按纯文本渲染并施加展示预算。 */}
                    <PlainCodeBlock code={tool.input || tool.invocation} ariaLabel="复制工具参数" />
                  </section>
                  <section>
                    <h3 className="mb-2 font-medium">结果与错误事实</h3>
                    <PlainCodeBlock
                      code={tool.result ?? '工具尚未提供结果。'}
                      ariaLabel="复制工具结果"
                    />
                  </section>
                </>
              ) : (
                <p>当前投影中没有这个工具，请重新选择。</p>
              )
            ) : inspection ? (
              <>
                <section>
                  <h3 className="mb-3 font-medium">运行事实</h3>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
                    <dt>模型</dt>
                    <dd>{status?.model ?? '未提供'}</dd>
                    <dt>权限模式</dt>
                    <dd>{status?.permissionMode ?? '未提供'}</dd>
                    {status?.gitBranch && (
                      <>
                        <dt>Git 分支</dt>
                        <dd>{status.gitBranch}</dd>
                      </>
                    )}
                    <dt>耗时</dt>
                    <dd className="tabular-nums">
                      {elapsed === undefined ? '未开始运行' : `${elapsed} 秒`}
                    </dd>
                    <dt>上下文</dt>
                    <dd className="tabular-nums">
                      {status?.contextUsage?.usedTokens === undefined
                        ? '未提供'
                        : `${status.contextUsage.estimatedUsage ? '估算 ' : ''}${status.contextUsage.usedTokens} / ${status.contextUsage.limitTokens}${status.contextUsage.estimatedLimit ? '（窗口估算）' : ''}`}
                    </dd>
                    <dt>本轮 Token</dt>
                    <dd className="tabular-nums">{status?.runUsage?.totalTokens ?? '未提供'}</dd>
                    <dt>输入 / 输出</dt>
                    <dd>
                      {status?.runUsage?.promptTokens ?? '未提供'} /{' '}
                      {status?.runUsage?.completionTokens ?? '未提供'}
                    </dd>
                  </dl>
                  {inspection.branchDrift && (
                    <p className="mt-3 text-xs text-kumo-warning">
                      分支已变化：{inspection.branchDrift.createdBranch ?? '未记录'} →{' '}
                      {inspection.branchDrift.currentBranch ?? '未提供'}，未执行 checkout。
                    </p>
                  )}
                </section>
                <section>
                  <h3 className="mb-3 font-medium">技能</h3>
                  <p className="text-xs text-kumo-subtle">
                    {inspection.skills.enabled ? '已启用，按需加载' : '已禁用'} · 目录省略{' '}
                    {inspection.skills.omitted} 项
                  </p>
                  <ul className="mt-2 space-y-3">
                    {inspection.skills.entries.map((skill) => (
                      <li key={`${skill.scope}:${skill.name}`}>
                        <p>
                          {skill.name}{' '}
                          <span className="text-xs text-kumo-subtle">
                            {skill.active ?? (skill.available ? '可用' : '不可用')}
                          </span>
                        </p>
                        <p className="mt-1 text-xs text-kumo-subtle">
                          {skill.reason ?? skill.description}
                        </p>
                      </li>
                    ))}
                  </ul>
                  {inspection.skills.diagnostics.map((item, index) => (
                    <p key={`${item.code}:${index}`} className="mt-2 text-xs text-kumo-subtle">
                      {item.code}：{item.message}
                    </p>
                  ))}
                </section>
                <section>
                  <h3 className="mb-3 font-medium">MCP</h3>
                  <p className="text-xs text-kumo-subtle">
                    {inspection.mcp.enabled
                      ? '仅展示现有状态；查看不会启动服务。'
                      : '当前没有启用 MCP。'}
                  </p>
                  <ul className="mt-2 space-y-3">
                    {inspection.mcp.servers.map((server) => (
                      <li key={server.name}>
                        <p>
                          {server.name} ·{' '}
                          {server.state === 'deferred' ? '等待首次运行授权' : server.state}
                        </p>
                        <p className="mt-1 text-xs text-kumo-subtle">
                          工具 {server.toolCount ?? '未提供'} · 提示词{' '}
                          {server.promptCount ?? '未提供'}
                          {server.error && ` · ${server.error}`}
                        </p>
                      </li>
                    ))}
                  </ul>
                  {inspection.mcp.diagnostics.map((item, index) => (
                    <p key={`${item.code}:${index}`} className="mt-2 text-xs text-kumo-subtle">
                      {item.code}：{item.message}
                    </p>
                  ))}
                </section>
                <section>
                  <h3 className="mb-3 font-medium">当前父会话的子任务</h3>
                  <p className="text-xs text-kumo-subtle">
                    观察不会收集结果或唤醒模型；投递未知时不补成已收集。
                  </p>
                  <ul className="mt-2 space-y-4">
                    {status?.tasks?.map((task) => (
                      <li key={task.agentId}>
                        <p>
                          {task.description} · {task.status}
                        </p>
                        <p className="mt-1 text-xs text-kumo-subtle">
                          来源分支 {task.originBranchId} ·{' '}
                          {
                            {
                              'not-ready': '结果未就绪',
                              pending: '尚未收集',
                              collected: '已收集',
                              unknown: '投递未知',
                            }[task.delivery]
                          }
                        </p>
                        {task.summary && <p className="mt-1 text-xs">{task.summary}</p>}
                        {task.error && <p className="mt-1 text-xs">{task.error}</p>}
                        {task.branchHint && (
                          <p className="mt-1 text-xs text-kumo-subtle">{task.branchHint}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
                {Boolean(
                  inspection.truncated ||
                    inspection.tasksOmitted ||
                    inspection.mcp.omitted ||
                    inspection.skills.diagnosticsOmitted ||
                    inspection.mcp.diagnosticsOmitted,
                ) && (
                  <p className="text-xs text-kumo-subtle">
                    观察摘要已限额：部分文本或条目未展示，原历史不受影响。
                  </p>
                )}
              </>
            ) : (
              <p>观察暂不可用；仍可查询运行状态或停止任务。</p>
            )}
            <section className="border-t border-kumo-line pt-4">
              <p className="mb-2 text-xs text-kumo-subtle">实际工作目录</p>
              <InlineCopyText
                className="kapibala-action max-w-full break-all"
                labels={{ copyAction: '复制工作目录', copied: '已复制目录' }}
              >
                {root}
              </InlineCopyText>
            </section>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
