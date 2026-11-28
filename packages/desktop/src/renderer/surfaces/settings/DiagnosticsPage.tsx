import { useEffect, useMemo, useState } from 'react';
import type { Output } from '../../../shared/contracts.js';
import type { Inspection, RuntimeSnapshot } from '../../../shared/observations.js';
import { Badge, Button, SettingRow, SettingSection, StatusDot } from '../../ui/index.js';
import { copyTextSafe } from './settings-helpers.js';

const ACTIVE_SUBAGENT_STATUSES = new Set([
  'preparing',
  'accepted',
  'running',
  'waiting_children',
  'cancelling',
]);

/**
 * `DiagnosticsPage` 入参契约（017 §6.7）：
 * 汇总宿主连接健康度、实例与本地 wire `PROTOCOL_VERSION = 2` 协议纪元、
 * 活跃句柄 / 监视器 / 子代理 / 保活终端实时计数，以及重连、重载、复制诊断与安全退出控制。
 */
export interface DiagnosticsPageProps {
  readonly active?: boolean;
  readonly appInfo?: Output<'app.getInfo'>;
  readonly runtime?: RuntimeSnapshot;
  readonly inspection?: Inspection;
  readonly activeTerminalsCount?: number;
  readonly hostDown?: boolean;
  readonly report?: (message: string) => void;
}

/**
 * 壳内设置中心「诊断」页面。
 */
export function DiagnosticsPage({
  active = true,
  appInfo: propInfo,
  runtime,
  inspection,
  activeTerminalsCount = 0,
  hostDown = false,
  report,
}: DiagnosticsPageProps) {
  const [info, setInfo] = useState<Output<'app.getInfo'> | undefined>(propInfo);
  const [reconnecting, setReconnecting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (propInfo) setInfo(propInfo);
  }, [propInfo]);

  useEffect(() => {
    if (!active || propInfo || typeof window === 'undefined' || !window.kapibala) return;
    void window.kapibala.app
      .getInfo()
      .then(setInfo)
      .catch(() => {});
  }, [active, propInfo]);

  const metrics = useMemo(() => {
    const items = runtime?.items ?? [];
    const openHandles = items.length;
    const runningHandles = items.filter(
      (i) => i.phase === 'running' || i.phase === 'cancelling',
    ).length;
    const pendingApprovals = items.reduce((sum, i) => sum + i.approvals, 0);
    const activeWatches = items.reduce((sum, i) => sum + (i.watches ?? 0), 0);
    const subagents = inspection?.status.tasks ?? [];
    const activeSubagents = subagents.filter((t) => ACTIVE_SUBAGENT_STATUSES.has(t.status)).length;
    return {
      openHandles,
      runningHandles,
      pendingApprovals,
      activeWatches,
      activeSubagents,
      totalSubagents: subagents.length,
    };
  }, [inspection, runtime]);

  async function handleReconnect(): Promise<void> {
    if (reconnecting || typeof window === 'undefined' || !window.kapibala) return;
    setReconnecting(true);
    try {
      await window.kapibala.app.reconnect();
    } catch (err) {
      report?.(err instanceof Error ? err.message : '重新连接请求失败。');
    } finally {
      setReconnecting(false);
    }
  }

  function handleReloadUi(): void {
    if (typeof window === 'undefined' || !window.kapibala) return;
    void window.kapibala.app.reload().catch((err: unknown) => {
      report?.(err instanceof Error ? err.message : '重载界面失败。');
    });
  }

  const diagnosticJson = useMemo(
    () =>
      JSON.stringify(
        {
          name: info?.name ?? 'Kapibala',
          version: info?.version ?? 'unknown',
          protocolVersion: 2,
          testBuild: info?.testBuild ?? false,
          platform: info?.platform ?? 'unknown',
          hostInstanceId: info?.hostInstanceId ?? null,
          controlEpoch: info?.controlEpoch ?? null,
          hostConnected: !hostDown,
          runtimes: info?.runtimes ?? null,
          notifications: info?.notifications ?? false,
          tray: info?.tray ?? false,
          activeSummary: {
            ...metrics,
            activeTerminals: activeTerminalsCount,
          },
        },
        null,
        2,
      ),
    [activeTerminalsCount, hostDown, info, metrics],
  );

  return (
    <div className="kpbl-settings-stack">
      <SettingSection
        title="宿主实例与控制协议"
        description="渲染层与独立 Utility Process（Agent Host）通过有界双通道通信，不持有任何 Node 原生权限。"
      >
        <SettingRow
          title={
            <span className="kpbl-row-title-line">
              <span>Agent Host 运行状态</span>
              <StatusDot
                status={hostDown ? 'danger' : 'success'}
                label={hostDown ? 'Host 已断开' : 'Host 已连接'}
                showLabel
              />
            </span>
          }
          description={
            info
              ? `实例 ID：${info.hostInstanceId} · 控制纪元 Epoch ${info.controlEpoch} · 本地协议 v2`
              : '正在读取宿主控制通道握手信息…'
          }
          control={
            <>
              <Button
                variant="outline"
                size="xs"
                leadingIcon="plugs-connected"
                loading={reconnecting}
                onClick={() => void handleReconnect()}
              >
                重新连接
              </Button>
              <Button
                variant="ghost"
                size="xs"
                leadingIcon="arrows-clockwise"
                onClick={handleReloadUi}
              >
                重载界面
              </Button>
            </>
          }
        />

        <SettingRow
          title="客户端与引擎版本"
          description={
            info
              ? `Electron ${info.runtimes.electron} · Node ${info.runtimes.node} · Chromium ${info.runtimes.chrome}`
              : '读取中…'
          }
          control={<Badge>{info ? `${info.platform}` : 'desktop'}</Badge>}
        />

        <SettingRow
          title="系统桌面集成"
          description={
            info
              ? `系统通知：${info.notifications ? '支持（受操作系统权限控制）' : '不支持'} · 系统托盘：${
                  info.tray
                    ? '可用'
                    : info.platform === 'darwin'
                      ? '通过 Dock 恢复窗口'
                      : '不可用，关闭主窗时确认退出'
                }`
              : '读取中…'
          }
        />
      </SettingSection>

      <SettingSection
        title="活跃运行资源摘要"
        description="实时反映当前宿主进程内的会话句柄预算、后台监视器、子代理与保活终端负载。"
      >
        <SettingRow
          title="会话句柄与在途运行"
          description="单宿主最多同时保活 8 个打开句柄与 4 个并发运行任务。"
          control={
            <span className="kpbl-row-title-line kpbl-tabular">
              <Badge>句柄 {metrics.openHandles} / 8</Badge>
              <Badge tone={metrics.runningHandles > 0 ? 'pulse' : 'neutral'}>
                运行中 {metrics.runningHandles}
              </Badge>
              {metrics.pendingApprovals > 0 ? (
                <Badge tone="pulse">待审批 {metrics.pendingApprovals}</Badge>
              ) : null}
            </span>
          }
        />
        <SettingRow
          title="后台监视器（Watches）"
          description="等待文件变更或端口就绪的事件驱动监视器数量，等待期间不消耗模型推理额度。"
          control={
            <Badge tone={metrics.activeWatches > 0 ? 'info' : 'neutral'} className="kpbl-tabular">
              活跃监视 {metrics.activeWatches}
            </Badge>
          }
        />
        <SettingRow
          title="委派子代理（Subagents）"
          description="当前选中会话已派生的子代理任务计数（观察行为本身不触发结果收集）。"
          control={
            <span className="kpbl-row-title-line kpbl-tabular">
              <Badge tone={metrics.activeSubagents > 0 ? 'pulse' : 'neutral'}>
                活跃 {metrics.activeSubagents}
              </Badge>
              <Badge outline>累计 {metrics.totalSubagents}</Badge>
            </span>
          }
        />
        <SettingRow
          title="会话保活终端（Terminals）"
          description="右侧工作台「终端」标签当前挂载的本地 PTY 会话数量。"
          control={<Badge className="kpbl-tabular">活跃终端 {activeTerminalsCount}</Badge>}
        />
      </SettingSection>

      <SettingSection
        title="诊断导出与进程退出"
        description="导出的 JSON 仅包含脱敏后的版本与计数摘要，绝不包含 API Key、路径或对话历史。"
      >
        <SettingRow
          title="复制应用诊断信息"
          description="排障反馈时可粘贴至问题报告。"
          control={
            <Button
              variant="outline"
              size="sm"
              leadingIcon="copy"
              onClick={() => {
                void copyTextSafe(diagnosticJson).then((ok) => {
                  if (ok) setCopied(true);
                });
              }}
            >
              {copied ? '已复制' : '复制应用诊断'}
            </Button>
          }
        />
        <SettingRow
          title="停止所有任务并退出"
          description="通知宿主终止在途会话与受管外部代理子进程，完成清理后安全退出应用。"
          control={
            <Button
              variant="danger"
              size="sm"
              leadingIcon="stop"
              onClick={() => {
                if (typeof window !== 'undefined' && window.kapibala) {
                  void window.kapibala.app.requestQuit();
                }
              }}
            >
              停止任务并退出
            </Button>
          }
        />
      </SettingSection>
    </div>
  );
}
