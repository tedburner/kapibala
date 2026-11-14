/** 控制连接管理本期异步回复与通知撤销；调用方每次等待 Host 前都需经过同一期实例。 */
export class ControlLifetime {
  private active = true;
  constructor(
    private readonly current: () => boolean,
    private readonly resetNotices: () => void,
  ) {}
  /** 回复仅能由发起它的 Renderer 和 Host 继续消费；断连不得提交本地状态或后续操作。 */
  async wait<T>(operation: () => Promise<T>, resourceCurrent: () => boolean): Promise<T> {
    this.assertCurrent(resourceCurrent);
    const result = await operation();
    this.assertCurrent(resourceCurrent);
    return result;
  }
  /** 连接关闭入口同步撤销本期通知，独立于稍后才能完成的 Host 清理。 */
  detach(): void {
    this.active = false;
    this.resetNotices();
  }
  private assertCurrent(resourceCurrent: () => boolean): void {
    if (!this.active || !this.current() || !resourceCurrent()) throw new Error('HOST_UNAVAILABLE');
  }
}
