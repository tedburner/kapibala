import {
  type PresentationEvent,
  type PresentationState,
  type ViewIdentity,
  type ViewMessage,
  createPresentation,
  reducePresentation,
} from '../view-model/index.js';

/**
 * Host 的有序状态发布器；事件同步完整应用，普通增量只合并订阅通知，不暂存源事件。
 * 边界/输入操作立即发布，不设置额外写屏周期；实际绘制限帧仍由 TUI 渲染器负责。
 */
export class PresentationStore {
  private state: PresentationState;
  private readonly listeners = new Set<() => void>();
  private scheduled = false;
  private closed = false;
  private generation = 0;
  private publishing = false;

  constructor(identity: ViewIdentity, messages: readonly ViewMessage[] = []) {
    this.state = createPresentation(identity, messages);
  }

  /** 读取已经按顺序更新的只读快照，不等待下一帧或微任务。 */
  snapshot(): PresentationState {
    return this.state;
  }

  /** 订阅变化并返回幂等取消函数；监听失败不得传播到 Session 事件消费者。 */
  subscribe(listener: () => void): () => void {
    if (!this.closed) this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 只接受当前视图/操作事件；返回是否更新，拒绝事件不触发额外绘制。 */
  dispatch(event: PresentationEvent): boolean {
    if (this.closed) return false;
    const next = reducePresentation(this.state, event);
    if (next === this.state) return false;
    this.state = next;
    if (event.change.type === 'append') this.schedule();
    else this.flush();
    return true;
  }

  /** 显式切换视图必须推进代次，取消旧回调；不从旧视图恢复偏好或权限。 */
  reload(identity: ViewIdentity, messages: readonly ViewMessage[]): void {
    if (this.closed) return;
    if (identity.viewEpoch <= this.state.identity.viewEpoch)
      throw new Error('视图重载必须推进 viewEpoch');
    this.state = createPresentation(identity, messages);
    this.flush();
  }

  /** 立即发布当前完整状态并使此前排队回调失效，不重放旧增量或通知。 */
  flush(): void {
    this.generation++;
    this.scheduled = false;
    if (this.closed) return;
    if (this.publishing) {
      this.schedule();
      return;
    }
    this.publishing = true;
    try {
      for (const listener of [...this.listeners]) {
        if (!this.listeners.has(listener)) continue;
        try {
          listener();
        } catch {
          /* 观察者不能破坏运行和其他消费者，渲染器错误另由宿主管理。 */
        }
      }
    } finally {
      this.publishing = false;
    }
  }

  /** 仅关闭展示观察，不代替 Session/工具清理，不得用它提前解除操作执行门。 */
  close(): void {
    this.closed = true;
    this.generation++;
    this.scheduled = false;
    this.listeners.clear();
  }

  /** 合并同一微任务之前的状态通知，不引入固定 33ms 等待或第二个绘制计时器。 */
  private schedule(): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    const generation = this.generation;
    void Promise.resolve().then(() => {
      if (!this.closed && this.scheduled && generation === this.generation) this.flush();
    });
  }
}
