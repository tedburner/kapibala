/**
 * @fileoverview Kapibala MCP 生态适配层根导出
 *
 * 约束与边界：
 * 1. 负责受控接入 MCP (Model Context Protocol) 规范的客户端适配器与生命周期管理；
 * 2. 依赖 `@kiturone/kapibala`（Core），但 Core 绝不反向依赖本包，维持 Headless Core 零外部运行时依赖；
 * 3. 严格遵循有界发现、启动授权、安全审批复核与防隐式重放机制。
 */

/** 当前 MCP 适配包的版本标识，与项目整体版本发布节奏保持同步。 */
export const MCP_PACKAGE_VERSION = '0.0.5';

/**
 * MCP 客户端生态初始化选项基础接口。
 */
export interface McpInitOptions {
  /** 沙箱执行根目录；物理路径解析与越界检查均以此目录为基准。 */
  rootDir: string;
}

export * from './config.js';
export * from './path.js';
export * from './env.js';
export * from './auth.js';
export * from './types.js';
export * from './transports/stderr.js';
export * from './transports/process-tree.js';
export * from './transports/stdio.js';
export * from './transports/ip-security.js';
export * from './transports/http.js';
export * from './client.js';
export * from './manager.js';
export * from './plugin.js';
export * from './tools/naming.js';
export * from './tools/schema.js';
export * from './tools/budget.js';
export * from './tools/adapter.js';
export * from './tools/catalog.js';
export * from './results/sanitizer.js';
export * from './results/converter.js';
export * from './prompts/registry.js';
export * from './prompts/validator.js';
export * from './prompts/runner.js';
