import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ToolExecutor } from '../src/executor/index.js';
import { HookRegistry } from '../src/hooks/registry.js';
import { type LogEvent, type LogSink, StructuredLogger } from '../src/logging/index.js';
import type { SessionApprovalCache } from '../src/security/approval.js';
import type { ApprovalRequest } from '../src/security/approval.js';
import { writeFileTool } from '../src/tools/builtin/fs.js';
import { defineTool } from '../src/tools/index.js';
import { ToolRegistry } from '../src/tools/registry.js';

class Sink implements LogSink {
  readonly events: LogEvent[] = [];
  failAt?: string;
  async write(event: LogEvent): Promise<void> {
    if (event.event === this.failAt) throw new Error('disk failed: secret');
    this.events.push(event);
  }
}

function fixture(options?: {
  mode?: 'Approval' | 'Plan' | 'Auto' | 'FullAccess';
  audit?: Sink;
  hooks?: HookRegistry;
  approvalChannel?: { requestApproval: ReturnType<typeof vi.fn> };
  cache?: SessionApprovalCache;
}) {
  const execute = vi.fn(async () => 'written');
  const tools = new ToolRegistry();
  tools.register(
    defineTool({
      name: 'write_file',
      description: 'Write',
      parameters: { type: 'object' },
      metadata: { permissions: ['fs:write'] },
      execute,
    }),
  );
  const audit = options?.audit ?? new Sink();
  const executor = new ToolExecutor({
    tools,
    hooks: options?.hooks ?? new HookRegistry(),
    rootDir: process.cwd(),
    mode: options?.mode ?? 'Approval',
    approvalChannel: options?.approvalChannel,
    approvalCache: options?.cache,
    eventLogger: new StructuredLogger({ operationSink: new Sink(), auditSink: audit }),
    sessionId: 's',
    runId: 'r',
  });
  return { executor, execute, audit };
}

describe('executor permission and audit gate', () => {
  it('decides after before-hooks modify the final target', async () => {
    const hooks = new HookRegistry();
    hooks.on('tool:before', async () => ({ action: 'modify', input: { path: 'new.txt' } }));
    const ask = vi.fn(async (_request: ApprovalRequest) => 'allow_once' as const);
    const { executor, execute, audit } = fixture({
      hooks,
      approvalChannel: { requestApproval: ask },
    });
    const result = await executor.executeOne({
      type: 'tool_use',
      id: 'c1',
      name: 'write_file',
      input: { path: 'old.txt' },
    });
    expect(result.isError).toBe(false);
    expect(ask.mock.calls[0]?.[0].input).toEqual({ path: 'new.txt' });
    expect(execute).toHaveBeenCalledWith({ path: 'new.txt' }, expect.anything());
    expect(audit.events.map((event) => event.event)).toEqual([
      'tool.requested',
      'tool.decided',
      'tool.started',
      'tool.finished',
    ]);
  });

  it('denies Plan and missing approval channel without running the tool', async () => {
    for (const mode of ['Plan', 'Approval'] as const) {
      const { executor, execute, audit } = fixture({ mode });
      const result = await executor.executeOne({
        type: 'tool_use',
        id: 'c',
        name: 'write_file',
        input: {},
      });
      expect(result).toMatchObject({
        errorCode: 'PERMISSION_DENIED',
        retryPolicy: 'after_user_action',
      });
      expect(execute).not.toHaveBeenCalled();
      expect(audit.events.map((event) => event.event)).toEqual([
        'tool.requested',
        'tool.decided',
        'tool.finished',
      ]);
    }
  });

  it('never starts when the decision audit fails', async () => {
    const audit = new Sink();
    audit.failAt = 'tool.decided';
    const { executor, execute } = fixture({ mode: 'FullAccess', audit });
    const result = await executor.executeOne({
      type: 'tool_use',
      id: 'c',
      name: 'write_file',
      input: {},
    });
    expect(result.errorCode).toBe('AUDIT_UNAVAILABLE');
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports outcome unknown when the finish audit fails after execution', async () => {
    const audit = new Sink();
    audit.failAt = 'tool.finished';
    const { executor, execute } = fixture({ mode: 'FullAccess', audit });
    const result = await executor.executeOne({
      type: 'tool_use',
      id: 'c',
      name: 'write_file',
      input: {},
    });
    expect(result).toMatchObject({
      errorCode: 'OUTCOME_UNKNOWN',
      retryPolicy: 'after_user_action',
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('does not execute when the approved shell target changes before start', async () => {
    const tools = new ToolRegistry();
    const execute = vi.fn(async () => 'should not run');
    let version = 0;
    tools.register(
      defineTool({
        name: 'run_command',
        description: 'Command',
        parameters: {},
        metadata: { permissions: ['exec'], dangerous: true },
        approvalScope: () => ({
          command: 'pwd',
          interpreter: 'bash',
          cwd: '/repo',
          executionFingerprint: `fingerprint-${++version}`,
        }),
        execute,
      }),
    );
    const audit = new Sink();
    const executor = new ToolExecutor({
      tools,
      hooks: new HookRegistry(),
      rootDir: process.cwd(),
      mode: 'FullAccess',
      eventLogger: new StructuredLogger({ operationSink: new Sink(), auditSink: audit }),
      sessionId: 's',
      runId: 'r',
    });
    const result = await executor.executeOne({
      type: 'tool_use',
      id: 'c',
      name: 'run_command',
      input: { command: 'pwd' },
    });
    expect(result.errorCode).toBe('TARGET_CHANGED');
    expect(execute).not.toHaveBeenCalled();
  });

  it('redecides once when the shell target changes and then stabilizes', async () => {
    const tools = new ToolRegistry();
    const execute = vi.fn(async () => 'done');
    let checks = 0;
    tools.register(
      defineTool({
        name: 'run_command',
        description: 'Command',
        parameters: {},
        metadata: { permissions: ['exec'], dangerous: true },
        approvalScope: () => ({
          command: 'pwd',
          interpreter: 'bash',
          cwd: '/repo',
          executionFingerprint: checks++ === 0 ? 'old' : 'new',
        }),
        execute,
      }),
    );
    const ask = vi.fn(async () => 'allow_once' as const);
    const audit = new Sink();
    const executor = new ToolExecutor({
      tools,
      hooks: new HookRegistry(),
      rootDir: process.cwd(),
      approvalChannel: { requestApproval: ask },
      eventLogger: new StructuredLogger({ operationSink: new Sink(), auditSink: audit }),
      sessionId: 's',
      runId: 'r',
    });
    const result = await executor.executeOne({
      type: 'tool_use',
      id: 'changing',
      name: 'run_command',
      input: { command: 'pwd' },
    });
    expect(result.isError).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledOnce();
    expect(audit.events.map((event) => event.event)).toEqual([
      'tool.requested',
      'tool.decided',
      'tool.target_changed',
      'tool.decided',
      'tool.started',
      'tool.finished',
    ]);
  });

  it('reuses a session approval only for the same final tool input', async () => {
    const ask = vi.fn(async (_request: ApprovalRequest) => 'allow_session' as const);
    const { executor, execute } = fixture({ approvalChannel: { requestApproval: ask } });
    for (const [id, target] of [
      ['a', 'one.txt'],
      ['b', 'one.txt'],
      ['c', 'two.txt'],
    ]) {
      await executor.executeOne({
        type: 'tool_use',
        id,
        name: 'write_file',
        input: { path: target },
      });
    }
    expect(execute).toHaveBeenCalledTimes(3);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('remembers a session denial for the exact final request', async () => {
    const ask = vi.fn(async () => 'deny_session' as const);
    const { executor, execute, audit } = fixture({ approvalChannel: { requestApproval: ask } });
    for (const id of ['first', 'second']) {
      const result = await executor.executeOne({
        type: 'tool_use',
        id,
        name: 'write_file',
        input: { path: 'same.txt' },
      });
      expect(result.errorCode).toBe('PERMISSION_DENIED');
    }
    expect(ask).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(
      audit.events
        .filter((event) => event.event === 'tool.decided')
        .map((event) => event.fields.decisionSource),
    ).toEqual(['human', 'session_cache']);
  });

  it('rejects a session-wide approval for an external script and audits the choice', async () => {
    const tools = new ToolRegistry();
    const execute = vi.fn(async () => 'executed');
    tools.register(
      defineTool({
        name: 'run_command',
        description: 'Command',
        parameters: {},
        metadata: { permissions: ['exec'], dangerous: true },
        approvalScope: () => ({ command: 'bash script.sh', interpreter: 'bash', cwd: '/repo' }),
        execute,
      }),
    );
    const audit = new Sink();
    const ask = vi.fn(async () => 'allow_session' as const);
    const executor = new ToolExecutor({
      tools,
      hooks: new HookRegistry(),
      rootDir: process.cwd(),
      approvalChannel: { requestApproval: ask },
      eventLogger: new StructuredLogger({ operationSink: new Sink(), auditSink: audit }),
      sessionId: 's',
      runId: 'r',
    });
    const result = await executor.executeOne({
      type: 'tool_use',
      id: 'script',
      name: 'run_command',
      input: { command: 'bash script.sh' },
    });
    expect(result.errorCode).toBe('PERMISSION_DENIED');
    expect(execute).not.toHaveBeenCalled();
    expect(audit.events.find((event) => event.event === 'tool.decided')?.fields).toMatchObject({
      decision: 'deny',
      approvalChoice: 'allow_session',
    });
  });

  it('closes later calls without side effects after a terminal denial', async () => {
    const { executor, execute, audit } = fixture();
    const results = await executor.runAll([
      { type: 'tool_use', id: 'first', name: 'write_file', input: { path: 'one.txt' } },
      { type: 'tool_use', id: 'second', name: 'write_file', input: { path: 'two.txt' } },
    ]);
    expect(results.map((result) => result.errorCode)).toEqual([
      'PERMISSION_DENIED',
      'SKIPPED_AFTER_USER_ACTION',
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(audit.events.filter((event) => event.event === 'tool.finished')).toHaveLength(2);
  });

  it('keeps PathSandbox active under FullAccess and distinguishes automatic from human decisions', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-permission-sandbox-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-permission-outside-'));
    try {
      const tools = new ToolRegistry();
      tools.register(writeFileTool);
      const audit = new Sink();
      const makeExecutor = (options: {
        rules?: [{ action: 'deny' | 'ask'; tool: string }];
        approval?: 'allow_once';
      }) =>
        new ToolExecutor({
          tools,
          hooks: new HookRegistry(),
          rootDir: root,
          mode: 'FullAccess',
          permissionRules: options.rules,
          approvalChannel: options.approval
            ? { requestApproval: async () => options.approval! }
            : undefined,
          eventLogger: new StructuredLogger({ operationSink: new Sink(), auditSink: audit }),
          sessionId: 's',
          runId: 'r',
        });
      const outsideFile = path.join(outside, 'denied.txt');
      const escaped = await makeExecutor({}).executeOne({
        type: 'tool_use',
        id: 'outside',
        name: 'write_file',
        input: { path: outsideFile, content: 'secret' },
      });
      expect(escaped.isError).toBe(true);
      expect(fs.existsSync(outsideFile)).toBe(false);
      expect(
        audit.events.find(
          (event) => event.toolUseId === 'outside' && event.event === 'tool.decided',
        )?.fields,
      ).toMatchObject({
        decision: 'allow',
        decisionSource: 'mode_default',
      });
      const denied = await makeExecutor({
        rules: [{ action: 'deny', tool: 'write_file' }],
      }).executeOne({
        type: 'tool_use',
        id: 'denied',
        name: 'write_file',
        input: { path: 'denied.txt', content: 'secret' },
      });
      expect(denied.errorCode).toBe('PERMISSION_DENIED');
      expect(fs.existsSync(path.join(root, 'denied.txt'))).toBe(false);
      const approved = await makeExecutor({
        rules: [{ action: 'ask', tool: 'write_file' }],
        approval: 'allow_once',
      }).executeOne({
        type: 'tool_use',
        id: 'approved',
        name: 'write_file',
        input: { path: 'approved.txt', content: 'done' },
      });
      expect(approved.isError).toBe(false);
      expect(fs.readFileSync(path.join(root, 'approved.txt'), 'utf8')).toBe('done');
      expect(
        audit.events.find(
          (event) => event.toolUseId === 'approved' && event.event === 'tool.decided',
        )?.fields,
      ).toMatchObject({
        decision: 'allow',
        decisionSource: 'human',
        approvalChoice: 'allow_once',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
