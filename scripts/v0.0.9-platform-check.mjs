import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(
  path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'kpbl-v009-'),
);
const home = path.join(root, 'home');
const runtime = path.join(root, 'run');
const workspace = path.join(root, 'workspace');
fs.mkdirSync(path.join(home, '.kapibala'), { recursive: true });
fs.mkdirSync(workspace);
let calls = 0;
const model = http.createServer(async (request, response) => {
  for await (const _ of request) {
    /* 消费请求，不输出历史或凭证。 */
  }
  calls++;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(
    `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'local-smoke-ok' }, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\n`,
  );
  response.end('data: [DONE]\n\n');
});
await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
const port = model.address().port;
fs.writeFileSync(
  path.join(home, '.kapibala/settings.json'),
  JSON.stringify({
    defaultModel: 'fixture',
    permissionMode: 'Plan',
    profiles: [
      {
        id: 'fixture',
        name: 'fixture',
        provider: 'openai-compatible',
        baseURL: `http://127.0.0.1:${port}/v1`,
        modelName: 'fixture',
        apiKey: 'fixture-credential',
        contextWindow: 32000,
      },
    ],
  }),
);
const cli = path.join(repositoryRoot, 'packages/cli/dist/bin.js');
const command = (...args) =>
  run(process.execPath, [cli, ...args], {
    cwd: workspace,
    env: { ...process.env, KPBL_LOCAL_HOME: home },
    timeout: 20000,
  });
let started = false;
try {
  const first = JSON.parse((await command('daemon', 'start', '--runtime-dir', runtime)).stdout);
  started = true;
  assert.equal(first.running, true);
  const second = JSON.parse((await command('daemon', 'start', '--runtime-dir', runtime)).stdout);
  assert.equal(first.serverInstanceId, second.serverInstanceId);
  const result = await command(
    'connect',
    '--runtime-dir',
    runtime,
    '--workspace',
    workspace,
    '-p',
    'local deterministic smoke',
  );
  assert.match(result.stdout, /local-smoke-ok/);
  assert.equal(calls, 1);
  await command('daemon', 'stop', '--runtime-dir', runtime);
  started = false;
  for (let i = 0; i < 50 && fs.existsSync(path.join(runtime, 'daemon.lock')); i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(path.join(runtime, 'daemon.lock')), false);
  assert.equal(
    JSON.parse((await command('daemon', 'status', '--runtime-dir', runtime)).stdout).running,
    false,
  );
  const { DEFAULT_LIMITS } = await import('../packages/cli/dist/protocol/index.js');
  const { LocalClient, createStdioTransport } = await import(
    '../packages/cli/dist/client/index.js'
  );
  const stdioChild = spawn(process.execPath, [cli, 'serve', '--stdio'], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const exited = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      stdioChild.kill('SIGTERM');
      reject(new Error('stdio shutdown timeout'));
    }, 10000);
    stdioChild.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    stdioChild.once('exit', (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(new Error('stdio host failed'));
    });
  });
  const stdioClient = await LocalClient.connect(
    createStdioTransport(stdioChild.stdout, stdioChild.stdin),
    { major: 1, minMinor: 0, maxMinor: 0, clientName: 'stdio-smoke', capabilities: [] },
  );
  assert.equal((await stdioClient.call('ping', {})).alive, true);
  await stdioClient.close();
  stdioChild.stdin.end();
  await exited;
  assert.equal(DEFAULT_LIMITS.maxFrameBytes, 1048576);
  assert.equal(typeof LocalClient.connect, 'function');
  console.log(
    JSON.stringify({
      platform: process.platform,
      node: process.version,
      daemon: 'passed',
      connectedRun: 'passed',
      repeatedStart: 'passed',
      shutdown: 'passed',
      stdio: 'passed',
      model: 'local deterministic fixture',
    }),
  );
} finally {
  if (started) await command('daemon', 'stop', '--runtime-dir', runtime).catch(() => {});
  await new Promise((resolve) => model.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
