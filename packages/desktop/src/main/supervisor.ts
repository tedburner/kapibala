import { MessageChannelMain, type UtilityProcess, utilityProcess } from 'electron';
import type { Notification } from '../shared/contracts.js';
import { RpcEndpoint } from '../shared/rpc.js';
import type { ControlIdentity } from '../shared/transport.js';
import { withShutdownDeadline } from './deadline.js';
import type { HostGuard } from './guard.js';

type Waiter = {
  resolve(data: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
/**
 * 退出清理的最长等待。超时后按「清理结果未知」处理：保留异常栅栏、
 * 提供保留记录退出，绝不把超时当成清理成功；迟到的真实退出仍会正常收口 guard。
 */
const SHUTDOWN_GRACE_MS = 30_000;
/** Main 只监督 Host 和转发安全 DTO；不读取模型配置、Provider 或原始会话历史。 */
export class HostSupervisor {
  private child?: UtilityProcess;
  private rpc?: RpcEndpoint;
  private readonly waiters = new Map<string, Waiter>();
  private exitPromise?: Promise<void>;
  private cleaned = false;
  private normalExit = false;
  private exited = false;
  private cleanupFailure?: (error: Error) => void;
  private control?: ControlIdentity;
  constructor(
    private readonly guard: HostGuard,
    private readonly hostInstanceId: string,
    private readonly entry: string,
    private readonly homeDirectory: string,
    private readonly unavailable: () => void,
  ) {}

  /** guard 成功建立后才 fork；生产和开发都忽略原始 stdout/stderr，防止旁路泄漏。 */
  async start(): Promise<void> {
    this.guard.begin(this.hostInstanceId);
    const ready = this.wait('host.ready', 5000);
    this.child = utilityProcess.fork(this.entry, [], {
      stdio: 'ignore',
      serviceName: 'Kapibala Agent Host',
    });
    this.child.on('message', (message: Record<string, unknown>) => {
      if (message?.kind === 'host.cleaned') {
        this.cleaned = true;
        this.child?.postMessage({ kind: 'exit' });
      }
      const key = `${message.kind === 'host.attachFailed' ? 'host.connected' : message.kind}${typeof message.controlEpoch === 'number' ? `:${message.controlEpoch}` : ''}`;
      const waiter = this.waiters.get(key);
      if (waiter) {
        this.waiters.delete(key);
        clearTimeout(waiter.timer);
        if (message.ok === false || message.kind === 'host.attachFailed')
          waiter.reject(new Error('SESSION_CLEANUP_FAILED'));
        else waiter.resolve(message);
      }
      if (message.kind === 'host.cleanupFailed') {
        this.cleaned = false;
        this.unavailable();
        this.cleanupFailure?.(new Error('SESSION_CLEANUP_FAILED'));
      }
    });
    this.exitPromise = new Promise<void>((resolve, reject) => {
      this.child!.once('exit', (code) => {
        this.exited = true;
        this.rpc?.peer.close('HOST_UNAVAILABLE');
        for (const waiter of this.waiters.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error('HOST_UNAVAILABLE'));
        }
        this.waiters.clear();
        if (this.cleaned && code === 0) {
          try {
            this.guard.complete({
              hostInstanceId: this.hostInstanceId,
              cleaned: true,
              exitCode: code,
            });
            this.normalExit = true;
            resolve();
          } catch {
            reject(new Error('SESSION_CLEANUP_FAILED'));
          }
        } else {
          this.unavailable();
          reject(new Error('HOST_UNAVAILABLE'));
        }
      });
    });
    void this.exitPromise.catch(() => {});
    await ready;
  }
  /** 每个 Renderer 控制代次独立建端口，旧连接清理完成后调用方才可重新连接。 */
  async attach(
    controlEpoch: number,
    onEvent: (event: Notification) => Promise<void>,
  ): Promise<RpcEndpoint> {
    if (!this.child || this.cleaned) throw new Error('HOST_UNAVAILABLE');
    const { port1, port2 } = new MessageChannelMain();
    this.control = { hostInstanceId: this.hostInstanceId, controlEpoch };
    const rpc = new RpcEndpoint(
      this.control,
      (frame) => port1.postMessage(frame),
      onEvent,
      undefined,
      () => {
        port1.close();
        if (this.control?.controlEpoch === controlEpoch && !this.cleaned && !this.exited)
          this.unavailable();
      },
    );
    this.rpc = rpc;
    port1.on('message', (event) => {
      void rpc.peer.receive(event.data);
    });
    port1.on('close', () => rpc.peer.close());
    port1.start();
    const connected = this.wait(`host.connected:${controlEpoch}`, 5000);
    this.child.postMessage({ kind: 'attach', ...this.control, homeDirectory: this.homeDirectory }, [
      port2,
    ]);
    await connected;
    return rpc;
  }
  /** 失联清理不以端口关闭冒充完成；失败后不再创建第二个控制连接。 */
  async detach(): Promise<void> {
    if (!this.child || !this.control) return;
    const epoch = this.control.controlEpoch;
    this.control = undefined;
    const detached = this.wait(`host.detached:${epoch}`, 30_000);
    this.child.postMessage({ kind: 'detach', controlEpoch: epoch });
    await detached;
    this.rpc?.peer.close();
    this.rpc = undefined;
  }
  /** 等待清理确认加 Host 正常退出，不以提示阈值或强杀当作清理成功；卡死 Host 视为清理结果未知。 */
  async shutdown(): Promise<void> {
    if (this.normalExit) return;
    if (!this.child) throw new Error('HOST_UNAVAILABLE');
    const failure = new Promise<never>((_resolve, reject) => {
      this.cleanupFailure = reject;
    });
    this.child.postMessage({ kind: 'shutdown' });
    try {
      await withShutdownDeadline(Promise.race([this.exitPromise, failure]), SHUTDOWN_GRACE_MS);
    } finally {
      this.cleanupFailure = undefined;
    }
  }
  /** 当前 Main 观察到旧 Host 真实退出后才允许人工恢复，不能仅看清理请求。 */
  hasExited(): boolean {
    return this.exited;
  }
  private wait(key: string, timeout: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        reject(new Error('HOST_UNAVAILABLE'));
      }, timeout);
      this.waiters.set(key, { resolve, reject, timer });
    });
  }
}
