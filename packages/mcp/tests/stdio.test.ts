/**
 * @fileoverview MCP Stdio 传输、进程树回收与能力协商集成测试
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BoundedStderrBuffer,
  DEFAULT_STDERR_TAIL_LIMIT_BYTES,
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_MODERN_PROTOCOL_VERSION,
  McpClientSession,
  createManagedStdioTransport,
  isProcessAlive,
  killProcessTree,
} from '../src/index.js';

const SERVER_MODULE_URL = `file:///${path
  .resolve('packages/mcp/node_modules/@modelcontextprotocol/server/dist/index.mjs')
  .replace(/\\/g, '/')}`;

const STDIO_MODULE_URL = `file:///${path
  .resolve('packages/mcp/node_modules/@modelcontextprotocol/server/dist/stdio.mjs')
  .replace(/\\/g, '/')}`;

describe('MCP Stdio & Process Lifecycle', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-mcp-stdio-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe('BoundedStderrBuffer', () => {
    it('buffers stderr output up to the limit and maintains tail bytes', () => {
      const buffer = new BoundedStderrBuffer(100);
      buffer.append('Hello world!\n');
      expect(buffer.getText()).toBe('Hello world!\n');
      expect(buffer.byteLength).toBe(13);

      // 追加超过 100 字节的数据
      const largeChunk = 'A'.repeat(120);
      buffer.append(largeChunk);

      expect(buffer.byteLength).toBe(100);
      expect(buffer.getText()).toBe('A'.repeat(100));
    });

    it('strips ANSI color and formatting escape codes', () => {
      const buffer = new BoundedStderrBuffer(500);
      buffer.append('\u001B[31m[ERROR]\u001B[0m Something failed \u001B[1;33mwarning\u001B[0m\n');

      expect(buffer.getText(true)).toBe('[ERROR] Something failed warning\n');
      expect(buffer.getText(false)).toContain('\u001B[31m');
    });

    it('clears buffer cleanly', () => {
      const buffer = new BoundedStderrBuffer(500);
      buffer.append('Some text');
      expect(buffer.byteLength).toBe(9);
      buffer.clear();
      expect(buffer.byteLength).toBe(0);
      expect(buffer.getText()).toBe('');
    });
  });

  describe('killProcessTree', () => {
    it('terminates a running process tree completely and is safe to call repeatedly', async () => {
      // 启动一个长久驻留的子进程
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        windowsHide: true,
      });

      const pid = child.pid;
      expect(pid).toBeDefined();
      expect(isProcessAlive(pid!)).toBe(true);

      const stopped = await killProcessTree(pid!, { timeoutMs: 3000 });
      expect(stopped).toBe(true);
      expect(isProcessAlive(pid!)).toBe(false);

      // 重复调用幂等安全
      const secondCall = await killProcessTree(pid!, { timeoutMs: 1000 });
      expect(secondCall).toBe(true);
    });
  });

  describe('StdioClientTransport with Real MCP Servers', () => {
    it('starts an actual Stdio server, discovers tools, and tears down cleanly', async () => {
      // 编写受控 Stdio MCP 服务端脚本
      const serverScript = path.join(tmpDir, 'tools-server.mjs');
      const serverCode = `
        import { Server } from '${SERVER_MODULE_URL}';
        import { StdioServerTransport } from '${STDIO_MODULE_URL}';

        const server = new Server(
          { name: 'test-tools-srv', version: '1.0.0' },
          { capabilities: { tools: {} } }
        );

        server.assertCapabilityForMethod = () => {};
        server.fallbackRequestHandler = async (req) => {
          if (req.method === 'tools/list') {
            return {
              tools: [
                {
                  name: 'calculator',
                  description: 'Performs arithmetic calculation',
                  inputSchema: { type: 'object' }
                }
              ]
            };
          }
          return {};
        };

        const transport = new StdioServerTransport();
        await server.connect(transport);
      `;
      fs.writeFileSync(serverScript, serverCode, 'utf8');

      const managed = createManagedStdioTransport({
        command: process.execPath,
        args: [serverScript],
        cwd: tmpDir,
      });

      const session = new McpClientSession(
        'test-server',
        { command: process.execPath, args: [serverScript] },
        managed.transport,
        1,
        { startupTimeoutMs: 5000, catalogTimeoutMs: 5000 },
      );

      const connected = await session.connect();
      expect(connected).toBe(true);

      const status = session.getStatus();
      expect(status.connectionState).toBe('ready');
      expect(status.toolsState).toBe('ready');
      expect(status.promptsState).toBe('unsupported');
      expect(session.discoveredTools).toHaveLength(1);
      expect(session.discoveredTools[0].name).toBe('calculator');
      expect(session.isReady()).toBe(true);

      // 关闭测试
      await session.close();
      const closed = await managed.close(3000);
      expect(closed).toBe(true);
      expect(managed.isAlive()).toBe(false);
    });

    it('identifies Prompt-only server and does not mistakenly send tools/list', async () => {
      const serverScript = path.join(tmpDir, 'prompt-only-server.mjs');
      const serverCode = `
        import { Server } from '${SERVER_MODULE_URL}';
        import { StdioServerTransport } from '${STDIO_MODULE_URL}';

        const server = new Server(
          { name: 'test-prompt-srv', version: '1.0.0' },
          { capabilities: { prompts: {} } }
        );

        server.fallbackRequestHandler = async (req) => {
          if (req.method === 'tools/list') {
            throw new Error('tools/list should NEVER be called on prompt-only server');
          }
          if (req.method === 'prompts/list') {
            return {
              prompts: [
                {
                  name: 'code_review',
                  description: 'Review given code snippet'
                }
              ]
            };
          }
          return {};
        };

        const transport = new StdioServerTransport();
        await server.connect(transport);
      `;
      fs.writeFileSync(serverScript, serverCode, 'utf8');

      const managed = createManagedStdioTransport({
        command: process.execPath,
        args: [serverScript],
        cwd: tmpDir,
      });

      const session = new McpClientSession(
        'prompt-server',
        { command: process.execPath, args: [serverScript] },
        managed.transport,
        1,
      );

      const connected = await session.connect();
      expect(connected).toBe(true);

      const status = session.getStatus();
      expect(status.connectionState).toBe('ready');
      expect(status.toolsState).toBe('unsupported');
      expect(status.promptsState).toBe('ready');
      expect(session.discoveredTools).toEqual([]);
      expect(session.discoveredPrompts).toHaveLength(1);
      expect(session.discoveredPrompts[0].name).toBe('code_review');
      expect(session.isReady()).toBe(true);

      await session.close();
      await managed.close(3000);
    });

    it('negotiates explicit legacy (2024-11-05) and modern (2025-11-25) protocols', async () => {
      const serverScript = path.join(tmpDir, 'echo-server.mjs');
      const serverCode = `
        import { Server } from '${SERVER_MODULE_URL}';
        import { StdioServerTransport } from '${STDIO_MODULE_URL}';

        const server = new Server(
          { name: 'echo-srv', version: '1.0.0' },
          { capabilities: { tools: {} } }
        );
        server.fallbackRequestHandler = async () => ({ tools: [] });
        const transport = new StdioServerTransport();
        await server.connect(transport);
      `;
      fs.writeFileSync(serverScript, serverCode, 'utf8');

      // 1. 显式 legacy 模式
      const legacyManaged = createManagedStdioTransport({
        command: process.execPath,
        args: [serverScript],
        cwd: tmpDir,
      });
      const legacySession = new McpClientSession(
        'legacy-srv',
        { command: process.execPath, args: [serverScript], protocol: 'legacy' },
        legacyManaged.transport,
        1,
        { protocol: 'legacy' },
      );
      await legacySession.connect();
      expect(legacySession.getStatus().protocolVersion).toBe(MCP_LEGACY_PROTOCOL_VERSION);
      await legacySession.close();
      await legacyManaged.close(2000);

      // 2. 显式 modern 模式
      const modernManaged = createManagedStdioTransport({
        command: process.execPath,
        args: [serverScript],
        cwd: tmpDir,
      });
      const modernSession = new McpClientSession(
        'modern-srv',
        { command: process.execPath, args: [serverScript], protocol: 'modern' },
        modernManaged.transport,
        1,
        { protocol: 'modern' },
      );
      await modernSession.connect();
      expect(modernSession.getStatus().protocolVersion).toBe(MCP_MODERN_PROTOCOL_VERSION);
      await modernSession.close();
      await modernManaged.close(2000);
    });

    it('captures bounded stderr diagnostics in real time', async () => {
      const serverScript = path.join(tmpDir, 'err-server.mjs');
      const serverCode = `
        import { Server } from '${SERVER_MODULE_URL}';
        import { StdioServerTransport } from '${STDIO_MODULE_URL}';

        process.stderr.write('\\u001B[32m[INFO]\\u001B[0m Server booting\\n');
        process.stderr.write('Diagnostic warning trace\\n');

        const server = new Server(
          { name: 'err-srv', version: '1.0.0' },
          { capabilities: { tools: {} } }
        );
        server.fallbackRequestHandler = async () => ({ tools: [] });
        const transport = new StdioServerTransport();
        await server.connect(transport);
      `;
      fs.writeFileSync(serverScript, serverCode, 'utf8');

      const managed = createManagedStdioTransport({
        command: process.execPath,
        args: [serverScript],
        cwd: tmpDir,
      });

      const session = new McpClientSession(
        'err-srv',
        { command: process.execPath, args: [serverScript] },
        managed.transport,
      );

      await session.connect();

      // 等待 stderr 写入管道并被消费
      await new Promise((resolve) => setTimeout(resolve, 200));

      const stderrText = managed.stderrBuffer.getText();
      expect(stderrText).toContain('[INFO] Server booting');
      expect(stderrText).toContain('Diagnostic warning trace');
      // 确认 ANSI 已被剔除
      expect(stderrText).not.toContain('\u001B[32m');

      await session.close();
      await managed.close(2000);
    });
  });
});
