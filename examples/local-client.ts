/**
 * 本地客户端示例：以 stdio 拉起 `kpbl serve --stdio` 宿主，用 `LocalClient` 走协议 1.0 完成一次问答。
 *
 * 约束：宿主入口必须是已构建产物（`pnpm dev:build` 后的 `packages/cli/dist/bin.js`）。
 * 工作区根用绝对路径显式传入；`run/start` 必须携带 attach 返回的双代际（`streamEpoch` +
 * `controlEpoch`），只有控制连接能写。缺号或 attach 失败会让**整个连接**失效，本示例不做
 * 自动重连或重发写任务；审批回调缺省取消。进程退出前显式 `session/close` 与 `host/shutdown`，
 * 否则会留下会话存储锁。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { LocalClient, createStdioTransport } from '@kiturone/kapibala-cli/client';
import type { WireEvent } from '@kiturone/kapibala-cli/protocol';

const hostEntry = process.env.KPBL_HOST_ENTRY
  ? path.resolve(process.env.KPBL_HOST_ENTRY)
  : path.resolve('packages/cli/dist/bin.js');
const workspaceRoot = path.resolve(process.argv[2] ?? process.cwd());
const prompt = process.argv[3] ?? '用三句话说明这个项目的结构';

const child = spawn(process.execPath, [hostEntry, 'serve', '--stdio'], {
  cwd: workspaceRoot,
  stdio: ['pipe', 'pipe', 'inherit'],
});
const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
  child.once('exit', (code, signal) => resolve({ code, signal }));
});

const client = await LocalClient.connect(
  createStdioTransport(child.stdout!, child.stdin!),
  {
    major: 1,
    minMinor: 0,
    maxMinor: 0,
    clientName: 'kapibala-example',
    // 只声明本次真正依赖的能力；任一项宿主不支持即 PROTOCOL_MISMATCH，不静默降级。
    capabilities: ['sessions', 'approval', 'cancel'],
  },
  {
    // 缺省取消：示例不自动放行任何写操作。
    approval: async () => 'cancel',
  },
);

const unsubscribe = client.subscribe((event: WireEvent) => {
  if (event.type === 'text_delta') process.stdout.write(event.payload.text);
  if (event.type === 'tool_start') console.log(`\n[tool] ${event.payload.toolName}`);
});

const created = await client.call('session/create', { workspaceRoot });
const control = await client.call('session/attach', {
  sessionId: created.sessionId,
  mode: 'control',
});
console.log(
  `attached ${control.sessionId} (open sessions ${control.openSessions}/${control.maxOpenSessions})`,
);

// run_settled 只表示服务端收口；断线时该 Promise 不会被拒绝，调用方需自行设超时。
const settled = new Promise<string>((resolve) => {
  const stop = client.subscribe((event) => {
    if (event.sessionId !== control.sessionId || event.type !== 'run_settled') return;
    stop();
    resolve(event.payload.outcome);
  });
});

const run = await client.call('run/start', {
  sessionId: control.sessionId,
  streamEpoch: control.streamEpoch,
  controlEpoch: control.controlEpoch,
  clientOperationId: crypto.randomUUID(),
  input: prompt,
});
console.log(`\nrun accepted: ${run.runId}`);
console.log(`run settled: ${await settled}`);

// 一次性问答必须回收会话，否则连续调用会耗尽每连接的打开会话配额。
await client.call('session/close', {
  sessionId: control.sessionId,
  streamEpoch: control.streamEpoch,
  controlEpoch: control.controlEpoch,
});
await client.call('host/shutdown', {});
unsubscribe();
console.log(`host exited: ${JSON.stringify(await exit)}`);
