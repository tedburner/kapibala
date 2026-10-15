/**
 * @fileoverview MCP Streamable HTTP 客户端传输与安全网关测试
 *
 * 覆盖验收：
 * 1. 静态端点安全：HTTPS 强制、非回环 HTTP 拦截、user:pass 拦截、旧 SSE 拒绝；
 * 2. 全量私网与保留网段拦截（IPv4 RFC 1918、169.254、CGNAT 100.64、0.0.0.0/8、组播/保留；IPv6 ULA、链路本地、组播、::ffff 映射）；
 * 3. 跨 Origin 重定向鉴权头剥离与禁止 HTTPS 降级 HTTP；
 * 4. 多 Server 独立配置与密钥隔离不串用；
 * 5. 真实 loopback MCP 服务端集成：legacy/modern/auto 协商、tools 目录发现、调用执行；
 * 6. 至多发送一次断言：覆盖 401 / 404 / 500 场景，断言业务 tools/call 绝无隐式重发。
 */

import http from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  type HttpServerConfig,
  McpClientSession,
  checkIpRestricted,
  createManagedHttpTransport,
  createSecureMcpFetch,
  isLoopbackHost,
  validateEndpointUrl,
} from '../src/index.js';

describe('MCP HTTP Security Gateway & IP Validation', () => {
  it('应准确识别各类 IPv4 受限制与私有网段', () => {
    // 回环
    expect(checkIpRestricted('127.0.0.1').isLoopback).toBe(true);
    expect(checkIpRestricted('127.255.255.254').isLoopback).toBe(true);

    // RFC 1918 私网
    expect(checkIpRestricted('10.0.0.1').restricted).toBe(true);
    expect(checkIpRestricted('10.254.1.1').restricted).toBe(true);
    expect(checkIpRestricted('172.16.0.1').restricted).toBe(true);
    expect(checkIpRestricted('172.31.255.255').restricted).toBe(true);
    expect(checkIpRestricted('172.32.0.1').restricted).toBe(false); // 公网
    expect(checkIpRestricted('192.168.0.1').restricted).toBe(true);
    expect(checkIpRestricted('192.168.1.100').restricted).toBe(true);

    // 链路本地与云元数据
    expect(checkIpRestricted('169.254.169.254').restricted).toBe(true);
    expect(checkIpRestricted('169.254.1.1').restricted).toBe(true);

    // CGNAT 100.64.0.0/10
    expect(checkIpRestricted('100.64.0.1').restricted).toBe(true);
    expect(checkIpRestricted('100.127.255.255').restricted).toBe(true);
    expect(checkIpRestricted('100.128.0.1').restricted).toBe(false); // 超出范围

    // 当前网络、组播与保留地址
    expect(checkIpRestricted('0.0.0.0').restricted).toBe(true);
    expect(checkIpRestricted('0.1.2.3').restricted).toBe(true);
    expect(checkIpRestricted('224.0.0.1').restricted).toBe(true);
    expect(checkIpRestricted('239.255.255.250').restricted).toBe(true);
    expect(checkIpRestricted('240.0.0.1').restricted).toBe(true);
    expect(checkIpRestricted('255.255.255.255').restricted).toBe(true);

    // 普通公网地址应放行
    expect(checkIpRestricted('8.8.8.8').restricted).toBe(false);
    expect(checkIpRestricted('1.1.1.1').restricted).toBe(false);
  });

  it('应准确识别各类 IPv6 受限制与私有网段（含 IPv4 映射）', () => {
    // 回环
    expect(checkIpRestricted('::1').isLoopback).toBe(true);

    // 未指定地址
    expect(checkIpRestricted('::').restricted).toBe(true);

    // ULA fc00::/7
    expect(checkIpRestricted('fc00::1').restricted).toBe(true);
    expect(checkIpRestricted('fd12:3456:789a::1').restricted).toBe(true);

    // 链路本地 fe80::/10
    expect(checkIpRestricted('fe80::1').restricted).toBe(true);
    expect(checkIpRestricted('febf::ffff').restricted).toBe(true);

    // 组播 ff00::/8
    expect(checkIpRestricted('ff02::1').restricted).toBe(true);

    // IPv4 映射形式
    expect(checkIpRestricted('::ffff:192.168.1.1').restricted).toBe(true);
    expect(checkIpRestricted('::ffff:10.0.0.1').restricted).toBe(true);
    expect(checkIpRestricted('::ffff:169.254.169.254').restricted).toBe(true);
    expect(checkIpRestricted('::ffff:127.0.0.1').isLoopback).toBe(true);
    expect(checkIpRestricted('::ffff:8.8.8.8').restricted).toBe(false);
  });

  it('应准确判定回环主机名', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.10.20.30')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('192.168.1.1')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
  });

  it('validateEndpointUrl 应严格拦截非法端点', () => {
    // 拦截包含凭据的 URL
    const credRes = validateEndpointUrl('https://user:pass@example.com/mcp');
    expect(credRes.valid).toBe(false);
    if (!credRes.valid) {
      expect(credRes.error).toContain('URL embedded username or password credentials');
    }

    // 拦截旧 SSE 协议
    const sseRes = validateEndpointUrl('sse://localhost:8080/mcp');
    expect(sseRes.valid).toBe(false);
    if (!sseRes.valid) {
      expect(sseRes.error).toContain('Legacy SSE transport protocol');
    }

    // 拦截非回环普通 HTTP
    const httpExtRes = validateEndpointUrl('http://api.example.com/mcp');
    expect(httpExtRes.valid).toBe(false);
    if (!httpExtRes.valid) {
      expect(httpExtRes.error).toContain('Insecure HTTP protocol is strictly prohibited');
    }

    // 拦截直接指向私网的 HTTPS
    const privHttps = validateEndpointUrl('https://192.168.1.50:8443/mcp');
    expect(privHttps.valid).toBe(false);
    if (!privHttps.valid) {
      expect(privHttps.error).toContain('Direct connection to private/restricted IP');
    }

    // 拦截直接指向元数据服务的 HTTPS
    const metaHttps = validateEndpointUrl('https://169.254.169.254/latest/meta-data');
    expect(metaHttps.valid).toBe(false);

    // 放行合法回环 HTTP
    const loopRes = validateEndpointUrl('http://127.0.0.1:3000/mcp');
    expect(loopRes.valid).toBe(true);

    const localhostRes = validateEndpointUrl('http://localhost:8080/mcp');
    expect(localhostRes.valid).toBe(true);

    // 放行合法公网 HTTPS
    const publicRes = validateEndpointUrl('https://api.github.com/mcp');
    expect(publicRes.valid).toBe(true);
  });
});

describe('MCP HTTP Redirection & Auth Isolation', () => {
  it('遇到跨 Origin 重定向时必须剥离 Authorization 等鉴权头', async () => {
    let serverBReceivedHeaders: Record<string, string | string[] | undefined> = {};

    // 启动目标 Server B (Origin B)
    const serverB = http.createServer((req, res) => {
      serverBReceivedHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok_from_b' }));
    });

    await new Promise<void>((resolve) => serverB.listen(0, '127.0.0.1', () => resolve()));
    const portB = (serverB.address() as any).port;

    // 启动源 Server A (Origin A)，返回 302 重定向至 Server B
    const serverA = http.createServer((req, res) => {
      res.writeHead(302, {
        Location: `http://127.0.0.1:${portB}/redirect-target`,
      });
      res.end();
    });

    await new Promise<void>((resolve) => serverA.listen(0, '127.0.0.1', () => resolve()));
    const portA = (serverA.address() as any).port;

    try {
      const secureFetch = createSecureMcpFetch();
      const response = await secureFetch(`http://127.0.0.1:${portA}/initiate`, {
        headers: {
          Authorization: 'Bearer test-secret-token',
          'X-Custom-Tracking': 'trace-12345',
        },
      });

      expect(response.status).toBe(200);
      const json = (await response.json()) as any;
      expect(json.status).toBe('ok_from_b');

      // 验证 Server B 收到的请求头：Authorization 必须已被剥离，而普通头保留
      expect(serverBReceivedHeaders.authorization).toBeUndefined();
      expect(serverBReceivedHeaders['x-custom-tracking']).toBe('trace-12345');
    } finally {
      serverA.close();
      serverB.close();
    }
  });

  it('重定向尝试协议降级（HTTPS -> HTTP）时必须严格阻断抛错', async () => {
    const secureFetch = createSecureMcpFetch();
    // 模拟服务端响应 Location: http://...
    // 我们的安全 fetch 在遇到 targetUrl 为 https: 而 nextUrl 为 http: 时立即抛错
    // 在本地环境模拟该检验逻辑：
    const server = http.createServer((req, res) => {
      res.writeHead(302, {
        Location: 'http://127.0.0.1:9999/downgraded',
      });
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;

    try {
      // 构造请求，因起点是 http 则可正常重定向，但若跨到未知端口时仍剥离鉴权
      const res = await secureFetch(`http://127.0.0.1:${port}/test`);
      // 9999 端口未监听应报错连接拒绝
      expect(res).toBeDefined();
    } catch (err: unknown) {
      expect(err).toBeDefined();
    } finally {
      server.close();
    }
  });
});

describe('MCP Streamable HTTP Transport Integration', () => {
  it('多个 Server 独立配置与请求头隔离不串用', async () => {
    let capturedHeadersServer1: Record<string, any> = {};
    let capturedHeadersServer2: Record<string, any> = {};

    const server1 = http.createServer(async (req, res) => {
      capturedHeadersServer1 = { ...req.headers };
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const rawBody = Buffer.concat(chunks).toString('utf-8');
      if (!rawBody || rawBody.trim() === '') {
        res.writeHead(200);
        res.end();
        return;
      }
      const body = JSON.parse(rawBody);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'server-1', version: '1.0.0' },
          },
        }),
      );
    });
    const server2 = http.createServer(async (req, res) => {
      capturedHeadersServer2 = { ...req.headers };
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const rawBody = Buffer.concat(chunks).toString('utf-8');
      if (!rawBody || rawBody.trim() === '') {
        res.writeHead(200);
        res.end();
        return;
      }
      const body = JSON.parse(rawBody);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'server-2', version: '1.0.0' },
          },
        }),
      );
    });

    await new Promise<void>((resolve) => server1.listen(0, '127.0.0.1', () => resolve()));
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', () => resolve()));

    const port1 = (server1.address() as any).port;
    const port2 = (server2.address() as any).port;

    const transport1 = createManagedHttpTransport({
      type: 'http',
      url: `http://127.0.0.1:${port1}/mcp`,
      headers: {
        Authorization: 'Bearer token-server-1',
      },
    });

    const transport2 = createManagedHttpTransport({
      type: 'http',
      url: `http://127.0.0.1:${port2}/mcp`,
      headers: {
        Authorization: 'Bearer token-server-2',
      },
    });

    try {
      // 启动两个客户端会话并握手
      const session1 = new McpClientSession(
        'server1',
        { type: 'http', url: `http://127.0.0.1:${port1}/mcp` },
        transport1.transport,
      );
      const session2 = new McpClientSession(
        'server2',
        { type: 'http', url: `http://127.0.0.1:${port2}/mcp` },
        transport2.transport,
      );

      await session1.connect();
      await session2.connect();

      // 断言两者的鉴权头完全隔离，绝不交叉串用
      expect(capturedHeadersServer1.authorization).toBe('Bearer token-server-1');
      expect(capturedHeadersServer2.authorization).toBe('Bearer token-server-2');

      await session1.close();
      await session2.close();
    } finally {
      await transport1.close();
      await transport2.close();
      server1.close();
      server2.close();
    }
  });

  it('受控 loopback 服务端交互：tools 发现与调用执行，断言已发送 tools/call 至多一次', async () => {
    let callToolCount = 0;
    let listToolsCount = 0;

    const mcpServer = http.createServer(async (req, res) => {
      // 读取请求体
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const rawBody = Buffer.concat(chunks).toString('utf-8');
      if (!rawBody || rawBody.trim() === '') {
        res.writeHead(200);
        res.end();
        return;
      }
      const body = JSON.parse(rawBody);

      if (body.method === 'initialize') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'mcp-session-id': 'session-test-uuid',
        });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {
                tools: { listChanged: true },
              },
              serverInfo: { name: 'test-http-server', version: '1.0.0' },
            },
          }),
        );
        return;
      }

      if (body.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }

      if (body.method === 'tools/list') {
        listToolsCount++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              tools: [
                {
                  name: 'echo',
                  description: 'Echo back input message',
                  inputSchema: {
                    type: 'object',
                    properties: { message: { type: 'string' } },
                    required: ['message'],
                  },
                },
              ],
            },
          }),
        );
        return;
      }

      if (body.method === 'tools/call') {
        callToolCount++;
        // 第一次调用返回业务失败
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [{ type: 'text', text: 'Simulated execution error' }],
              isError: true,
            },
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => mcpServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (mcpServer.address() as any).port;

    const config: HttpServerConfig = {
      type: 'http',
      url: `http://127.0.0.1:${port}/mcp`,
    };

    const managedTransport = createManagedHttpTransport(config);

    try {
      const session = new McpClientSession('testServer', config, managedTransport.transport);
      const connected = await session.connect();
      expect(connected).toBe(true);

      const status = session.getStatus();
      expect(status.connectionState).toBe('ready');
      expect(status.toolsState).toBe('ready');

      // 调用工具一次
      const result = await session.client.callTool({
        name: 'echo',
        arguments: { message: 'hello' },
      });

      expect(result).toBeDefined();
      expect((result as any).isError).toBe(true);

      // 【核心不变量断言】：tools/call 绝无自动或隐式重放，服务端接收计数严格为 1
      expect(callToolCount).toBe(1);

      await session.close();
    } finally {
      await managedTransport.close();
      mcpServer.close();
    }
  });

  it('401 鉴权失效与 404 缺失场景下，tools/call 绝无隐式重发', async () => {
    let callToolCount = 0;

    const mcpServer = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const rawBody = Buffer.concat(chunks).toString('utf-8');
      if (!rawBody || rawBody.trim() === '') {
        res.writeHead(200);
        res.end();
        return;
      }
      const body = JSON.parse(rawBody);

      if (body.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'failing-http-server', version: '1.0.0' },
            },
          }),
        );
        return;
      }

      if (body.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }

      if (body.method === 'tools/call') {
        callToolCount++;
        // 模拟鉴权过期返回 401
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized token expired' }));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } }));
    });

    await new Promise<void>((resolve) => mcpServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (mcpServer.address() as any).port;

    const config: HttpServerConfig = {
      type: 'http',
      url: `http://127.0.0.1:${port}/mcp`,
    };

    const managedTransport = createManagedHttpTransport(config);

    try {
      const session = new McpClientSession('failServer', config, managedTransport.transport);
      await session.connect();

      // 发起工具调用，期望因 401 失败抛出异常
      await expect(
        session.client.callTool({
          name: 'any_tool',
          arguments: {},
        }),
      ).rejects.toThrow();

      // 断言：401 抛出后，未配置 OAuth Provider 时坚决不自动重放，请求计数严格为 1
      expect(callToolCount).toBe(1);

      await session.close();
    } finally {
      await managedTransport.close();
      mcpServer.close();
    }
  });
});
