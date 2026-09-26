import { describe, expect, it } from 'vitest';
import {
  type LogEvent,
  StructuredLogger,
  commandAuditSummary,
  executionFingerprint,
  projectSafeFields,
} from '../src/logging/index.js';

describe('structured logging', () => {
  it('records operation events normally and adds diagnostics only in debug mode', async () => {
    const normal: LogEvent[] = [];
    const debug: LogEvent[] = [];
    const event = {
      event: 'session.started',
      sessionId: 'session-1',
      fields: { mode: 'Approval' },
    };

    const normalLogger = new StructuredLogger({
      operationSink: {
        write: async (entry) => {
          normal.push(entry);
        },
      },
      auditSink: { write: async () => undefined },
    });
    const debugLogger = new StructuredLogger({
      debug: true,
      operationSink: {
        write: async (entry) => {
          debug.push(entry);
        },
      },
      auditSink: { write: async () => undefined },
    });

    await normalLogger.record({ ...event, level: 'info' });
    await normalLogger.record({ ...event, level: 'debug' });
    await debugLogger.record({ ...event, level: 'debug' });

    expect(normal).toHaveLength(1);
    expect(normal[0]).toMatchObject({
      schemaVersion: 1,
      event: 'session.started',
      fields: { mode: 'Approval' },
    });
    expect(debug).toHaveLength(1);
    expect(debug[0]?.level).toBe('debug');
  });

  it('projects only safe fields and never keeps secrets or model content', () => {
    expect(
      projectSafeFields({
        toolName: 'read_file',
        durationMs: 8,
        apiKey: 'sk-example-secret',
        prompt: 'private prompt',
        output: 'private output',
        reason: 'Bearer private-token',
      }),
    ).toEqual({ toolName: 'read_file', durationMs: 8, reason: '[redacted]' });
    expect(
      projectSafeFields({
        reason: 'private prompt text',
        commandPreview: 'echo my-secret',
        source: 'settings',
      }),
    ).toEqual({ reason: '[redacted]', commandPreview: '[redacted]', source: 'settings' });
  });

  it('uses a deterministic command digest and hides unsafe command previews', () => {
    const first = commandAuditSummary('echo secret-value');
    const second = commandAuditSummary('echo secret-value');
    expect(first.commandDigest).toBe(second.commandDigest);
    expect(first.commandDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.commandPreview).toBe('[redacted]');
    expect(commandAuditSummary('git status --short').commandPreview).toBe('git (2 args)');
    expect(JSON.stringify(first)).not.toContain('secret-value');
  });

  it('binds approval to the actual execution context', () => {
    const base = {
      command: 'git status',
      shell: 'bash',
      executable: '/usr/bin/bash',
      cwd: '/workspace/a',
      environmentDigest: 'env-1',
      timeoutMs: 120_000,
      outputLimitBytes: 65_536,
    };
    expect(executionFingerprint(base)).not.toBe(
      executionFingerprint({ ...base, cwd: '/workspace/b' }),
    );
    expect(executionFingerprint(base)).not.toBe(executionFingerprint({ ...base, shell: 'pwsh' }));
  });
});
