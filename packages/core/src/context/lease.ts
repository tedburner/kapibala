/**
 * @fileoverview 共享工作区写租约（Workspace Write Lease）协调器导出。
 *
 * 保持 context/lease.ts 兼容导出，真源已统一收拢至 capabilities/security/lease.ts，
 * 满足架构分层边界与 Headless 运行契约。
 */

export * from '../capabilities/security/lease.js';
