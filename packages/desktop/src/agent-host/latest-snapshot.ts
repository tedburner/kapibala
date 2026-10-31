/** 每个业务订阅只保留一份未发送的最新快照；等待接收 ACK 时合并变化，不占用停止信令队列。 */
export class LatestSnapshot<T> {
  private id?: string;
  private latest?: { id: string; value: T };
  private running = false;
  constructor(
    private readonly send: (subscriptionId: string, value: T) => Promise<void>,
    private readonly invalidated: (subscriptionId: string) => void,
  ) {}
  /** 新订阅替换旧身份；在途旧消息仍由接收方身份校验丢弃。 */
  subscribe(id: string): void {
    this.id = id;
    this.latest = undefined;
  }
  /** 状态是完整快照，覆盖未发送值即可；不按增量序号要求补齐被合并的版本。 */
  push(value: T): void {
    if (!this.id) return;
    this.latest = { id: this.id, value };
    void this.flush();
  }
  /** 旧退订无权释放新代次的业务观察。 */
  unsubscribe(id: string): void {
    if (id === this.id) this.close();
  }
  /** 只释放观察与暂存，不取消其来源 Session 或模型运行。 */
  close(): void {
    this.id = undefined;
    this.latest = undefined;
  }
  private async flush(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.latest) {
        const next = this.latest;
        this.latest = undefined;
        if (next.id !== this.id) continue;
        try {
          await this.send(next.id, next.value);
        } catch {
          if (next.id === this.id) {
            this.close();
            this.invalidated(next.id);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
