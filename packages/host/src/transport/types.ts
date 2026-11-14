import type { WireMessage } from '../protocol/index.js';

/** 传输只消费帧和排队字节预算；握手后可以收紧，不能扩大已设定上限。 */
export interface TransportLimits {
  readonly maxFrameBytes: number;
  readonly maxSendQueueBytes: number;
}

/** 有序且有界的传输，不拥有工具权限；关闭只解绑传入流，不关闭宿主 stdout。 */
export interface LocalTransport {
  /** 同步收紧已有解码缓冲和发送队列；现存数据超限时关闭并抛错。 */
  setLimits(limits: TransportLimits): void;
  readonly messages: AsyncIterable<WireMessage>;
  send(message: WireMessage): Promise<void>;
  close(): Promise<void>;
}
