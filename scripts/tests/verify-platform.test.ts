import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  type McpProbeResult,
  type PlatformProbeResult,
  assertDaemonProbe,
  assertMcpProbe,
  assertStdioProbe,
  assertTreeProbe,
  browserBundleViolations,
  evaluateNodeSupport,
  platformGateVerdict,
  rewriteWorkspaceDependencies,
  run,
} from '../verify-platform.js';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof childProcess>('node:child_process');
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const cleanExit = { code: 0, signal: null };

const stdio = (): PlatformProbeResult => ({
  ok: true,
  stdio: {
    ping: { alive: true, serverInstanceId: 'instance' },
    host: cleanExit,
    stderr: '',
  },
});

const daemon = (): PlatformProbeResult => ({
  ok: true,
  daemon: {
    first: { running: true, serverInstanceId: 'instance' },
    second: { running: true, serverInstanceId: 'instance' },
    metadata: {
      serverInstanceId: 'instance',
      endpointType: 'unix',
      tokenShape: true,
      mode: process.platform === 'win32' ? null : 0o600,
      runtimeMode: process.platform === 'win32' ? null : 0o700,
    },
    statusRunning: { running: true },
    connected: true,
    auth: {
      missing: { ok: false, error: 'UNAUTHORIZED: token required' },
      wrong: { ok: false, error: 'UNAUTHORIZED: token mismatch' },
      correct: { ok: true, ping: { alive: true } },
    },
    statusStopped: { running: false },
    lockRemoved: true,
  },
});

const tree = (): PlatformProbeResult => ({
  ok: true,
  tree: {
    shellPid: 100,
    childPid: 101,
    aliveBefore: { shell: true, child: true },
    aliveAfter: { shell: false, child: false },
    outcome: 'cancelled',
    host: cleanExit,
    stderr: '',
  },
});

const mcp = (): McpProbeResult => ({
  ok: true,
  startupAuthorization: {
    authorizations: [
      { server: 'stdio', type: 'stdio' },
      { server: 'http', type: 'http' },
    ],
    readyServers: ['stdio', 'http'],
    failedServers: {},
  },
  tools: {
    stdio: { name: 'stdio__echo', dangerous: true },
    http: { name: 'http__echo', dangerous: true },
  },
  calls: { stdio: 'stdio:echo:hello', http: 'http:echo:hello' },
  cancel: { dispatchedError: true, elapsedMs: 200, stillReady: true },
  revoke: { status: { connectionState: 'disabled' }, error: 'MCP_SERVER_UNAVAILABLE' },
  reenable: { status: { connectionState: 'ready' }, call: 'http:echo:restored' },
  denied: { readyServers: ['http'], failedServers: { stdio: 'denied' } },
  retry: {
    firstFailedServers: { flaky: 'startup failed' },
    status: { connectionState: 'ready' },
    call: 'flaky:echo:retried',
  },
  close: {
    stdioPid: 200,
    stdioAlive: false,
    managerTornDown: true,
    sessionState: 'disconnected',
    sessionReady: false,
    httpCalls: { initialized: 1, listTools: 1, callTool: 2 },
  },
});

describe('platform gate helpers', () => {
  it('fails on pending evidence unless independent acceptance is explicitly deferred', () => {
    const sections = {
      stdio: { status: 'passed' as const },
      'posix-pty': { status: 'pending' as const },
    };
    expect(platformGateVerdict(sections)).toEqual({ status: 'pending', exitCode: 1 });
    expect(platformGateVerdict(sections, true)).toEqual({ status: 'pending', exitCode: 0 });
    expect(platformGateVerdict({ stdio: { status: 'failed' } }, true)).toEqual({
      status: 'failed',
      exitCode: 1,
    });
    expect(platformGateVerdict({ artifacts: { status: 'pending' } }, true)).toEqual({
      status: 'pending',
      exitCode: 1,
    });
    expect(platformGateVerdict({ stdio: { status: 'passed' } })).toEqual({
      status: 'passed',
      exitCode: 0,
    });
  });

  it('starts the detected Windows pnpm shim through a shell', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const spawn = vi.spyOn(childProcess, 'spawn').mockImplementationOnce(() => {
      queueMicrotask(() => child.emit('close', 0, null));
      return child as unknown as ReturnType<typeof childProcess.spawn>;
    });
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      await run('pnpm.cmd', ['-C', 'workspace', 'pack'], { env: {} });
      expect(spawn.mock.calls[0]?.[2]?.shell).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      spawn.mockRestore();
    }
  });

  it('separates the Node 20 channel from the >=20 minimum', () => {
    expect(evaluateNodeSupport('v20.19.5')).toEqual({
      major: 20,
      satisfiesMinimum: true,
      actualNode20: true,
    });
    expect(evaluateNodeSupport('26.12.0')).toEqual({
      major: 26,
      satisfiesMinimum: true,
      actualNode20: false,
    });
    expect(evaluateNodeSupport('18.20.0').satisfiesMinimum).toBe(false);
    expect(evaluateNodeSupport('unexpected')).toEqual({
      major: Number.NaN,
      satisfiesMinimum: false,
      actualNode20: false,
    });
  });

  it('rewrites only workspace protocol dependencies', () => {
    const rewritten = rewriteWorkspaceDependencies(
      {
        name: '@kiturone/kapibala-cli',
        dependencies: {
          '@kiturone/kapibala': 'workspace:*',
          '@kiturone/kapibala-mcp': 'workspace:^',
          external: '^1.2.3',
        },
        devDependencies: { '@kiturone/kapibala': 'workspace:*' },
      },
      '0.0.10',
    );
    expect(rewritten.dependencies).toEqual({
      '@kiturone/kapibala': '0.0.10',
      '@kiturone/kapibala-mcp': '0.0.10',
      external: '^1.2.3',
    });
    expect(rewritten.devDependencies).toEqual({ '@kiturone/kapibala': 'workspace:*' });
    const manifest = { name: 'core' };
    expect(rewriteWorkspaceDependencies(manifest, '0.0.10')).toBe(manifest);
  });

  it('reports browser-hostile imports without false positives on relative code', () => {
    expect(browserBundleViolations("import fs from 'node:fs';")).toEqual(['node:fs']);
    expect(browserBundleViolations("const p = await import('node:path');")).toEqual(['node:path']);
    expect(browserBundleViolations('const fs = require("fs");')).toEqual(['require()']);
    expect(
      browserBundleViolations("import { x } from './require-helper.js';\nimport y from 'zod';"),
    ).toEqual([]);
    expect(
      browserBundleViolations("import 'node:path';\nimport 'node:fs';\nrequire('./x');"),
    ).toEqual(['node:fs', 'node:path', 'require()']);
  });

  it('accepts a complete stdio/daemon/tree probe', () => {
    expect(() => assertStdioProbe(stdio())).not.toThrow();
    expect(() => assertDaemonProbe(daemon())).not.toThrow();
    expect(() => assertTreeProbe(tree())).not.toThrow();
    expect(() => assertMcpProbe(mcp())).not.toThrow();
  });

  it('rejects a stdio host that stays silent, crashes or leaks stderr', () => {
    const silent = stdio();
    silent.stdio!.ping.alive = false;
    expect(() => assertStdioProbe(silent)).toThrow(/ping/);
    const crashed = stdio();
    crashed.stdio!.host = { code: 1, signal: null };
    expect(() => assertStdioProbe(crashed)).toThrow(/exit cleanly/);
    const noisy = stdio();
    noisy.stdio!.stderr = 'unhandled rejection';
    expect(() => assertStdioProbe(noisy)).toThrow(/stderr/);
  });

  it('rejects daemon reuse, weak tokens and retained locks', () => {
    const second = daemon();
    second.daemon!.second.serverInstanceId = 'other';
    expect(() => assertDaemonProbe(second)).toThrow(/second instance/);
    const token = daemon();
    token.daemon!.metadata.tokenShape = false;
    expect(() => assertDaemonProbe(token)).toThrow(/64-hex/);
    const unauthenticated = daemon();
    unauthenticated.daemon!.auth.missing = { ok: true };
    expect(() => assertDaemonProbe(unauthenticated)).toThrow(/without a token/);
    const unlocked = daemon();
    unlocked.daemon!.lockRemoved = false;
    expect(() => assertDaemonProbe(unlocked)).toThrow(/lock/);
    if (process.platform !== 'win32') {
      const publicRuntime = daemon();
      publicRuntime.daemon!.metadata.runtimeMode = 0o755;
      expect(() => assertDaemonProbe(publicRuntime)).toThrow(/runtime directory mode/);
    }
  });

  it('rejects a process tree that loses only its leader', () => {
    const survivor = tree();
    survivor.tree!.aliveAfter.child = true;
    expect(() => assertTreeProbe(survivor)).toThrow(/descendant process survived/);
    const completed = tree();
    completed.tree!.outcome = 'completed';
    expect(() => assertTreeProbe(completed)).toThrow(/settled as completed/);
  });

  it('rejects MCP probes with unapproved transports, retained sessions or missing retries', () => {
    const unauthorized = mcp();
    unauthorized.startupAuthorization!.authorizations = [{ server: 'stdio', type: 'stdio' }];
    expect(() => assertMcpProbe(unauthorized)).toThrow(/both transports/);

    const retained = mcp();
    retained.close!.sessionReady = true;
    expect(() => assertMcpProbe(retained)).toThrow(/still reports ready/);

    const orphan = mcp();
    orphan.close!.stdioAlive = true;
    expect(() => assertMcpProbe(orphan)).toThrow(/survived teardown/);

    const noRetry = mcp();
    noRetry.retry!.firstFailedServers = {};
    expect(() => assertMcpProbe(noRetry)).toThrow(/flaky/);

    const weakApproval = mcp();
    weakApproval.tools!.stdio.dangerous = false;
    expect(() => assertMcpProbe(weakApproval)).toThrow(/dangerous/);

    const failed = { ...mcp(), ok: false, error: 'fixture crashed' };
    expect(() => assertMcpProbe(failed)).toThrow(/fixture crashed/);
  });
});
