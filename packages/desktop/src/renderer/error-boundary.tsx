import { Button } from '@cloudflare/kumo';
import { Component, type ErrorInfo, type ReactNode, useEffect, useState } from 'react';

/** 渲染故障兜底界面的事实载体；只保留安全文案，不携带堆栈或组件树详情。 */
interface RenderFault {
  message: string;
}

/** 边界自身状态必须是对象类型（React 组件 state 泛型不接受 null 联合）。 */
interface BoundaryState {
  fault: RenderFault | null;
}

/**
 * 渲染层最后一道防线的错误边界：任何子树渲染异常都落到独立恢复界面，
 * 不依赖已崩溃的会话视图或代码高亮 Provider。
 * 边界只负责界面恢复；网络与事件回调里的异步错误仍由各自的 catch 与
 * createRoot 的 onUncaughtError 报告通道收集，本组件不吞并它们。
 */
export class RendererErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { fault: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { fault: { message: error instanceof Error ? error.message : String(error) } };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 结构化报告便于 E2E 与日志检索；恢复动作由兜底界面承担，这里不做副作用。
    console.error('[kapibala] 渲染层异常已由错误边界兜底', error, info.componentStack);
  }

  render(): ReactNode {
    const { fault } = this.state;
    if (!fault) return this.props.children;
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center gap-4 p-8">
        <h1 className="text-lg font-medium">界面渲染出现异常</h1>
        <p className="max-w-xl text-center text-sm text-kumo-subtle">
          当前界面未能继续绘制，任务与历史不受影响。可先尝试重新加载界面；
          若连接状态异常，请使用重新连接（会等待 Host 清理后恢复）。
        </p>
        {fault.message ? (
          <p className="max-w-xl break-all text-center text-xs text-kumo-subtle">{fault.message}</p>
        ) : null}
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void window.kapibala.app.reload().catch(() => {})}>
            重新加载界面
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void window.kapibala.app.reconnect().catch((error: unknown) => {
                console.error('[kapibala] 重新连接请求失败', error);
              });
            }}
          >
            重新连接 Host
          </Button>
        </div>
      </div>
    );
  }
}

/**
 * E2E 专用的渲染故障注入探针：仅在收到专用事件后的下一次渲染抛错，
 * 正常用户路径没有任何入口能触发，始终渲染为空。
 * 事件触发而非直接 evaluate 抛错，确保异常发生在渲染期从而被错误边界捕获。
 */
export function FaultProbe(): ReactNode {
  const [fault, setFault] = useState(false);
  useEffect(() => {
    const arm = () => setFault(true);
    window.addEventListener('kpbl-e2e-render-fault', arm);
    return () => window.removeEventListener('kpbl-e2e-render-fault', arm);
  }, []);
  if (fault) throw new Error('E2E 注入的渲染故障');
  return null;
}
