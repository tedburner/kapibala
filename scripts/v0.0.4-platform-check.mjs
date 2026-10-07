import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// 使用本次构建产物和复制的 minimist，在 Windows/WSL 均运行真正的 CLI 子进程。
const root = path.resolve(process.argv[2] ?? '.');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-v004-platform-'));
const home = path.join(directory, 'home');
const project = path.join(directory, 'project');
const cli = path.join(directory, 'cli');
const core = path.join(cli, 'node_modules', '@kiturone', 'kapibala');
const calls = [];
const counts = new Map();
const wire = (events) =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const server = http.createServer(async (request, response) => {
  let text = '';
  for await (const chunk of request) text += chunk;
  const body = JSON.parse(text);
  calls.push({ path: request.url, body });
  const count = counts.get(body.model) ?? 0;
  counts.set(body.model, count + 1);
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (request.url.endsWith('/messages')) {
    const block =
      count === 0
        ? { type: 'tool_use', id: 'anth_call', name: 'glob', input: { pattern: '*.txt' } }
        : { type: 'text', text: 'plan completed' };
    const blocks =
      count === 0
        ? [{ type: 'thinking', thinking: 'read files', signature: 'PRIVATE_SIGNATURE' }, block]
        : [block];
    response.end(
      wire([
        {
          type: 'message_start',
          message: {
            id: 'msg',
            type: 'message',
            role: 'assistant',
            content: [],
            usage: { input_tokens: 10 },
          },
        },
        ...blocks.flatMap((content_block, index) => [
          { type: 'content_block_start', index, content_block },
          { type: 'content_block_stop', index },
        ]),
        {
          type: 'message_delta',
          delta: { stop_reason: count === 0 ? 'tool_use' : 'end_turn' },
          usage: { output_tokens: 2 },
        },
        { type: 'message_stop' },
      ]),
    );
  } else if (request.url.endsWith('/responses')) {
    const output =
      count === 0
        ? [
            {
              type: 'reasoning',
              id: 'r',
              encrypted_content: 'PRIVATE_CIPHER',
              status: 'completed',
              summary: [],
            },
            {
              type: 'function_call',
              id: 'fc',
              call_id: 'resp_call',
              name: 'glob',
              arguments: '{"pattern":"*.txt"}',
              status: 'completed',
            },
          ]
        : [
            {
              type: 'message',
              id: 'm',
              role: 'assistant',
              status: 'completed',
              phase: 'final_answer',
              content: [{ type: 'output_text', text: 'execution completed', annotations: [] }],
            },
          ];
    response.end(
      wire([
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output,
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          },
        },
      ]),
    );
  } else
    response.end(
      'data: {"choices":[{"delta":{"content":"default completed"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
});

async function run(args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(cli, 'bin.js'), ...args], {
      cwd: project,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TEMP: os.tmpdir(),
        TMP: os.tmpdir(),
        HOME: home,
        USERPROFILE: home,
        LANG: 'C.UTF-8',
        NO_COLOR: '1',
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('CLI process timed out'));
    }, 15000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}
try {
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(core, { recursive: true });
  fs.cpSync(path.join(root, 'packages/cli/dist'), cli, { recursive: true });
  fs.cpSync(path.join(root, 'packages/core/dist'), core, { recursive: true });
  fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(
    path.join(core, 'package.json'),
    JSON.stringify({ type: 'module', exports: './index.js' }),
  );
  const store = path.join(root, 'node_modules/.pnpm');
  const minimist = fs.readdirSync(store).find((name) => /^minimist@/.test(name));
  assert.ok(minimist, 'installed minimist required');
  fs.cpSync(
    path.join(store, minimist, 'node_modules/minimist'),
    path.join(cli, 'node_modules/minimist'),
    { recursive: true },
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  fs.mkdirSync(path.join(home, '.kapibala'));
  fs.writeFileSync(
    path.join(home, '.kapibala/settings.json'),
    JSON.stringify({
      builtinCatalogVersion: 4,
      defaultModel: 'chat',
      modelRouting: { planning: 'claude', execution: 'openai' },
      profiles: [
        {
          id: 'chat',
          name: 'Chat',
          modelName: 'chat',
          provider: 'openai-compatible',
          apiKeyEnv: 'NONE',
          apiKey: 'fixture-key',
          baseURL: endpoint,
          contextWindow: '1M',
        },
        {
          id: 'claude',
          name: 'Claude',
          modelName: 'claude',
          provider: 'anthropic',
          apiKeyEnv: 'NONE',
          baseURL: endpoint,
          contextWindow: '1M',
          maxOutputTokens: 16384,
        },
        {
          id: 'openai',
          name: 'OpenAI',
          modelName: 'openai',
          provider: 'openai-responses',
          apiKeyEnv: 'NONE',
          baseURL: endpoint,
          contextWindow: '1M',
          maxOutputTokens: 32768,
          supportsThinking: true,
        },
      ],
    }),
  );
  fs.writeFileSync(path.join(project, 'readme.txt'), 'local fixture');
  assert.match((await run(['--version'])).output, /0\.0\.3/);
  assert.match((await run(['--help'])).output, /--role/);
  assert.equal((await run(['--role', 'summary', '--disable-shell', '-p', 'invalid'])).code, 1);
  assert.equal((await run(['--role', 'fast', '--disable-shell', '-p', 'unbound'])).code, 1);
  assert.equal(calls.length, 0);
  const plan = await run([
    '--role',
    'planning',
    '--mode',
    'plan',
    '--disable-shell',
    '-p',
    'read local files',
  ]);
  assert.equal(plan.code, 0, plan.output);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.max_tokens, 16384);
  assert.match(JSON.stringify(calls[1].body), /PRIVATE_SIGNATURE/);
  const continued = await run(['--continue', '--disable-shell', '-p', 'continue ordinary task']);
  assert.equal(continued.code, 0, continued.output);
  assert.equal(calls[2].body.model, 'chat');
  assert.doesNotMatch(JSON.stringify(calls[2].body), /PRIVATE_SIGNATURE/);
  const execution = await run([
    '--role',
    'execution',
    '--model',
    'chat',
    '--mode',
    'plan',
    '--disable-shell',
    '-p',
    'read local files',
  ]);
  assert.equal(execution.code, 0, execution.output);
  assert.equal(calls[3].body.model, 'openai');
  assert.equal(calls[3].body.max_output_tokens, 32768);
  assert.equal(calls[3].body.store, false);
  assert.match(JSON.stringify(calls[4].body), /PRIVATE_CIPHER/);
  assert.doesNotMatch(plan.output + execution.output, /PRIVATE_SIGNATURE|PRIVATE_CIPHER/);
  process.stdout.write(
    `${JSON.stringify({ platform: process.platform, node: process.version, checks: ['version-help', 'invalid-role-zero-http', 'missing-role-zero-http', 'anthropic-tool-continuation', 'restart-default-history', 'responses-tool-continuation', 'native-output-budgets', 'private-state-not-displayed'], passed: true })}\n`,
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  assert.ok(directory.startsWith(path.join(os.tmpdir(), 'kpbl-v004-platform-')));
  fs.rmSync(directory, { recursive: true, force: true });
}
