import { describe, expect, it } from 'vitest';
import { SessionApprovalCache } from '../src/security/approval.js';
import { PermissionPolicy, validatePermissionRules } from '../src/security/permissions.js';

const policy = new PermissionPolicy();

describe('PermissionPolicy', () => {
  it('applies the four session modes to declared capabilities', () => {
    expect(
      policy.decide({ mode: 'Approval', toolName: 'read_file', capabilities: ['fs:read'] })
        .decision,
    ).toBe('allow');
    expect(
      policy.decide({ mode: 'Approval', toolName: 'write_file', capabilities: ['fs:write'] })
        .decision,
    ).toBe('ask');
    expect(
      policy.decide({ mode: 'Plan', toolName: 'write_file', capabilities: ['fs:write'] }).decision,
    ).toBe('deny');
    expect(
      policy.decide({ mode: 'Auto', toolName: 'write_file', capabilities: ['fs:write'] }).decision,
    ).toBe('allow');
    expect(
      policy.decide({ mode: 'Auto', toolName: 'run_command', capabilities: ['exec'] }).decision,
    ).toBe('ask');
    expect(
      policy.decide({ mode: 'FullAccess', toolName: 'run_command', capabilities: ['exec'] })
        .decision,
    ).toBe('allow');
    expect(
      policy.decide({ mode: 'FullAccess', toolName: 'opaque', capabilities: [] }).decision,
    ).toBe('ask');
    expect(policy.decide({ mode: 'Plan', toolName: 'opaque', capabilities: [] }).decision).toBe(
      'deny',
    );
    expect(
      policy.decide({
        mode: 'FullAccess',
        toolName: 'opaque',
        capabilities: [],
        rules: [{ action: 'allow', tool: 'opaque' }],
      }).decision,
    ).toBe('ask');
  });

  it('honors hard and explicit denial before allow, then explicit ask before cached approval', () => {
    const input = {
      mode: 'FullAccess' as const,
      toolName: 'read_file',
      capabilities: ['fs:read'] as const,
    };
    expect(
      policy.decide({ ...input, hardDenied: true, rules: [{ action: 'allow', tool: 'read_file' }] })
        .decision,
    ).toBe('deny');
    expect(
      policy.decide({
        ...input,
        rules: [
          { action: 'deny', tool: 'read_file' },
          { action: 'allow', tool: 'read_file' },
        ],
      }).decision,
    ).toBe('deny');
    expect(
      policy.decide({
        ...input,
        rules: [{ action: 'ask', tool: 'read_file' }],
        cachedApproval: true,
      }).decision,
    ).toBe('ask');
  });

  it('never uses broad allow to bypass the shell question', () => {
    expect(
      policy.decide({
        mode: 'Auto',
        toolName: 'run_command',
        capabilities: ['exec'],
        rules: [{ action: 'allow', tool: 'run_command' }],
      }).decision,
    ).toBe('ask');
    expect(
      policy.decide({
        mode: 'Auto',
        toolName: 'run_command',
        capabilities: ['exec'],
        shell: { command: 'pwd', interpreter: 'bash', cwd: '/repo' },
        rules: [{ action: 'allow', shell: { command: 'pwd', interpreter: 'bash', cwd: '/repo' } }],
      }).decision,
    ).toBe('allow');
  });

  it('rejects unsupported shell prefix and wildcard rules at load time', () => {
    expect(() =>
      validatePermissionRules([
        { action: 'deny', shell: { command: 'rm*', interpreter: 'bash', cwd: '/repo' } },
      ]),
    ).toThrow(/rule 1/i);
  });

  it('invalidates a cached Shell approval when cwd, interpreter or fingerprint changes', () => {
    const cache = new SessionApprovalCache();
    const request = {
      toolName: 'run_command',
      capabilities: ['exec'] as const,
      input: { command: 'pwd' },
      rootDir: '/repo',
      sessionAllowed: true,
      shell: { command: 'pwd', interpreter: 'bash', cwd: '/repo', executionFingerprint: 'one' },
    };
    cache.set(request, 'allow');
    expect(cache.get(request)).toBe('allow');
    expect(
      cache.get({ ...request, shell: { ...request.shell, cwd: '/elsewhere' } }),
    ).toBeUndefined();
    expect(
      cache.get({ ...request, shell: { ...request.shell, interpreter: 'pwsh' } }),
    ).toBeUndefined();
    expect(
      cache.get({ ...request, shell: { ...request.shell, executionFingerprint: 'two' } }),
    ).toBeUndefined();
  });

  it('matches shell cwd rules cross-platform even with case or slash variations', () => {
    const cwd = process.platform === 'win32' ? 'C:\\Repo\\Project' : '/repo/project';
    const variantCwd = process.platform === 'win32' ? 'c:/repo/project' : '/repo/project';
    expect(
      policy.decide({
        mode: 'Auto',
        toolName: 'run_command',
        capabilities: ['exec'],
        shell: { command: 'pwd', interpreter: 'bash', cwd: variantCwd },
        rules: [{ action: 'allow', shell: { command: 'pwd', interpreter: 'bash', cwd } }],
      }).decision,
    ).toBe('allow');
  });

  it('computes identical cache key regardless of object key order', () => {
    const cache = new SessionApprovalCache();
    const reqA = {
      toolName: 'write_file',
      capabilities: ['fs:write'] as const,
      input: { path: 'a.txt', content: 'hello' },
      rootDir: '/repo',
      sessionAllowed: true,
    };
    const reqB = {
      toolName: 'write_file',
      capabilities: ['fs:write'] as const,
      input: { content: 'hello', path: 'a.txt' },
      rootDir: '/repo',
      sessionAllowed: true,
    };
    expect(cache.key(reqA)).toBe(cache.key(reqB));
  });
});
