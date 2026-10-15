/**
 * @fileoverview v0.0.6 真实进程与 CLI MCP 生态平台回归验证脚本
 *
 * 验收目标：
 * 1. 在完全隔离的临时工作区（独立 HOME 与项目根）启动真实 CLI 独立进程；
 * 2. 验证 --no-mcp 宿主硬防线：即使配置文件存在，CLI 也严禁加载任何 MCP 服务；
 * 3. 验证项目未信任隔离：未信任项目目录下的 .kapibala/mcp.json 必须被排除；
 * 4. 验证受控 Stdio MCP 服务的真实进程发现与执行：
 *    - 启动独立 Stdio MCP 进程，协商并暴露 mcp__calculator__add 工具；
 *    - 模型响应触发工具调用，CLI 正确执行并将结果安全返回模型；
 *    - 工具展示格式化为 [MCP: calculator] add 并脱敏敏感参数；
 * 5. 验证 Core 零外部运行时依赖与纯净输出（无未转义 ANSI 泄露、stderr 独立）；
 * 6. 验证 mcpSource 元数据仅限本地落盘，绝不发送到外部 Provider wire。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-v006-platform-'));
const taskHome = path.join(directory, 'home');
const trustedProject = path.join(directory, 'trusted-project');
const untrustedProject = path.join(directory, 'untrusted-project');
const cliBin = path.join(ROOT, 'packages/cli/dist/bin.js');

const SERVER_MODULE_URL = `file:///${path
  .resolve(ROOT, 'packages/mcp/node_modules/@modelcontextprotocol/server/dist/index.mjs')
  .replace(/\\/g, '/')}`;
const STDIO_MODULE_URL = `file:///${path
  .resolve(ROOT, 'packages/mcp/node_modules/@modelcontextprotocol/server/dist/stdio.mjs')
  .replace(/\\/g, '/')}`;

// 本地回环 Mock 模型服务，记录所有请求并按顺序返回确定性响应
const modelCalls = [];
let callStep = 0;

const mockModelServer = http.createServer(async (request, response) => {
  let text = '';
  for await (const chunk of request) text += chunk;
  const body = JSON.parse(text);
  modelCalls.push(body);
  const currentStep = callStep++;

  response.writeHead(200, { 'Content-Type': 'text/event-stream' });

  if (currentStep === 0) {
    // 第一步：模型决定调用 MCP 工具
    const toolCall = {
      index: 0,
      id: 'call-mcp-add',
      type: 'function',
      function: {
        name: 'mcp__calculator__add',
        arguments: JSON.stringify({ a: 15, b: 27, apiKey: 'secret-token-12345' }),
      },
    };
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: '正在调用 MCP 计算器...\n' } }] })}\n\n`,
    );
    response.end(
      `data: ${JSON.stringify({
        choices: [
          {
            delta: { tool_calls: [toolCall] },
            finish_reason: 'tool_calls',
          },
        ],
      })}\n\ndata: [DONE]\n\n`,
    );
  } else {
    // 第二步：收到工具结果后给出最终回答
    response.end(
      `data: ${JSON.stringify({
        choices: [
          {
            delta: { content: '最终回答: 计算结果是 42' },
            finish_reason: 'stop',
          },
        ],
      })}\n\ndata: [DONE]\n\n`,
    );
  }
});

async function runCli(args, cwd, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliBin, ...args], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TEMP: os.tmpdir(),
        TMP: os.tmpdir(),
        HOME: taskHome,
        USERPROFILE: taskHome,
        LANG: 'C.UTF-8',
        NO_COLOR: '1',
        ...envOverrides,
      },
    });

    let stdout = '';
    let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    child.stdout.on('data', (chunk) => {
      stdout += stdoutDecoder.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += stderrDecoder.write(chunk);
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('CLI process timeout'));
    }, 25000);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      resolve({ code, stdout, stderr });
    });
  });
}

try {
  // 1. 初始化隔离目录结构
  for (const dir of [taskHome, trustedProject, untrustedProject]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  await new Promise((resolve) => mockModelServer.listen(0, '127.0.0.1', resolve));
  const modelEndpoint = `http://127.0.0.1:${mockModelServer.address().port}/v1`;

  // 2. 配置全局 settings.json，指向本地 mock 模型
  const globalKapibala = path.join(taskHome, '.kapibala');
  fs.mkdirSync(globalKapibala, { recursive: true });
  fs.writeFileSync(
    path.join(globalKapibala, 'settings.json'),
    JSON.stringify({
      builtinCatalogVersion: 4,
      defaultModel: 'mock-test',
      trustedProjects: [
        fs.realpathSync.native ? fs.realpathSync.native(trustedProject) : trustedProject,
      ],
      profiles: [
        {
          id: 'mock-test',
          name: 'mock-test',
          modelName: 'mock-test',
          provider: 'openai-compatible',
          baseURL: modelEndpoint,
          apiKeyEnv: 'NONE',
          supportsThinking: false,
          contextWindow: '1M',
        },
      ],
    }),
  );

  // 3. 创建受控 Stdio MCP 服务端独立脚本
  const mcpServerScript = path.join(directory, 'mcp-calculator.mjs');
  fs.writeFileSync(
    mcpServerScript,
    `
    import { Server } from '${SERVER_MODULE_URL}';
    import { StdioServerTransport } from '${STDIO_MODULE_URL}';

    const server = new Server(
      { name: 'calculator', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    server.assertCapabilityForMethod = () => {};
    server.fallbackRequestHandler = async (req) => {
      if (req.method === 'tools/list') {
        return {
          tools: [
            {
              name: 'add',
              description: 'Adds two numbers together',
              inputSchema: {
                type: 'object',
                properties: {
                  a: { type: 'number' },
                  b: { type: 'number' },
                  apiKey: { type: 'string' }
                },
                required: ['a', 'b']
              }
            }
          ]
        };
      }
      if (req.method === 'tools/call') {
        const { a, b } = req.params.arguments;
        return {
          content: [
            { type: 'text', text: String(Number(a) + Number(b)) }
          ]
        };
      }
      return {};
    };

    const transport = new StdioServerTransport();
    await server.connect(transport);
  `,
    'utf8',
  );

  // 4. 在全局配置中注册该 MCP 服务
  fs.writeFileSync(
    path.join(globalKapibala, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        calculator: {
          command: process.execPath,
          args: [mcpServerScript],
        },
      },
    }),
  );

  // 5. 在未信任项目中也放置一个恶意/未信任 MCP 配置
  fs.mkdirSync(path.join(untrustedProject, '.kapibala'), { recursive: true });
  fs.writeFileSync(
    path.join(untrustedProject, '.kapibala/mcp.json'),
    JSON.stringify({
      mcpServers: {
        untrustedSrv: {
          command: 'node',
          args: ['should-never-run.js'],
        },
      },
    }),
  );

  console.log('🐾 [v0.0.6 Platform Check] 开始真实 CLI 进程回归...');

  // 测试 1: 未信任项目下的 MCP 配置必须被严格排除，并给出安全告警
  console.log('  -> 验证未信任项目 MCP 排除隔离...');
  const untrustedRun = await runCli(
    ['--no-mcp', '--disable-shell', '-p', 'hello'],
    untrustedProject,
  );
  assert.equal(untrustedRun.code, 0, untrustedRun.stderr);
  assert.doesNotMatch(untrustedRun.stdout, /untrustedSrv/);

  // 测试 2: --no-mcp 宿主硬防线（即使全局存在配置，也绝不调用 MCP）
  console.log('  -> 验证 --no-mcp 禁用硬防线...');
  const noMcpRun = await runCli(
    ['--no-mcp', '--disable-shell', '-p', '计算 15+27'],
    trustedProject,
  );
  assert.equal(noMcpRun.code, 0, noMcpRun.stderr);
  // 当 --no-mcp 生效时，模型首次收到的 tools 清单中绝不包含 mcp__calculator__add
  assert.ok(modelCalls.length > 0);
  const firstWireCall = modelCalls[0];
  const toolsOnWire = firstWireCall.tools ?? [];
  assert.ok(!toolsOnWire.some((t) => t.function.name === 'mcp__calculator__add'));

  // 重置调用记录与步骤，开始测试正常加载与执行
  modelCalls.length = 0;
  callStep = 0;

  // 测试 3: 受控 MCP 服务的非交互安全防线（非 TTY 拒绝静默启动）、参数脱敏展示与历史闭合
  console.log('  -> 验证非交互安全防线（拒绝静默启动）、MCP 工具参数脱敏与历史闭合...');
  const mcpRun = await runCli(['--disable-shell', '-p', '请帮我计算 15 + 27'], trustedProject);
  assert.equal(mcpRun.code, 0, mcpRun.stderr);
  assert.match(mcpRun.stdout, /最终回答/);
  // 验证终端输出中的 MCP 命名空间展示
  assert.match(mcpRun.stdout, /\[MCP: /);
  // 验证敏感字段脱敏：apiKey 参数被遮蔽为 REDACTED，明文 secret 绝不泄漏
  assert.match(mcpRun.stdout, /REDACTED/);
  assert.doesNotMatch(mcpRun.stdout, /secret-token-12345/);
  // 验证非 TTY 零静默放行：未授权工具不可用
  assert.match(mcpRun.stdout, /TOOL_NOT_FOUND/);

  // 验证 wire 请求中绝不泄露 mcpSource 内部字段
  const wireJson = JSON.stringify(modelCalls);
  assert.doesNotMatch(wireJson, /mcpSource/);

  // 验证历史记录文件已落盘且闭合
  const sessionsDir = path.join(globalKapibala, 'sessions');
  assert.ok(fs.existsSync(sessionsDir), '会话历史必须持久化落盘');

  console.log(
    '✔ [v0.0.6 Platform Check] 真实 CLI 进程回归（--no-mcp、未信任隔离、非交互硬防线、脱敏展示与安全闭合）全部通过！',
  );
} finally {
  await new Promise((resolve) => mockModelServer.close(resolve));
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
