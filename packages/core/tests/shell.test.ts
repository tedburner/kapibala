import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolExecutor } from '../src/executor/index.js';
import { HookRegistry } from '../src/hooks/registry.js';
import { type LogEvent, type LogSink, StructuredLogger } from '../src/logging/index.js';
import { classifyBashOutput, detectShell } from '../src/shell/detect.js';
import { cleanupCommandResults, createRunCommandTool } from '../src/shell/tool.js';
import { readFileTool } from '../src/tools/builtin/fs.js';
import { ToolRegistry } from '../src/tools/registry.js';

describe('cross-platform shell discovery and execution', () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0)) {
      // Windows/WSL 在 launcher 退出后可能短暂保留目录句柄，等待释放而不跳过清理。
      await fs.promises.rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  });

  it('classifies bash flavors from uname output without hardcoding install paths', () => {
    expect(classifyBashOutput('MINGW64_NT-10.0-26100\n/C/temp', 'win32')).toBe('bash');
    expect(classifyBashOutput('MSYS_NT-10.0', 'win32')).toBe('bash');
    expect(classifyBashOutput('CYGWIN_NT-10.0', 'win32')).toBe('bash');
    expect(classifyBashOutput('Linux', 'win32')).toBe('wsl');
    expect(classifyBashOutput('Linux', 'linux')).toBe('bash');
    expect(classifyBashOutput('Darwin', 'darwin')).toBe('bash');
    expect(classifyBashOutput('', 'win32')).toBeUndefined();
  });

  it('uses the WSL launcher as fallback before PowerShell on Windows', () => {
    if (process.platform !== 'win32') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-wsl-fallback-'));
    directories.push(root);
    const windows = process.env.SystemRoot ?? 'C:\\Windows';
    const sysDirectory = path.join(windows, 'System32');
    const powershellDirectory = path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0');
    const options = {
      cwd: root,
      platform: 'win32' as const,
      pathEnv: [sysDirectory, powershellDirectory].join(path.delimiter),
    };
    // 显式 native bash：System32 里只有 WSL launcher（或没有 bash），必须失败
    expect(() => detectShell({ ...options, preference: 'bash' })).toThrow(/unavailable/);
    // auto：System32 的 bash.exe 是 WSL launcher 时选 wsl，否则退到 PowerShell
    expect(['wsl', 'powershell']).toContain(detectShell(options).kind);
  }, 30_000);

  it('selects and probes a native bash explicitly when the environment provides one', () => {
    if (process.env.KPBL_REQUIRE_GIT_BASH !== '1') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-gitbash-test-'));
    directories.push(root);
    const environment = detectShell({ cwd: root, preference: 'bash' });
    expect(environment.kind).toBe('bash');
    const automatic = detectShell({ cwd: root, preference: 'auto' });
    expect(automatic.kind).toBe('bash');
  }, 25_000);

  it('accepts a user-provided interpreter path and classifies it at runtime', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-shell-path-'));
    directories.push(root);
    const environment = detectShell({ cwd: root });
    const explicit = detectShell({ cwd: root, preference: environment.executable });
    expect(explicit.kind).toBe(environment.kind);
    expect(explicit.executable).toBe(environment.executable);
  }, 20_000);

  it('runs a real command using a discovered interpreter and bounds output', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-shell-test-'));
    directories.push(root);
    const environment = detectShell({ cwd: root });
    const tool = createRunCommandTool(environment);
    const command =
      environment.kind === 'bash' || environment.kind === 'wsl'
        ? 'printf hello'
        : "Write-Output 'hello'";
    const result = await tool.execute({ command }, { rootDir: root });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('hello');
    expect(result.outputTruncated).toBe(false);
    const large =
      environment.kind === 'bash' || environment.kind === 'wsl'
        ? "printf '%070000d' 1"
        : "Write-Output ('x' * 70000)";
    const big = await tool.execute({ command: large }, { rootDir: root });
    expect(big.outputTruncated).toBe(true);
    expect(Buffer.byteLength(big.output, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(big.outputFile).toBeDefined();
    expect(fs.statSync(big.outputFile!).size).toBeGreaterThan(64 * 1024);
  }, 20_000);

  it('normalizes UTF-8 output and does not inherit unrelated host environment variables', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-shell-env-'));
    directories.push(root);
    const environment = detectShell({ cwd: root });
    const tool = createRunCommandTool(environment);
    const previous = process.env.KPBL_TEST_SECRET;
    process.env.KPBL_TEST_SECRET = 'do-not-inherit';
    try {
      const command =
        environment.kind === 'bash' || environment.kind === 'wsl'
          ? 'if [ -z "${KPBL_TEST_SECRET+x}" ]; then printf "你好🌱 blocked"; fi'
          : "if (-not (Test-Path Env:KPBL_TEST_SECRET)) { Write-Output '你好🌱 blocked' }";
      const result = await tool.execute({ command }, { rootDir: root });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('你好🌱 blocked');
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'KPBL_TEST_SECRET');
      else process.env.KPBL_TEST_SECRET = previous;
    }
  });

  it('keeps UTF-8 intact when the inline limit splits a multibyte character', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-shell-unicode-'));
    directories.push(root);
    const environment = detectShell({ cwd: root });
    const tool = createRunCommandTool(environment);
    const command =
      environment.kind === 'bash' || environment.kind === 'wsl'
        ? "printf '界%.0s' {1..24000}"
        : "Write-Output ('界' * 24000)";
    const result = await tool.execute({ command }, { rootDir: root });
    expect(result.outputTruncated).toBe(true);
    expect(result.output).not.toContain('\u0000');
    expect(result.output).not.toContain('\ufffd');
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    const saved = fs.readFileSync(result.outputFile!, 'utf8');
    expect(saved).not.toContain('\u0000');
    expect(saved).not.toContain('\ufffd');
    expect(saved).toContain('界'.repeat(24000));
  }, 20_000);

  it('stores a valid UTF-8 prefix when a multibyte output reaches the file cap', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-shell-unicode-cap-'));
    directories.push(root);
    const environment = detectShell({
      cwd: root,
      preference: process.platform === 'win32' ? 'powershell' : 'bash',
    });
    const tool = createRunCommandTool(environment);
    const command =
      environment.kind === 'bash' || environment.kind === 'wsl'
        ? "yes 界界 | tr -d '\\n' | head -c 17000000"
        : "Write-Output ('界' * 5700000)";
    const result = await tool.execute({ command }, { rootDir: root });
    expect(result.outputFileTruncated).toBe(true);
    const saved = fs.readFileSync(result.outputFile!);
    expect(saved.length).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(() => new TextDecoder('utf8', { fatal: true }).decode(saved)).not.toThrow();
  }, 40_000);

  it('rejects commands above the 8 KiB limit before spawning', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-shell-limit-'));
    directories.push(root);
    const tool = createRunCommandTool(detectShell({ cwd: root }));
    await expect(
      tool.execute({ command: 'x'.repeat(8 * 1024 + 1) }, { rootDir: root }),
    ).rejects.toThrow(/8192 bytes/);
  });

  it('does not spawn when the run was already aborted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-shell-preabort-'));
    directories.push(root);
    const environment = detectShell({ cwd: root });
    const tool = createRunCommandTool(environment);
    const controller = new AbortController();
    controller.abort();
    const marker = path.join(root, 'should-not-exist.txt');
    const command =
      environment.kind === 'bash' || environment.kind === 'wsl'
        ? 'touch should-not-exist.txt'
        : 'Set-Content -LiteralPath should-not-exist.txt -Value executed';
    await expect(
      tool.execute({ command }, { rootDir: root, signal: controller.signal }),
    ).rejects.toMatchObject({
      code: 'ABORTED',
    });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('binds a directly invoked workspace script to its content and changes the approval fingerprint after edits', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-shell-script-scope-'));
    directories.push(root);
    const environment = detectShell({ cwd: root });
    const tool = createRunCommandTool(environment);
    const script = environment.kind === 'bash' || environment.kind === 'wsl' ? 'job.sh' : 'job.ps1';
    const command =
      environment.kind === 'bash' || environment.kind === 'wsl'
        ? `bash ./${script}`
        : `.\\${script}`;
    fs.writeFileSync(
      path.join(root, script),
      environment.kind === 'bash' || environment.kind === 'wsl'
        ? 'printf first'
        : 'Write-Output first',
    );
    const before = tool.approvalScope!({ command }, root);
    expect(before.scriptDigest).toMatch(/^[a-f0-9]{64}$/);
    fs.writeFileSync(
      path.join(root, script),
      environment.kind === 'bash' || environment.kind === 'wsl'
        ? 'printf second'
        : 'Write-Output second',
    );
    const after = tool.approvalScope!({ command }, root);
    expect(after.scriptDigest).not.toBe(before.scriptDigest);
    expect(after.executionFingerprint).not.toBe(before.executionFingerprint);
    expect(
      tool.approvalScope!({ command: `${command} && echo extra` }, root).scriptDigest,
    ).toBeUndefined();
  });

  it('offers session approval only for a bound direct script, not for a composed shell command', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-shell-script-approval-'));
    directories.push(root);
    const environment = detectShell({ cwd: root });
    const tools = new ToolRegistry();
    tools.register(createRunCommandTool(environment));
    const script = environment.kind === 'bash' || environment.kind === 'wsl' ? 'job.sh' : 'job.ps1';
    const direct =
      environment.kind === 'bash' || environment.kind === 'wsl'
        ? `bash ./${script}`
        : `.\\${script}`;
    fs.writeFileSync(
      path.join(root, script),
      environment.kind === 'bash' || environment.kind === 'wsl' ? 'printf ok' : 'Write-Output ok',
    );
    const offered: boolean[] = [];
    const executor = new ToolExecutor({
      tools,
      hooks: new HookRegistry(),
      rootDir: root,
      approvalChannel: {
        requestApproval: async (request) => {
          offered.push(request.sessionAllowed);
          return 'deny_once';
        },
      },
    });
    await executor.executeOne({
      type: 'tool_use',
      id: 'direct',
      name: 'run_command',
      input: { command: direct },
    });
    await executor.executeOne({
      type: 'tool_use',
      id: 'composed',
      name: 'run_command',
      input: { command: `${direct}; echo extra` },
    });
    expect(offered).toEqual([true, false]);
  });

  it('waits for a timed-out process to exit before reporting cancellation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-shell-timeout-'));
    directories.push(root);
    const environment = detectShell({ cwd: root });
    const tool = createRunCommandTool(environment);
    const command =
      environment.kind === 'bash' || environment.kind === 'wsl'
        ? 'sleep 10'
        : 'Start-Sleep -Seconds 10';
    const started = Date.now();
    await expect(
      tool.execute({ command, timeout_ms: 300 }, { rootDir: root }),
    ).rejects.toMatchObject({
      code: 'COMMAND_TIMEOUT',
      retryPolicy: 'after_user_action',
    });
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 15_000);

  it('reports an unknown outcome when a real POSIX process tree cannot be confirmed stopped', async () => {
    if (process.platform === 'win32') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-shell-reap-'));
    directories.push(root);
    const tool = createRunCommandTool(detectShell({ cwd: root }));
    const originalKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0)
        throw Object.assign(new Error('simulated group signal failure'), { code: 'EPERM' });
      return originalKill(pid, signal);
    });
    try {
      await expect(
        tool.execute({ command: 'sleep 2', timeout_ms: 100 }, { rootDir: root }),
      ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', retryPolicy: 'after_user_action' });
    } finally {
      kill.mockRestore();
    }
  }, 10_000);

  it('reports unknown outcome if the post-spawn audit fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-shell-audit-'));
    directories.push(root);
    const environment = detectShell({ cwd: root });
    const tool = createRunCommandTool(environment);
    const command =
      environment.kind === 'bash' || environment.kind === 'wsl'
        ? 'sleep 10'
        : 'Start-Sleep -Seconds 10';
    await expect(
      tool.execute(
        { command },
        {
          rootDir: root,
          onProcessSpawned: async () => {
            throw new Error('audit disk failed');
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
  }, 15_000);

  it('uses the same execution fingerprint for approval and actual process startup', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-shell-gate-'));
    directories.push(root);
    const environment = detectShell({ cwd: root });
    const tools = new ToolRegistry();
    tools.register(createRunCommandTool(environment));
    const events: LogEvent[] = [];
    const sink: LogSink = {
      async write(event) {
        events.push(event);
      },
    };
    const executor = new ToolExecutor({
      tools,
      hooks: new HookRegistry(),
      rootDir: root,
      mode: 'Approval',
      approvalChannel: { requestApproval: async () => 'allow_once' },
      eventLogger: new StructuredLogger({ operationSink: sink, auditSink: sink }),
      sessionId: 's',
      runId: 'r',
    });
    const command =
      environment.kind === 'bash' || environment.kind === 'wsl' ? 'pwd' : 'Get-Location';
    const result = await executor.executeOne({
      type: 'tool_use',
      id: 'shell-1',
      name: 'run_command',
      input: { command },
    });
    expect(result.isError).toBe(false);
    const decided = events.find((event) => event.event === 'tool.decided');
    const spawned = events.find((event) => event.event === 'process.spawned');
    expect(decided?.fields).toMatchObject({
      decision: 'allow',
      decisionSource: 'human',
      approvalChoice: 'allow_once',
    });
    expect(spawned?.fields.executionFingerprint).toBe(decided?.fields.executionFingerprint);
    expect(events.at(-1)?.event).toBe('tool.finished');
  }, 15_000);

  it('applies all four modes and exact command rules before real execution', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-shell-modes-'));
    directories.push(root);
    const environment = detectShell({ cwd: root });
    const tools = new ToolRegistry();
    tools.register(createRunCommandTool(environment));
    const command =
      environment.kind === 'bash' || environment.kind === 'wsl' ? 'pwd' : 'Get-Location';
    const call = {
      type: 'tool_use' as const,
      id: 'mode-call',
      name: 'run_command',
      input: { command },
    };
    const executor = (
      mode: 'Plan' | 'Approval' | 'Auto' | 'FullAccess',
      rules: Array<{
        action: 'allow' | 'deny';
        shell?: { command: string; interpreter: string; cwd: string };
        tool?: string;
      }> = [],
    ) =>
      new ToolExecutor({
        tools,
        hooks: new HookRegistry(),
        rootDir: root,
        mode,
        permissionRules: rules,
      });
    expect((await executor('Plan').executeOne(call)).errorCode).toBe('PERMISSION_DENIED');
    expect((await executor('Approval').executeOne(call)).errorCode).toBe('PERMISSION_DENIED');
    expect((await executor('Auto').executeOne(call)).errorCode).toBe('PERMISSION_DENIED');
    expect(
      (await executor('FullAccess', [{ action: 'deny', tool: 'run_command' }]).executeOne(call))
        .errorCode,
    ).toBe('PERMISSION_DENIED');
    expect((await executor('FullAccess').executeOne(call)).isError).toBe(false);
    expect(
      (
        await executor('Approval', [
          { action: 'allow', shell: { command, interpreter: environment.kind, cwd: root } },
        ]).executeOne(call)
      ).isError,
    ).toBe(false);
  }, 20_000);

  it('does not start a real command when the approval decision audit cannot be saved', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-shell-audit-gate-'));
    directories.push(root);
    const environment = detectShell({ cwd: root });
    const tools = new ToolRegistry();
    tools.register(createRunCommandTool(environment));
    const audit: LogSink = {
      async write(event) {
        if (event.event === 'tool.decided') throw new Error('disk failed');
      },
    };
    const executor = new ToolExecutor({
      tools,
      hooks: new HookRegistry(),
      rootDir: root,
      mode: 'FullAccess',
      eventLogger: new StructuredLogger({ operationSink: audit, auditSink: audit }),
      sessionId: 's',
      runId: 'r',
    });
    const command =
      environment.kind === 'bash' || environment.kind === 'wsl'
        ? 'touch should-not-exist.txt'
        : 'Set-Content -LiteralPath should-not-exist.txt -Value executed';
    const result = await executor.executeOne({
      type: 'tool_use',
      id: 'audit-gate',
      name: 'run_command',
      input: { command },
    });
    expect(result.errorCode).toBe('AUDIT_UNAVAILABLE');
    expect(fs.existsSync(path.join(root, 'should-not-exist.txt'))).toBe(false);
  });

  it('stops a spawned child process when the session is aborted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-shell-tree-'));
    directories.push(root);
    const environment = detectShell({ cwd: root });
    const tool = createRunCommandTool(environment);
    const started = path.join(root, 'child-started.txt');
    const completed = path.join(root, 'child-completed.txt');
    let command: string;
    if (environment.kind === 'bash' || environment.kind === 'wsl') {
      fs.writeFileSync(
        path.join(root, 'child.sh'),
        'printf started > child-started.txt\nsleep 3\nprintf completed > child-completed.txt\n',
      );
      command = 'bash ./child.sh & sleep 10';
    } else {
      fs.writeFileSync(
        path.join(root, 'child.ps1'),
        'Set-Content -LiteralPath ./child-started.txt -Value started; Start-Sleep -Seconds 3; Set-Content -LiteralPath ./child-completed.txt -Value completed',
      );
      const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;
      command = `Start-Process -FilePath ${quoted(environment.executable)} -ArgumentList @('-NoProfile','-File',${quoted(path.join(root, 'child.ps1'))}) -WorkingDirectory ${quoted(root)} -PassThru | Out-Null; Start-Sleep -Seconds 10`;
    }
    const controller = new AbortController();
    const pending = tool.execute(
      { command, timeout_ms: 10_000 },
      { rootDir: root, signal: controller.signal },
    );
    try {
      const deadline = Date.now() + 15_000;
      while (!fs.existsSync(started) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(fs.existsSync(started)).toBe(true);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
      await new Promise((resolve) => setTimeout(resolve, 3_300));
      expect(fs.existsSync(completed)).toBe(false);
    } finally {
      controller.abort();
      await pending.catch(() => {});
    }
  }, 35_000);

  it('cleans only expired managed result files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-shell-cleanup-'));
    directories.push(root);
    const directory = path.join(root, '.kapibala', 'tool-results');
    const environment = detectShell({ cwd: root });
    const tool = createRunCommandTool(environment);
    const command =
      environment.kind === 'bash' || environment.kind === 'wsl'
        ? "printf '%070000d' 1"
        : "Write-Output ('x' * 70000)";
    const result = await tool.execute({ command }, { rootDir: root });
    const managed = result.outputFile!;
    const userMadeSamePattern = path.join(
      directory,
      'run-223e4567-e89b-12d3-a456-426614174000.txt',
    );
    const privateFile = path.join(directory, 'my-notes.txt');
    fs.writeFileSync(managed, 'old');
    fs.writeFileSync(userMadeSamePattern, 'user-created');
    fs.writeFileSync(privateFile, 'keep');
    const old = new Date(Date.now() - 8 * 86_400_000);
    fs.utimesSync(managed, old, old);
    fs.utimesSync(userMadeSamePattern, old, old);
    fs.utimesSync(privateFile, old, old);
    cleanupCommandResults(root);
    expect(fs.existsSync(managed)).toBe(false);
    expect(fs.existsSync(userMadeSamePattern)).toBe(true);
    expect(fs.existsSync(privateFile)).toBe(true);
  });

  it('continues draining output after the managed file reaches its 16 MiB cap', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-shell-large-'));
    directories.push(root);
    const environment = detectShell({ cwd: root });
    const tool = createRunCommandTool(environment);
    const command =
      environment.kind === 'bash' || environment.kind === 'wsl'
        ? 'yes 0123456789 | head -c 17000000'
        : "Write-Output (('x' * 80 + [Environment]::NewLine) * 210000)";
    const result = await tool.execute({ command, timeout_ms: 30_000 }, { rootDir: root });
    expect(result.exitCode).toBe(0);
    expect(result.outputBytes).toBeGreaterThan(16 * 1024 * 1024);
    expect(result.outputFileTruncated).toBe(true);
    expect(fs.statSync(result.outputFile!).size).toBeLessThanOrEqual(16 * 1024 * 1024);
    const firstLines = await readFileTool.execute(
      { path: result.outputFile!, startLine: 1, endLine: 2 },
      { rootDir: root },
    );
    expect(firstLines.split('\n')).toHaveLength(2);
  }, 40_000);
});
