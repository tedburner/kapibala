import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startCompatHost } from './compat-host.mjs';
import { startCompatModelServer } from './compat-model.mjs';

/**
 * 版本相关的显式 cursor 与未知能力探针。
 * 新客户端只把显式 cursor 当续块；v0.0.9 客户端仍把它当首块重组，
 * 因此前者在错误后保持连接，后者按已知缺陷关闭连接。两者的预期分开记录。
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

/** 记录无 cursor 快照首块的游标，供后续显式 cursor 调用；不改变任何消息内容。 */
function captureTransport(transport) {
  const pending = new Map();
  const captured = { firstPageCursor: null, firstPageBytes: 0 };
  const messages = (async function* () {
    for await (const message of transport.messages) {
      try {
        const payload = typeof message === 'string' ? JSON.parse(message) : message;
        const request = pending.get(payload.id);
        if (
          request &&
          !request.cursor &&
          payload.result &&
          typeof payload.result.chunk === 'string'
        ) {
          pending.delete(payload.id);
          captured.firstPageCursor = payload.result.cursor;
          captured.firstPageBytes = Buffer.byteLength(payload.result.chunk);
        }
      } catch {
        // 非 JSON 或非响应消息原样交给客户端判断。
      }
      yield message;
    }
  })();
  return {
    messages,
    captured,
    send(message) {
      try {
        const payload = typeof message === 'string' ? JSON.parse(message) : message;
        if (payload.method && payload.id !== undefined)
          pending.set(payload.id, { cursor: payload.params?.cursor !== undefined });
      } catch {
        // 发送前无法解析的消息由传输层处理。
      }
      return transport.send(message);
    },
    setLimits: (limits) => transport.setLimits(limits),
    close: () => transport.close(),
  };
}

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
const events = [];

try {
  host = await startCompatHost({
    hostEntry,
    root,
    home,
    transport: transportKind,
    runtimeDir,
    clientModule,
  });

  let unsupportedCapability;
  const bad = await host.connect();
  try {
    const rejected = await clientModule.LocalClient.connect(bad.transport, {
      major: 1,
      minMinor: 0,
      maxMinor: 0,
      clientName: 'compat-cursor',
      capabilities: ['compat-unsupported'],
      ...(bad.token ? { token: bad.token } : {}),
    });
    await rejected.close();
    unsupportedCapability = 'accepted';
  } catch (error) {
    unsupportedCapability = error instanceof Error ? error.message : String(error);
  }

  const raw = await host.connect();
  const transport = captureTransport(raw.transport);
  const offer = {
    major: 1,
    minMinor: 0,
    maxMinor: 0,
    clientName: 'compat-cursor',
    capabilities: [],
  };
  if (raw.token) offer.token = raw.token;
  client = await clientModule.LocalClient.connect(transport, offer, {
    approval: async () => 'allow_once',
  });
  client.subscribe((event) => events.push(event));

  const waitFor = async (predicate, label, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out: ${label}`);
  };

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
  const started = await client.call('run/start', {
    ...control,
    clientOperationId: 'compat-long',
    input: 'compat-long',
  });
  const settled = await waitFor(
    () => events.find((event) => event.type === 'run_settled' && event.runId === started.runId),
    'long run settled',
  );
  const longHistory = await client.call('session/snapshot', { sessionId: created.sessionId });
  const textLength = longHistory.history
    .flatMap((message) => message.blocks)
    .filter((block) => block.kind === 'text')
    .reduce((sum, block) => sum + block.text.length, 0);
  if (typeof transport.captured.firstPageCursor !== 'string')
    throw new Error('Expected a multi-page snapshot cursor');
  const cursor = transport.captured.firstPageCursor;

  let explicitCursor;
  if (clientVersion === 'old') {
    let rejected;
    try {
      const page = await client.call('session/snapshot', { sessionId: created.sessionId, cursor });
      rejected = { rejected: false, page: typeof page?.chunk === 'string' };
    } catch (error) {
      rejected = { rejected: true, error: error instanceof Error ? error.message : String(error) };
    }
    let aliveAfter = true;
    try {
      await client.call('ping', {});
    } catch {
      aliveAfter = false;
    }
    explicitCursor = { ...rejected, aliveAfter };
  } else {
    const page = await client.call('session/snapshot', { sessionId: created.sessionId, cursor });
    const alive = await client.call('ping', {});
    explicitCursor = {
      rejected: false,
      chunk: typeof page.chunk === 'string' && page.chunk.length > 0,
      hasHistory: Object.hasOwn(page, 'history'),
      cursor: typeof page.cursor === 'string' || page.cursor === null,
      aliveAfter: alive.alive === true,
    };
  }

  if (clientVersion === 'candidate') {
    await client.call('session/close', control);
    await client.call('host/shutdown', {});
  }
  try {
    await client.close();
  } catch {
    // 旧客户端显式 cursor 失败时连接已关闭，close 再次抛出属于预期缺陷路径。
  }
  const hostExit = raw.exit
    ? await Promise.race([
        raw.exit,
        new Promise((resolve) => setTimeout(() => resolve(null), 3_000)),
      ])
    : null;
  const cleaned = await host.shutdown();

  const result = {
    ok: true,
    transport: transportKind,
    clientVersion,
    unsupportedCapability,
    longRun: { outcome: settled.payload.outcome, textLength },
    snapshot: {
      messages: longHistory.history.length,
      historyClosed: longHistory.history.every((message, index) => {
        if (
          message.role !== 'assistant' ||
          !message.blocks.some((block) => block.kind === 'tool_use')
        )
          return true;
        const next = longHistory.history[index + 1];
        return Boolean(
          next?.role === 'tool' && next.blocks.some((block) => block.kind === 'tool_result'),
        );
      }),
      firstPageBytes: transport.captured.firstPageBytes,
      firstPageCursor: typeof transport.captured.firstPageCursor === 'string',
    },
    explicitCursor,
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
    // 失败路径尽最大努力释放连接。
  }
  await host?.shutdown().catch(() => undefined);
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      {
        ok: false,
        transport: transportKind,
        clientVersion,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        stderr: host?.stderr ?? '',
      },
      null,
      2,
    ),
  );
  model.close();
  process.exit(1);
}
