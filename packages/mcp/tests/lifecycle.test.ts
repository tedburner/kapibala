/**
 * @fileoverview MCP 会话所有权、状态机、重连与生命周期回滚测试
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PluginContext } from '@kiturone/kapibala';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  McpClientSession,
  McpServerManager,
  createManagedStdioTransport,
  createMcpPlugin,
  isProcessAlive,
} from '../src/index.js';

const SERVER_MODULE_URL = `file:///${path
  .resolve('packages/mcp/node_modules/@modelcontextprotocol/server/dist/index.mjs')
  .replace(/\\/g, '/')}`;

const STDIO_MODULE_URL = `file:///${path
  .resolve('packages/mcp/node_modules/@modelcontextprotocol/server/dist/stdio.mjs')
  .replace(/\\/g, '/')}`;

describe('MCP Lifecycle, State Machine & Ownership', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-mcp-lifecycle-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  const allowAuthorizer = async () => 'allow_session' as const;

  function createMockPluginContext(rootDir: string): PluginContext {
    return {
      rootDir,
      tools: {
        register: () => {},
        get: () => undefined,
        list: () => [],
      } as any,
      hooks: {
        register: () => {},
      } as any,
    };
  }

  function writeToolsServerScript(filename: string, toolName = 'sample_tool'): string {
    const scriptPath = path.join(tmpDir, filename);
    const code = `
      import { Server } from '${SERVER_MODULE_URL}';
      import { StdioServerTransport } from '${STDIO_MODULE_URL}';

      const server = new Server(
        { name: '${toolName}-srv', version: '1.0.0' },
        { capabilities: { tools: {} } }
      );
      server.fallbackRequestHandler = async (req) => {
        if (req.method === 'tools/list') {
          return { tools: [{ name: '${toolName}', inputSchema: { type: 'object' } }] };
        }
        return {};
      };
      const transport = new StdioServerTransport();
      await server.connect(transport);
    `;
    fs.writeFileSync(scriptPath, code, 'utf8');
    return scriptPath;
  }

  function writeFailingServerScript(filename: string): string {
    const scriptPath = path.join(tmpDir, filename);
    const code = `
      process.stderr.write('Fatal boot error\\n');
      process.exit(1);
    `;
    fs.writeFileSync(scriptPath, code, 'utf8');
    return scriptPath;
  }

  describe('One-Session-One-Plugin Constraint (Task 4.1)', () => {
    it('prevents mounting the same plugin multiple times or across different sessions', async () => {
      const serverScript = writeToolsServerScript('srv1.mjs');
      const plugin = createMcpPlugin(
        {
          srv1: {
            command: process.execPath,
            args: [serverScript],
            cwd: tmpDir,
          },
        },
        { authorizer: allowAuthorizer },
      );

      expect(plugin.isMounted).toBe(false);
      expect(plugin.mountedSessionId).toBeNull();

      const ctx1 = createMockPluginContext(path.join(tmpDir, 'session-1'));
      await plugin.setup(ctx1);

      expect(plugin.isMounted).toBe(true);
      expect(plugin.mountedSessionId).toBe(ctx1.rootDir);

      // 同一会话重复调用 setup 必须被拒绝
      await expect(plugin.setup(ctx1)).rejects.toThrow(
        /is already mounted to a session.*and cannot be reused/,
      );

      // 跨会话调用 setup 必须被拒绝
      const ctx2 = createMockPluginContext(path.join(tmpDir, 'session-2'));
      await expect(plugin.setup(ctx2)).rejects.toThrow(
        /is already mounted to a session.*and cannot be reused/,
      );

      await plugin.teardown!();
    });

    it('rolls back all spawned resources when setup fails on a required server', async () => {
      const okScript = writeToolsServerScript('ok-srv.mjs');
      const failScript = writeFailingServerScript('fail-srv.mjs');

      const plugin = createMcpPlugin(
        {
          okServer: {
            command: process.execPath,
            args: [okScript],
            cwd: tmpDir,
            required: false,
          },
          failingServer: {
            command: process.execPath,
            args: [failScript],
            cwd: tmpDir,
            required: true, // required 失败阻断整体 setup
          },
        },
        { startupTimeoutMs: 3000, authorizer: allowAuthorizer },
      );

      const ctx = createMockPluginContext(tmpDir);

      await expect(plugin.setup(ctx)).rejects.toThrow(/failed to achieve ready status/);

      // 验证回滚：正常启动的可选服务也已被清理关闭，无孤儿进程
      expect(plugin.manager.isTornDown).toBe(true);
      const okStatus = plugin.manager.getStatus('okServer');
      expect(['disconnected', 'failed']).toContain(okStatus?.connectionState);
      if (okStatus?.pid) {
        expect(isProcessAlive(okStatus.pid)).toBe(false);
      }
    });
  });

  describe('Required vs Optional Servers & Concurrency (Task 4.3)', () => {
    it('allows optional server failure without breaking overall startup', async () => {
      const okScript = writeToolsServerScript('good.mjs', 'good_tool');
      const badScript = writeFailingServerScript('bad.mjs');

      const manager = new McpServerManager({ authorizer: allowAuthorizer });
      const result = await manager.startupAll({
        optionalFail: {
          command: process.execPath,
          args: [badScript],
          cwd: tmpDir,
          required: false,
        },
        requiredOk: {
          command: process.execPath,
          args: [okScript],
          cwd: tmpDir,
          required: true,
        },
      });

      expect(result.success).toBe(true);
      expect(result.readyServers).toContain('requiredOk');
      expect(result.failedServers).toHaveProperty('optionalFail');

      // 失败的可选服务底层句柄已被关闭回收
      const failStatus = manager.getStatus('optionalFail');
      expect(failStatus?.connectionState).toBe('failed');
      if (failStatus?.pid) {
        expect(isProcessAlive(failStatus.pid)).toBe(false);
      }

      await manager.teardown();
    });

    it('retains Tools ready even if Prompts catalog discovery fails on a mixed server', async () => {
      const mixedScript = path.join(tmpDir, 'mixed-srv.mjs');
      const code = `
        import { Server } from '${SERVER_MODULE_URL}';
        import { StdioServerTransport } from '${STDIO_MODULE_URL}';

        const server = new Server(
          { name: 'mixed-srv', version: '1.0.0' },
          { capabilities: { tools: {}, prompts: {} } }
        );

        server.fallbackRequestHandler = async (req) => {
          if (req.method === 'tools/list') {
            return { tools: [{ name: 'mixed_tool', inputSchema: { type: 'object' } }] };
          }
          if (req.method === 'prompts/list') {
            throw new Error('Prompts catalog exploded');
          }
          return {};
        };
        const transport = new StdioServerTransport();
        await server.connect(transport);
      `;
      fs.writeFileSync(mixedScript, code, 'utf8');

      const manager = new McpServerManager({ authorizer: allowAuthorizer });
      const result = await manager.startupAll({
        mixedServer: {
          command: process.execPath,
          args: [mixedScript],
          cwd: tmpDir,
          required: true,
        },
      });

      expect(result.success).toBe(true);
      const status = manager.getStatus('mixedServer');
      expect(status?.connectionState).toBe('ready');
      expect(status?.toolsState).toBe('ready');
      expect(status?.promptsState).toBe('unavailable');

      await manager.teardown();
    });
  });

  describe('Generation, Epoch & Manual Reconnect (Task 4.4)', () => {
    it('reconnects using in-memory config, increments generation, and safely cleans old transport', async () => {
      const serverScript = writeToolsServerScript('reconnect-srv.mjs', 'tool_v1');

      const manager = new McpServerManager({ authorizer: allowAuthorizer });
      await manager.startupAll({
        recServer: {
          command: process.execPath,
          args: [serverScript],
          cwd: tmpDir,
          required: true,
        },
      });

      const initialStatus = manager.getStatus('recServer');
      expect(initialStatus?.generation).toBe(1);
      expect(initialStatus?.connectionState).toBe('ready');
      const firstPid = initialStatus?.pid;

      // 手动触发重连
      await manager.reconnectServer('recServer');

      const reconnectedStatus = manager.getStatus('recServer');
      expect(reconnectedStatus?.generation).toBe(2);
      expect(reconnectedStatus?.connectionState).toBe('ready');

      // 验证第一代子进程已被回收
      if (firstPid) {
        expect(isProcessAlive(firstPid)).toBe(false);
      }

      await manager.teardown();
    });

    it('teardown is fully idempotent', async () => {
      const serverScript = writeToolsServerScript('idempotent-srv.mjs');

      const manager = new McpServerManager({ authorizer: allowAuthorizer });
      await manager.startupAll({
        idemServer: {
          command: process.execPath,
          args: [serverScript],
          cwd: tmpDir,
        },
      });

      await manager.teardown();
      expect(manager.isTornDown).toBe(true);

      // 第二次调用无异常返回
      await expect(manager.teardown()).resolves.toBeUndefined();
    });
  });
});
