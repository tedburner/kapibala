/**
 * 传输层子路径入口：本地 socket / stdio / RPC 与帧协议的完整导出面。
 * CLI 的 local-host 服务端与客户端门面都经此消费；不携带任何宿主装配逻辑。
 */
export * from './types.js';
export * from './jsonl.js';
export * from './rpc.js';
export * from './stdio.js';
export * from './socket.js';
