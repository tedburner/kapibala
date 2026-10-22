import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startCompatHost } from './compat-host.mjs';
import { startCompatModelServer } from './compat-model.mjs';

/**
 * 旧/新客户端 × 旧/新宿主四组合共用的线协议脚本。
 * 客户端实现从被测安装目录动态导入，宿主以 stdio 子进程或 socket daemon 启动；
 * 模型服务只替代外部网络，工具、审批、取消与进程生命周期都走真实实现。
 */

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1 || index === args.length - 1) throw new Error(`Missing --${name}`);
  return args[index + 1];
};
const optionalOption = (name) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
  return value;
};

const clientEntry = path.resolve(option('client'));
const hostEntry = path.resolve(option('host'));
const root = path.resolve(option('root'));
const home = path.resolve(option('home'));
const resultPath = path.resolve(option('result'));
const transportKind = optionalOption('transport') ?? 'stdio';
const clientVersion = optionalOption('client-version') ?? 'candidate';
const runtimeDir = optionalOption('runtime-dir')
  ? path.resolve(optionalOption('runtime-dir'))
  : undefined;

const model = await startCompatModelServer();
fs.mkdirSync(path.join(home, '.kapibala'), { recursive: true });
fs.writeFileSync(
  path.join(home, '.kapibala/settings.json'),
  JSON.stringify({
    defaultModel: 'compat-fixture',
    profiles: [
      {
        id: 'compat-fixture',
        name: 'Compat Fixture',
        provider: 'openai-compatible',
        baseURL: model.baseURL,
        apiKey: 'fixture-compat-key',
        modelName: 'compat-fixture',
        contextWindow: 128000,
      },
    ],
    permissionMode: 'Approval',
  }),
);

const clientModule = await import(pathToFileURL(clientEntry).href);
let host;
let client;
let raw;
const events = [];
const approvals = [];

const failure = (error) =>
  JSON.stringify(
    {
      ok: false,
      transport: transportKind,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      stderr: host?.stderr ?? '',
    },
    null,
    2,
  );

try {
  host = await startCompatHost({
    hostEntry,
    root,
    home,
    transport: transportKind,
    runtimeDir,
    clientModule,
  });
  raw = await host.connect();
  const offer = {
    major: 1,
    minMinor: 0,
    maxMinor: 0,
    clientName: 'compat-matrix',
    capabilities: [],
  };
  if (raw.token) offer.token = raw.token;
  client = await clientModule.LocalClient.connect(raw.transport, offer, {
    approval: async (prompt) => {
      approvals.push({ toolName: prompt.toolName, target: prompt.target });
      return 'allow_once';
    },
  });
  client.subscribe((event) =>
    events.push({ type: event.type, runId: event.runId, payload: event.payload }),
  );

  const waitFor = async (predicate, label, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out: ${label}`);
  };
  const waitSettled = (runId, ms = 10_000) =>
    waitFor(
      () =>
        events.find((event) => event.type === 'run_settled' && (!runId || event.runId === runId)),
      `run_settled ${runId ?? ''}`,
      ms,
    );

  // 参数形状合法但工作区不是绝对路径，确保新旧客户端均实测宿主的可关联错误响应。
  let invalidParams = 'accepted';
  try {
    await client.call('session/create', { workspaceRoot: 'relative-workspace' });
  } catch (error) {
    invalidParams = error instanceof Error ? error.message : String(error);
  }
  const pingAfterInvalid = await client.call('ping', {});

  const listed = await client.call('session/list', { workspaceRoot: root });
  const created = await client.call('session/create', { workspaceRoot: root });
  const attached = await client.call('session/attach', {
    sessionId: created.sessionId,
    mode: 'control',
  });
  const control = {
    sessionId: created.sessionId,
    streamEpoch: attached.streamEpoch,
    controlEpoch: attached.controlEpoch,
  };

  const startRun = async (clientOperationId, input) => {
    const started = await client.call('run/start', {
      ...control,
      clientOperationId,
      input,
    });
    const settled = await waitSettled(started.runId);
    return { started, settled };
  };

  const toolRun = await startRun('compat-tool', 'write the compat proof');
  const replay = await client.call('run/start', {
    ...control,
    clientOperationId: 'compat-tool',
    input: 'write the compat proof',
  });
  const eventsAfterReplay = events.length;
  await new Promise((resolve) => setTimeout(resolve, 250));
  const dedupeNewEvents = events.length - eventsAfterReplay;

  const approvalRun = await startRun('compat-approval', 'compat-approval write the guarded file');
  const cancelStarted = await client.call('run/start', {
    ...control,
    clientOperationId: 'compat-cancel',
    input: 'compat-cancel',
  });
  await waitFor(
    () =>
      events.find(
        (event) =>
          event.type === 'text_delta' &&
          event.runId === cancelStarted.runId &&
          event.payload?.text === 'partial',
      ),
    'cancel partial text',
  );
  await client.call('run/cancel', { ...control, runId: cancelStarted.runId });
  const cancelSettled = await waitSettled(cancelStarted.runId);

  const snapshot = await client.call('session/snapshot', { sessionId: created.sessionId });
  await client.call('session/close', control);

  const opened = await client.call('session/open', {
    workspaceRoot: root,
    conversationId: created.conversationId,
  });
  const reopened = await client.call('session/attach', {
    sessionId: opened.sessionId,
    mode: 'control',
  });
  const reopenedSnapshot = await client.call('session/snapshot', { sessionId: opened.sessionId });
  await client.call('session/close', {
    sessionId: opened.sessionId,
    streamEpoch: reopened.streamEpoch,
    controlEpoch: reopened.controlEpoch,
  });
  const listAfter = await client.call('session/list', { workspaceRoot: root });

  await client.call('host/shutdown', {});
  await client.close();
  const hostExit = raw.exit
    ? await Promise.race([
        raw.exit,
        new Promise((resolve) => setTimeout(() => resolve(null), 3_000)),
      ])
    : null;
  const cleaned = await host.shutdown();

  const historyClosed = (history) =>
    history.every((message, index) => {
      if (
        message.role !== 'assistant' ||
        !message.blocks.some((block) => block.kind === 'tool_use')
      )
        return true;
      const next = history[index + 1];
      return Boolean(
        next?.role === 'tool' && next.blocks.some((block) => block.kind === 'tool_result'),
      );
    });

  const result = {
    ok: true,
    transport: transportKind,
    clientVersion,
    negative: {
      invalidParams,
      pingAfterInvalid: pingAfterInvalid?.alive === true,
    },
    list: {
      before: listed.items.length,
      after: listAfter.items.length,
      cursor: listed.cursor,
    },
    tool: {
      runId: toolRun.started.runId,
      outcome: toolRun.settled.payload.outcome,
      file: fs.readFileSync(path.join(root, 'compat/proof.txt'), 'utf8'),
    },
    dedupe: {
      sameRunId: replay.runId === toolRun.started.runId,
      newEvents: dedupeNewEvents,
    },
    approval: {
      outcome: approvalRun.settled.payload.outcome,
      prompts: approvals,
      file: fs.readFileSync(path.join(root, 'compat/approved.txt'), 'utf8'),
    },
    cancel: { outcome: cancelSettled.payload.outcome },
    history: snapshot.history.map((message) => message.role),
    historyClosed: historyClosed(snapshot.history),
    reopened: {
      messages: reopenedSnapshot.history.length,
      historyClosed: historyClosed(reopenedSnapshot.history),
    },
    events: {
      toolFinishes: events.filter((event) => event.type === 'tool_finish').length,
      texts: events
        .filter((event) => event.type === 'text_delta')
        .map((event) => event.payload.text),
    },
    sessionClosed: true,
    hostExit: hostExit ?? (cleaned.daemonStopped ? { code: 0, signal: null } : null),
    daemonStopped: cleaned.daemonStopped,
    stderr: cleaned.stderr,
  };
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  model.close();
  process.exit(0);
} catch (error) {
  try {
    await Promise.race([
      client?.close() ?? Promise.resolve(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timed out: client close')), 2_000),
      ),
    ]);
  } catch {
    // 连接已失效时 close 会再次抛错，失败结果已足以诊察。
  }
  await host?.shutdown().catch(() => undefined);
  fs.writeFileSync(resultPath, failure(error));
  model.close();
  process.exit(1);
}
