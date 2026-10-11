import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// 真实 TTY 验收服务：所有模型回应为本机 fixture；输入、审批和密钥仅作用于临时工作区。
const root = path.resolve(process.argv[2] ?? '.');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-v005-terminal-'));
const taskHome = path.join(directory, 'home');
const project = path.join(directory, 'project');
const cli = path.join(directory, 'cli');
const core = path.join(cli, 'node_modules/@kiturone/kapibala');
for (const dir of [taskHome, project, core]) fs.mkdirSync(dir, { recursive: true });
fs.cpSync(path.join(root, 'packages/cli/dist'), cli, { recursive: true });
fs.cpSync(path.join(root, 'packages/core/dist'), core, { recursive: true });
fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ type: 'module' }));
fs.writeFileSync(
  path.join(core, 'package.json'),
  JSON.stringify({ type: 'module', exports: './index.js' }),
);
const pnpmStore = path.join(root, 'node_modules/.pnpm');
const minimist = fs.readdirSync(pnpmStore).find((name) => name.startsWith('minimist@'));
assert.ok(minimist);
fs.cpSync(
  path.join(pnpmStore, minimist, 'node_modules/minimist'),
  path.join(cli, 'node_modules/minimist'),
  { recursive: true },
);
const guide = path.join(taskHome, '.agents/skills/guide');
fs.mkdirSync(path.join(guide, 'references'), { recursive: true });
fs.writeFileSync(
  path.join(guide, 'SKILL.md'),
  '---\nname: guide\ndescription: terminal test\nallowed-tools: [Write]\n---\nRead the reference and create proof.txt only when approved.',
);
fs.writeFileSync(path.join(guide, 'references/guide.md'), 'TTY_RESOURCE_SAFE');
let requests = 0;
const timers = new Set();
const server = http.createServer(async (request, response) => {
  let input = '';
  for await (const chunk of request) input += chunk;
  JSON.parse(input);
  const index = requests++;
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const emit = (delta, finish_reason = null) =>
    response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`);
  if (index === 1) {
    emit(
      {
        tool_calls: [
          {
            index: 0,
            id: 'resource',
            type: 'function',
            function: {
              name: 'read_skill_resource',
              arguments: '{"name":"guide","path":"references/guide.md"}',
            },
          },
        ],
      },
      'tool_calls',
    );
    response.end('data: [DONE]\n\n');
    return;
  }
  if (index === 2) {
    emit(
      {
        tool_calls: [
          {
            index: 0,
            id: 'write',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: '{"path":"proof.txt","content":"TTY_WRITE_SAFE"}',
            },
          },
        ],
      },
      'tool_calls',
    );
    response.end('data: [DONE]\n\n');
    return;
  }
  if (index === 3) {
    emit({ content: 'TTY_TASK_DONE' }, 'stop');
    response.end('data: [DONE]\n\n');
    return;
  }
  let count = 0;
  const timer = setInterval(() => {
    emit({ reasoning_content: `TTY_THOUGHT_${count++}\n` });
    if (count === 40) {
      emit({ content: 'TTY_INTERMEDIATE_ANSWER\n' }, 'stop');
      response.end('data: [DONE]\n\n');
      clearInterval(timer);
      timers.delete(timer);
    }
  }, 100);
  timers.add(timer);
  response.on('close', () => {
    clearInterval(timer);
    timers.delete(timer);
  });
  if (index === 0) {
    clearInterval(timer);
    timers.delete(timer);
    let ticks = 0;
    const loading = setInterval(() => {
      emit({ reasoning_content: `TTY_THOUGHT_${ticks++}\n` });
      if (ticks === 40) {
        emit(
          {
            content: 'TTY_INTERMEDIATE_ANSWER\n',
            tool_calls: [
              {
                index: 0,
                id: 'repeat',
                type: 'function',
                function: { name: 'load_skill', arguments: '{"name":"guide"}' },
              },
            ],
          },
          'tool_calls',
        );
        response.end('data: [DONE]\n\n');
        clearInterval(loading);
        timers.delete(loading);
      }
    }, 100);
    timers.add(loading);
    response.on('close', () => {
      clearInterval(loading);
      timers.delete(loading);
    });
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
fs.mkdirSync(path.join(taskHome, '.kapibala'));
fs.writeFileSync(
  path.join(taskHome, '.kapibala/settings.json'),
  JSON.stringify({
    builtinCatalogVersion: 4,
    defaultModel: 'terminal',
    profiles: [
      {
        id: 'terminal',
        name: 'terminal',
        modelName: 'terminal',
        provider: 'openai-compatible',
        baseURL: `http://127.0.0.1:${server.address().port}/v1`,
        apiKeyEnv: 'TTY_FIXTURE_KEY_UNSET',
        apiKey: 'fixture-key',
        supportsThinking: true,
        contextWindow: '32K',
      },
    ],
  }),
);
console.log('TTY_FIXTURE_READY');
const child = spawn(process.execPath, [path.join(cli, 'bin.js'), '--disable-shell'], {
  cwd: project,
  windowsHide: true,
  stdio: 'inherit',
  env: { ...process.env, HOME: taskHome, USERPROFILE: taskHome },
});
const ignoreInterrupt = () => {};
process.on('SIGINT', ignoreInterrupt);
let completed = false;
try {
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  const proofExists = fs.existsSync(path.join(project, 'proof.txt'));
  console.log(
    JSON.stringify({
      platform: process.platform,
      node: process.version,
      code,
      requests,
      approvedFile:
        proofExists &&
        fs.readFileSync(path.join(project, 'proof.txt'), 'utf8') === 'TTY_WRITE_SAFE',
    }),
  );
  completed = true;
} finally {
  if (!completed) child.kill();
  process.off('SIGINT', ignoreInterrupt);
  for (const timer of timers) clearInterval(timer);
  await new Promise((resolve) => server.close(resolve));
  assert.ok(directory.startsWith(path.join(os.tmpdir(), 'kpbl-v005-terminal-')));
  fs.rmSync(directory, { recursive: true, force: true });
}
