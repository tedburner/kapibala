/** Node 客户端入口无启动副作用；浏览器宿主使用独立 protocol/view-model 子路径。 */
export * from './local-client.js';
export type { LocalTransport, TransportLimits } from '../transport/types.js';
export { connectLocal } from '../transport/socket.js';
export type { LocalEndpoint } from '../transport/socket.js';
export { createStdioTransport } from '../transport/stdio.js';
export type { StdioTransportOptions } from '../transport/stdio.js';
