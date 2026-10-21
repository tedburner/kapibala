import type { WireMessage } from '../protocol/index.js';

/** 有序且有界的传输，不拥有工具权限；关闭只解绑传入流，不关闭宿主 stdout。 */
export interface LocalTransport {
  readonly messages: AsyncIterable<WireMessage>;
  send(message: WireMessage): Promise<void>;
  close(): Promise<void>;
}
