import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * MCP 真实服务端探针：同一进程只作为客户端，Stdio 与 HTTP 服务端都是真实进程/端点。
 * 覆盖启动授权、调用、撤销后拒绝、重新启用、取消、teardown 与失败重试。
 */

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1 || index === args.length - 1) throw new Error(`Missing --${name}`);
  return args[index + 1];
};

const mcpEntry = path.resolve(option('mcp'));
const coreEntry = path.resolve(option('core'));
const mcpPackageDir = path.resolve(option('mcp-package-dir'));
const root = path.resolve(option('root'));
const resultPath = path.resolve(option('result'));

const mcp = await import(pathToFileURL(mcpEntry).href);
const core = await import(pathToFileURL(coreEntry).href);
const serverModule = pathToFileURL(
  path.join(mcpPackageDir, 'node_modules/@modelcontextprotocol/server/dist/index.mjs'),
).href;
const stdioModule = pathToFileURL(
  path.join(mcpPackageDir, 'node_modules/@modelcontextprotocol/server/dist/stdio.mjs'),
).href;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`Timed out: ${label}`);
}
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
function toolText(result) {
  if (!result || typeof result !== 'object') return String(result);
  const content = result.content;
  if (Array.isArray(content)) {
    return content
      .filter((item) => item?.type === 'text')
      .map((item) => item.text)
      .join('');
  }
  return JSON.stringify(result);
}
function findTool(manager, server, suffix) {
  return manager.getServerTools(server).find((tool) => tool.name.endsWith(`__${suffix}`));
}

function writeStdioServer(file, pidFile, { flaky = false, label = 'stdio' } = {}) {
  const marker = path.join(root, 'mcp-flaky.marker');
  fs.writeFileSync(
    file,
    [
      `import fs from 'node:fs';`,
      `import { Server } from '${serverModule}';`,
      `import { StdioServerTransport } from '${stdioModule}';`,
      ...(flaky
        ? [
            `if (!fs.existsSync(${JSON.stringify(marker)})) {`,
            `  fs.writeFileSync(${JSON.stringify(marker)}, 'attempted');`,
            '  process.exit(1);',
            '}',
          ]
        : []),
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      `const server = new Server({ name: 'platform-stdio', version: '1.0.0' }, { capabilities: { tools: {} } });`,
      'server.assertCapabilityForMethod = () => {};',
      'server.fallbackRequestHandler = async (request) => {',
      `  if (request.method === 'tools/list') return {`,
      '    tools: [',
      `      { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } },`,
      `      { name: 'slow', description: 'slow', inputSchema: { type: 'object' } },`,
      '    ],',
      '  };',
      `  if (request.method === 'tools/call') {`,
      `    if (request.params.name === 'slow') await new Promise((resolve) => setTimeout(resolve, 5000));`,
      `    return { content: [{ type: 'text', text: '${label}:' + request.params.name + ':' + (request.params.arguments?.message ?? '') }] };`,
      '  }',
      '  return {};',
      '};',
      'const transport = new StdioServerTransport();',
      'await server.connect(transport);',
      '',
    ].join('\n'),
  );
}

async function startHttpServer() {
  const state = { listTools: 0, callTool: 0, initialized: 0 };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    if (!body.trim()) {
      response.writeHead(200);
      response.end();
      return;
    }
    const message = JSON.parse(body);
    const reply = (result) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': 'platform-http',
      });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    };
    if (message.method === 'initialize') {
      state.initialized += 1;
      return reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'platform-http', version: '1.0.0' },
      });
    }
    if (message.method === 'notifications/initialized') {
      response.writeHead(202);
      response.end();
      return;
    }
    if (message.method === 'tools/list') {
      state.listTools += 1;
      return reply({
        tools: [
          {
            name: 'echo',
            description: 'echo',
            inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
          },
        ],
      });
    }
    if (message.method === 'tools/call') {
      state.callTool += 1;
      const messageValue = message.params?.arguments?.message ?? '';
      return reply({
        content: [{ type: 'text', text: `http:${message.params?.name}:${messageValue}` }],
      });
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    state,
    close() {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

const result = { ok: true, platform: process.platform, node: process.version };
const cleanups = [];
try {
  fs.mkdirSync(root, { recursive: true });
  const stdioPidFile = path.join(root, 'mcp-stdio.pid');
  const stdioScript = path.join(root, 'mcp-stdio-server.mjs');
  const flakyScript = path.join(root, 'mcp-flaky-server.mjs');
  const flakyPidFile = path.join(root, 'mcp-flaky.pid');
  writeStdioServer(stdioScript, stdioPidFile);
  writeStdioServer(flakyScript, flakyPidFile, { flaky: true, label: 'flaky' });
  const httpServer = await startHttpServer();
  cleanups.push(() => httpServer.close());

  const stdioConfig = {
    type: 'stdio',
    command: process.execPath,
    args: [stdioScript],
    cwd: root,
    startupTimeoutMs: 5_000,
    catalogTimeoutMs: 5_000,
  };
  const httpConfig = {
    type: 'http',
    url: httpServer.url,
    startupTimeoutMs: 5_000,
    catalogTimeoutMs: 5_000,
  };
  const authorizations = [];
  const manager = new mcp.McpServerManager({
    startupTimeoutMs: 5_000,
    catalogTimeoutMs: 5_000,
    overallDeadlineMs: 20_000,
    authorizer: async (descriptor) => {
      authorizations.push({ server: descriptor.serverName, type: descriptor.type });
      return 'allow_once';
    },
  });
  cleanups.push(async () => manager.teardown());
  manager.setToolRegistry(new core.ToolRegistry());
  const startup = await manager.startupAll({ stdio: stdioConfig, http: httpConfig });
  result.startupAuthorization = {
    authorizations,
    readyServers: startup.readyServers,
    failedServers: startup.failedServers,
  };
  const stdioPid = Number(
    await waitFor(
      () => (fs.existsSync(stdioPidFile) ? fs.readFileSync(stdioPidFile, 'utf8') : ''),
      'stdio server pid',
    ),
  );
  const stdioEcho = findTool(manager, 'stdio', 'echo');
  const httpEcho = findTool(manager, 'http', 'echo');
  result.tools = {
    stdio: { name: stdioEcho?.name, dangerous: stdioEcho?.metadata?.dangerous },
    http: { name: httpEcho?.name, dangerous: httpEcho?.metadata?.dangerous },
  };
  const stdioCall = await stdioEcho.execute({ message: 'hello' }, {});
  const httpCall = await httpEcho.execute({ message: 'hello' }, {});
  result.calls = { stdio: toolText(stdioCall), http: toolText(httpCall) };

  const slowTool = findTool(manager, 'stdio', 'slow');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const startedAt = Date.now();
  const cancelled = await slowTool.execute({}, { signal: controller.signal });
  result.cancel = {
    dispatchedError: cancelled?.__isMcpDispatchedError === true,
    elapsedMs: Date.now() - startedAt,
    stillReady: manager.getStatus('stdio')?.connectionState === 'ready',
  };

  await manager.disableServer('http');
  let revokedError = '';
  try {
    await httpEcho.execute({ message: 'after-revoke' }, {});
  } catch (error) {
    revokedError = error instanceof Error ? error.message : String(error);
  }
  result.revoke = {
    status: manager.getStatus('http'),
    error: revokedError,
  };
  await manager.enableServer('http');
  const restored = findTool(manager, 'http', 'echo');
  result.reenable = {
    status: manager.getStatus('http'),
    call: toolText(await restored.execute({ message: 'restored' }, {})),
  };

  const deniedManager = new mcp.McpServerManager({
    startupTimeoutMs: 5_000,
    catalogTimeoutMs: 5_000,
    overallDeadlineMs: 20_000,
    authorizer: async (descriptor) =>
      descriptor.serverName === 'stdio' ? 'deny_session' : 'allow_once',
  });
  cleanups.push(async () => deniedManager.teardown());
  deniedManager.setToolRegistry(new core.ToolRegistry());
  const denied = await deniedManager.startupAll({ stdio: stdioConfig, http: httpConfig });
  result.denied = {
    readyServers: denied.readyServers,
    failedServers: denied.failedServers,
  };

  const flakyManager = new mcp.McpServerManager({
    startupTimeoutMs: 5_000,
    catalogTimeoutMs: 5_000,
    overallDeadlineMs: 20_000,
    authorizer: async () => 'allow_once',
  });
  cleanups.push(async () => flakyManager.teardown());
  flakyManager.setToolRegistry(new core.ToolRegistry());
  const flakyConfig = {
    type: 'stdio',
    command: process.execPath,
    args: [flakyScript],
    cwd: root,
    startupTimeoutMs: 5_000,
    catalogTimeoutMs: 5_000,
  };
  const failed = await flakyManager.startupAll({ flaky: flakyConfig });
  await flakyManager.reconnectServer('flaky');
  const flakyStatus = await waitFor(
    () =>
      flakyManager.getStatus('flaky')?.connectionState === 'ready'
        ? flakyManager.getStatus('flaky')
        : undefined,
    'flaky reconnect',
  );
  const flakyTool = findTool(flakyManager, 'flaky', 'echo');
  result.retry = {
    firstFailedServers: failed.failedServers,
    status: flakyStatus,
    call: toolText(await flakyTool.execute({ message: 'retried' }, {})),
  };

  await manager.teardown();
  await deniedManager.teardown();
  await flakyManager.teardown();
  await waitFor(() => !processAlive(stdioPid), 'stdio server process exit', 10_000);
  // teardown 会关闭会话但保留已关闭的句柄引用，资源释放以「不再 ready + 进程退出」为据。
  const closedSession = manager.getServerSession('stdio');
  result.close = {
    stdioPid,
    stdioAlive: processAlive(stdioPid),
    managerTornDown: manager.isTornDown,
    sessionState: closedSession?.getStatus().connectionState ?? 'released',
    sessionReady: closedSession?.isReady() ?? false,
    httpCalls: httpServer.state,
  };
} catch (error) {
  result.ok = false;
  result.error = error instanceof Error ? error.message : String(error);
  result.stack = error instanceof Error ? error.stack : undefined;
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      /* 清理失败已体现在结果或由后续断言报告。 */
    }
  }
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
}
process.exit(0);
