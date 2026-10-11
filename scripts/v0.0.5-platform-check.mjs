import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// 仅在临时工作区执行真实 CLI；本地 SSE 固定回放，不读取用户凭据、不调用外部模型。
const root = path.resolve(process.argv[2] ?? '.');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-v005-platform-'));
const taskHome = path.join(directory, 'home');
const project = path.join(directory, 'project');
const cli = path.join(directory, 'cli');
const core = path.join(cli, 'node_modules/@kiturone/kapibala');
const calls = [];
const counts = new Map();
const thinking = '公开过程说明\n'.repeat(80000);
const server = http.createServer(async (request, response) => {
  let text = '';
  for await (const chunk of request) text += chunk;
  const body = JSON.parse(text);
  calls.push(body);
  const count = counts.get(body.model) ?? 0;
  counts.set(body.model, count + 1);
  const tool =
    count === 0
      ? ['load_skill', { name: 'guide' }]
      : count === 1
        ? ['read_skill_resource', { name: 'guide', path: 'references/guide.md' }]
        : undefined;
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (count === 0)
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: thinking, content: '中途回答仍完整可见\n' } }] })}\n\n`,
    );
  response.end(
    `data: ${JSON.stringify({ choices: [{ delta: tool ? { tool_calls: [{ index: 0, id: `call-${count}`, type: 'function', function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] } : { content: '最终回答: 资源证据已读取' }, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
  );
});
async function run(args) {
  return new Promise((resolve, reject) => {
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
        HOME: taskHome,
        USERPROFILE: taskHome,
        LANG: 'C.UTF-8',
        NO_COLOR: '1',
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
    }, 20000);
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const guide = path.join(taskHome, '.agents/skills/guide');
  fs.mkdirSync(path.join(guide, 'references'), { recursive: true });
  fs.writeFileSync(
    path.join(guide, 'SKILL.md'),
    '---\nname: guide\ndescription: >-\n  中文多行示例，\n  只读参考资料。\nallowed-tools: []\n---\n读取 references/guide.md。',
  );
  fs.writeFileSync(path.join(guide, 'references/guide.md'), '资源证据: SAFE');
  // 项目没有 settings 且未信任，不能遮蔽全局同名技能或阻止非交互任务。
  fs.mkdirSync(path.join(project, '.agents/skills/guide'), { recursive: true });
  fs.writeFileSync(
    path.join(project, '.agents/skills/guide/SKILL.md'),
    '---\nname: guide\ndescription: local\n---\nUNTRUSTED_BODY',
  );
  fs.mkdirSync(path.join(taskHome, '.kapibala'));
  fs.writeFileSync(
    path.join(taskHome, '.kapibala/settings.json'),
    JSON.stringify({
      builtinCatalogVersion: 4,
      defaultModel: 'summary',
      profiles: ['summary', 'detailed'].map((id) => ({
        id,
        name: id,
        modelName: id,
        provider: 'openai-compatible',
        baseURL: endpoint,
        apiKeyEnv: 'NONE',
        supportsThinking: true,
        contextWindow: '1M',
      })),
    }),
  );
  const invalid = await run(['--output-detail', 'invalid', '--disable-shell', '-p', 'task']);
  assert.equal(invalid.code, 1);
  assert.equal(calls.length, 0);
  assert.match(invalid.stderr, /output-detail summary\|detailed/);
  assert.doesNotMatch(invalid.stderr, new RegExp(String.fromCharCode(27)));
  const summary = await run(['--disable-shell', '-p', '使用 guide 技能']);
  assert.equal(summary.code, 0, summary.stderr);
  assert.match(summary.stdout, /中途回答仍完整可见/);
  assert.match(summary.stdout, /最终回答/);
  assert.doesNotMatch(summary.stdout, /公开过程说明/);
  assert.match(summary.stdout, /技能已加载: guide/);
  const detailed = await run([
    '--model',
    'detailed',
    '--disable-shell',
    '--output-detail',
    'detailed',
    '--debug',
    '-p',
    '使用 guide 技能',
  ]);
  assert.equal(detailed.code, 0, detailed.stderr);
  assert.ok(
    detailed.stdout.includes(thinking),
    'complete >1MiB public process must survive redirection',
  );
  assert.match(detailed.stdout, /资源证据: SAFE/);
  assert.doesNotMatch(detailed.stdout, /缓存已截断/);
  assert.doesNotMatch(summary.stdout + detailed.stdout, new RegExp(String.fromCharCode(27)));
  assert.match(detailed.stderr, /LOG/);
  assert.doesNotMatch(detailed.stdout, /\[LOG /);
  const wire = JSON.stringify(calls);
  assert.doesNotMatch(wire, /UNTRUSTED_BODY|skillSource|run_command/);
  assert.ok(calls.every((body) => body.tools.some((tool) => tool.function.name === 'load_skill')));
  assert.ok(
    fs.existsSync(path.join(taskHome, '.kapibala/sessions')),
    'history remains in isolated home',
  );
  console.log(
    JSON.stringify({
      platform: process.platform,
      node: process.version,
      passed: true,
      checks: [
        'invalid-option-zero-http',
        'untrusted-project-global-fallback',
        'disable-shell-keeps-skills',
        'skill-resource-read',
        'summary-full-answers',
        'detailed-over-1MiB',
        'no-ANSI-stdout',
        'debug-independent-stderr',
        'provenance-local-only',
      ],
    }),
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  assert.ok(directory.startsWith(path.join(os.tmpdir(), 'kpbl-v005-platform-')));
  fs.rmSync(directory, { recursive: true, force: true });
}
