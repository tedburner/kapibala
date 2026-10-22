import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { AgentSession, SessionManager } from '@kiturone/kapibala';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type LocalModelServer,
  type LocalProtocol,
  startLocalModelServer,
} from '../../core/tests/helpers/local-model-server.js';
import { LocalClient } from '../src/client/index.js';
import { createResourceFactory } from '../src/local-host/resources.js';
import { LocalHostServer } from '../src/local-host/server.js';
import { CliModelBindings } from '../src/model-bindings.js';
import { runOneShot } from '../src/oneshot.js';
import type { WireEvent } from '../src/protocol/index.js';
import {
  type UserSettings,
  createUserSettingsSkeleton,
  loadSettings,
  saveGlobalSettings,
} from '../src/settings.js';
import { registerBuiltinTools } from '../src/tool-registration.js';
import { createStdioTransport } from '../src/transport/stdio.js';

const FIXTURE_KEY = 'fixture-model-key-0001';
const ENV_SENTINEL = 'env-credential-must-not-be-used';
const offer = { major: 1, minMinor: 0, maxMinor: 0, clientName: 'no-key', capabilities: [] };
const bases: string[] = [];
const servers: LocalModelServer[] = [];

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', ENV_SENTINEL);
  vi.stubEnv('ANTHROPIC_API_KEY', ENV_SENTINEL);
  vi.stubEnv('DEEPSEEK_API_KEY', ENV_SENTINEL);
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const base of bases.splice(0)) fs.rmSync(base, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function workspace(): { base: string; root: string; homeDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-no-key-host-'));
  bases.push(base);
  const root = path.join(base, 'workspace');
  const homeDir = path.join(base, 'home');
  fs.mkdirSync(root);
  fs.mkdirSync(homeDir);
  return { base, root, homeDir };
}

async function localServer(): Promise<LocalModelServer> {
  const server = await startLocalModelServer();
  servers.push(server);
  return server;
}

function configure(
  homeDir: string,
  server: LocalModelServer,
  protocol: LocalProtocol,
  modelName: string,
): UserSettings {
  const settings = createUserSettingsSkeleton();
  settings.defaultModel = 'local-fixture';
  settings.profiles = [
    {
      id: 'local-fixture',
      name: 'Local Fixture',
      provider:
        protocol === 'chat'
          ? 'openai-compatible'
          : protocol === 'anthropic'
            ? 'anthropic'
            : 'openai-responses',
      baseURL: server.baseURL,
      modelName,
      apiKey: FIXTURE_KEY,
      apiKeyEnv: 'FIXTURE_MODEL_KEY_UNUSED',
      contextWindow: 128_000,
    },
  ];
  saveGlobalSettings(settings, { homeDir });
  return settings;
}

function pair() {
  const a = new PassThrough();
  const b = new PassThrough();
  return [createStdioTransport(a, b), createStdioTransport(b, a)] as const;
}

function textOf(events: WireEvent[]): string {
  return events
    .filter(
      (event): event is Extract<WireEvent, { type: 'text_delta' }> => event.type === 'text_delta',
    )
    .map((event) => event.payload.text)
    .join('');
}

function assertNoEnvironmentCredential(server: LocalModelServer): void {
  for (const request of server.requests) {
    expect(JSON.stringify(request.headers)).not.toContain(ENV_SENTINEL);
    expect(JSON.stringify(request.body)).not.toContain(ENV_SENTINEL);
    if (request.protocol === 'anthropic') {
      expect(request.headers['x-api-key']).toBe(FIXTURE_KEY);
    }
    expect(request.headers.authorization).toContain(FIXTURE_KEY);
  }
}

describe('no-key CLI and local-host matrix', () => {
  it('runs a real one-shot tool transaction through CliModelBindings without environment keys', async () => {
    const { root, homeDir } = workspace();
    const server = await localServer();
    server.script(
      'chat',
      {
        kind: 'tools',
        calls: [
          {
            id: 'cli-call',
            name: 'write_file',
            input: { path: 'cli-proof.txt', content: 'cli proof' },
          },
        ],
      },
      { kind: 'text', text: 'cli finished' },
    );
    configure(homeDir, server, 'chat', 'fixture-chat');
    const loaded = loadSettings({ cwd: root, homeDir });
    const profile = loaded.settings.profiles.find(
      (candidate) => candidate.id === loaded.settings.defaultModel,
    )!;
    const models = new CliModelBindings(loaded.settings, profile);
    const manager = new SessionManager({ workspaceRoot: root, homeDirectory: homeDir });
    const handle = await manager.create();
    const session = new AgentSession({
      workspaceRoot: root,
      executionCwd: root,
      projectRoot: root,
      store: handle.store,
      conversationId: handle.conversationId,
      defaultProfile: models.defaultBinding.profile,
      defaultProvider: models.defaultBinding.provider,
      loggingDirectory: path.join(root, 'logs'),
      mode: 'FullAccess',
    });
    registerBuiltinTools(session.tools, { cwd: root, disableShell: true });
    models.attach(session);
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    let status = -1;
    let persisted: Awaited<ReturnType<typeof handle.store.load>> = [];
    try {
      status = await runOneShot({ session, prompt: 'write through one shot' });
      persisted = await handle.store.load();
    } finally {
      write.mockRestore();
      await handle.release();
    }

    expect(status).toBe(0);
    expect(fs.readFileSync(path.join(root, 'cli-proof.txt'), 'utf8')).toBe('cli proof');
    expect(output.join('')).toContain('cli finished');
    expect(persisted.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(
      persisted
        .flatMap((message) => message.content)
        .filter((block) => block.type === 'tool_result'),
    ).toEqual([expect.objectContaining({ toolUseId: 'cli-call', isError: false })]);
    expect(server.requests).toHaveLength(2);
    expect(server.pending()).toBe(0);
    assertNoEnvironmentCredential(server);
    server.assertConsumed();
  }, 20_000);

  it('serves a redacted snapshot, deduplicates operation IDs, and consumes every scripted turn', async () => {
    const { root, homeDir } = workspace();
    const server = await localServer();
    server.script(
      'responses',
      {
        kind: 'tools',
        calls: [
          {
            id: 'host-call',
            name: 'write_file',
            input: { path: 'host-proof.txt', content: 'host proof' },
          },
        ],
      },
      {
        kind: 'text',
        text: 'before fixture-model-key-0001 after',
        chunks: ['before ', 'fixture-model-', 'key-0001', ' after'],
      },
    );
    configure(homeDir, server, 'responses', 'fixture-responses');
    const factory = createResourceFactory({ homeDir });
    const host = new LocalHostServer({ homeDir, create: factory.create });
    const [wire, peer] = pair();
    const serving = host.accept(peer);
    const approvals: string[] = [];
    const client = await LocalClient.connect(wire, offer, {
      approval: async (request) => {
        approvals.push(request.target);
        return 'allow_once';
      },
    });
    const events: WireEvent[] = [];
    client.subscribe((event) => events.push(event));
    try {
      const created = (await client.call('session/create', { workspaceRoot: root })) as {
        sessionId: string;
      };
      const control = (await client.call('session/attach', {
        sessionId: created.sessionId,
        mode: 'control',
      })) as { sessionId: string; streamEpoch: string; controlEpoch: string };
      const operationId = 'host-operation';
      const started = (await client.call('run/start', {
        sessionId: control.sessionId,
        streamEpoch: control.streamEpoch,
        controlEpoch: control.controlEpoch,
        clientOperationId: operationId,
        input: 'write through host',
      })) as { runId: string };

      await vi.waitFor(() =>
        expect(events.some((event) => event.type === 'run_settled')).toBe(true),
      );
      const settled = events.find((event) => event.type === 'run_settled')!;
      expect(settled.payload).toEqual({ outcome: 'completed' });
      expect(fs.readFileSync(path.join(root, 'host-proof.txt'), 'utf8')).toBe('host proof');
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toContain('host-proof.txt');
      expect(approvals[0]).not.toContain('host proof');

      const startedEvent = events.find((event) => event.type === 'tool_start')!;
      expect(startedEvent.payload.toolName).toBe('write_file');
      expect(startedEvent.payload.target).toContain('host-proof.txt');
      const finished = events.find((event) => event.type === 'tool_finish')!;
      expect(finished.payload).toMatchObject({ isError: false });
      const streamed = textOf(events);
      expect(streamed).toContain('[REDACTED]');
      expect(streamed).not.toContain(FIXTURE_KEY);
      expect(streamed).not.toContain(ENV_SENTINEL);

      const snapshot = (await client.call('session/snapshot', {
        sessionId: created.sessionId,
      })) as {
        history: Array<{ role: string; blocks: Array<{ kind: string; text: string }> }>;
      };
      expect(snapshot.history.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'assistant',
      ]);
      expect(
        snapshot.history.flatMap((message) => message.blocks).map((block) => block.kind),
      ).toEqual(expect.arrayContaining(['tool_use', 'tool_result']));
      expect(JSON.stringify(snapshot)).toContain('[REDACTED]');
      expect(JSON.stringify(snapshot)).not.toContain(FIXTURE_KEY);

      const requestsBeforeReplay = server.requests.length;
      const replay = (await client.call('run/start', {
        sessionId: control.sessionId,
        streamEpoch: control.streamEpoch,
        controlEpoch: control.controlEpoch,
        clientOperationId: operationId,
        input: 'write through host',
      })) as { runId: string };
      expect(replay.runId).toBe(started.runId);
      expect(server.requests).toHaveLength(requestsBeforeReplay);
      await expect(
        client.call('run/start', {
          sessionId: control.sessionId,
          streamEpoch: control.streamEpoch,
          controlEpoch: control.controlEpoch,
          clientOperationId: operationId,
          input: 'different input',
        }),
      ).rejects.toThrow(/OPERATION_CONFLICT/);
      expect(server.requests).toHaveLength(requestsBeforeReplay);

      expect(server.requests.filter((request) => request.protocol === 'responses')).toHaveLength(2);
      expect(server.pending()).toBe(0);
      assertNoEnvironmentCredential(server);
    } finally {
      await client.close();
      await peer.close();
      await serving;
      await host.shutdown();
      server.assertConsumed();
    }
  }, 20_000);
});
