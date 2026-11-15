import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry } from '@kiturone/kapibala';
import { registerBuiltinTools } from '@kiturone/kapibala-host/internal';
import { describe, expect, it } from 'vitest';

describe('CLI builtin tool registration', () => {
  it('keeps other tools available and reports a missing shell before approval', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, {
      cwd: os.tmpdir(),
      detect: () => {
        throw new Error('No usable Bash or PowerShell interpreter found');
      },
    });
    expect(registry.get('read_file')).toBeDefined();
    const command = registry.get('run_command');
    expect(command).toBeDefined();
    expect(command?.validateInput?.({ command: 'echo hello' })).toMatchObject({
      valid: false,
      message: expect.stringMatching(/shell|解释器/i),
    });
  });

  it('retries shell discovery before approval and binds the discovered interpreter', () => {
    let available = false;
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, {
      cwd: os.tmpdir(),
      detect: () => {
        if (!available) throw new Error('No usable Bash or PowerShell interpreter found');
        return {
          kind: 'bash',
          executable: process.execPath,
          executableDigest: 'test',
          cwd: os.tmpdir(),
        };
      },
    });
    const command = registry.get('run_command')!;
    expect(command.validateInput?.({ command: 'echo hello' })?.valid).toBe(false);
    available = true;
    expect(command.validateInput?.({ command: 'echo hello' })?.valid).toBe(true);
    expect(command.approvalScope?.({ command: 'echo hello' }, os.tmpdir()).executablePath).toBe(
      fs.realpathSync.native(process.execPath),
    );
  });

  it('registers run_command by default and keeps an explicitly disabled registry closed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-registration-'));
    try {
      const detect = () => ({
        kind: 'bash' as const,
        executable: '/bin/echo',
        executableDigest: 'test-digest',
        cwd: root,
      });
      const defaults = new ToolRegistry();
      registerBuiltinTools(defaults, { cwd: root, detect });
      expect(defaults.get('run_command')).toBeDefined();
      expect(defaults.get('read_file')).toBeDefined();

      const disabled = new ToolRegistry();
      registerBuiltinTools(disabled, { cwd: root, detect, disableShell: true });
      expect(disabled.get('run_command')).toBeUndefined();
      expect(disabled.get('read_file')).toBeDefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('registers agent management tools declaring agent:spawn capability when runtime is provided', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-agent-reg-'));
    try {
      const { AgentRuntime } = require('@kiturone/kapibala');
      const runtime = new AgentRuntime();
      const registry = new ToolRegistry();
      registerBuiltinTools(registry, { cwd: root, runtime, disableShell: true });

      const spawn = registry.get('spawn_agent');
      const list = registry.get('list_agents');
      const wait = registry.get('wait_agent');
      const cancel = registry.get('cancel_agent');

      expect(spawn).toBeDefined();
      expect(list).toBeDefined();
      expect(wait).toBeDefined();
      expect(cancel).toBeDefined();

      expect(spawn?.metadata?.permissions).toContain('agent:spawn');
      expect(list?.metadata?.permissions).toContain('agent:spawn');
      expect(wait?.metadata?.permissions).toContain('agent:spawn');
      expect(cancel?.metadata?.permissions).toContain('agent:spawn');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
