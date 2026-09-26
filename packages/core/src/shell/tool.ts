import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { KapibalaError } from '../errors/index.js';
import { commandAuditSummary, executionFingerprint } from '../logging/index.js';
import type { ShellScope } from '../security/permissions.js';
import { defineTool } from '../tools/index.js';
import type { Tool } from '../tools/index.js';
import type { ShellEnvironment } from './detect.js';

const INLINE_LIMIT = 64 * 1024;
const FILE_LIMIT = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_COMMAND_BYTES = 8 * 1024;
const OWNED_RESULT = /^run-[a-f0-9-]{36}\.txt$/;
const RESULT_MANIFEST = 'managed-results.jsonl';

export interface RunCommandInput {
  [key: string]: unknown;
  command: string;
  cwd?: string;
  timeout_ms?: number;
}

export interface CommandResult {
  exitCode: number | null;
  output: string;
  outputTruncated: boolean;
  outputFile?: string;
  outputFileTruncated: boolean;
  outputBytes: number;
  shell: ShellEnvironment['kind'];
}

/** 仅继承允许的宿主变量；WSL 输出编码属于固定执行策略并参与审批指纹。 */
function limitedEnvironment(kind: ShellEnvironment['kind']): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'Path',
    'SystemRoot',
    'ComSpec',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'LANG',
    'LC_ALL',
    'TERM',
  ];
  const environment = Object.fromEntries(
    allowed.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
  );
  // WSL launcher 的诊断默认是 UTF-16LE，强制 UTF-8 后才可与 Linux 命令输出合并。
  if (kind === 'wsl') environment.WSL_UTF8 = '1';
  return environment;
}

/** 在 UTF-8 字符边界截断，避免截断字符变成替换符并突破编码后的字节上限。 */
function utf8Prefix(bytes: Buffer, limit: number): Buffer {
  let end = Math.min(bytes.length, limit);
  let start = end - 1;
  while (start >= 0 && (bytes[start]! & 0xc0) === 0x80) start--;
  if (start >= 0) {
    const lead = bytes[start]!;
    const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (start + length > end) end = start;
  }
  return bytes.subarray(0, end);
}

function effectiveCwd(input: RunCommandInput, rootDir: string): string {
  const requested = input.cwd ? path.resolve(rootDir, input.cwd) : rootDir;
  const real = fs.realpathSync(requested);
  if (!fs.statSync(real).isDirectory())
    throw new Error('Command working directory is not a directory');
  return real;
}

function effectiveTimeout(input: RunCommandInput): number {
  const timeout = input.timeout_ms ?? DEFAULT_TIMEOUT;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT) {
    throw new Error(`Command timeout must be 1-${MAX_TIMEOUT} ms`);
  }
  return timeout;
}

function validateCommand(input: RunCommandInput): void {
  if (
    typeof input.command !== 'string' ||
    input.command.trim().length === 0 ||
    Buffer.byteLength(input.command, 'utf8') > MAX_COMMAND_BYTES
  ) {
    throw new Error(`Command must be nonempty and at most ${MAX_COMMAND_BYTES} bytes`);
  }
}

/** 只绑定工作目录内直接引用的脚本路径及自身内容；组合命令仍只可单次批准。 */
function directScriptDigest(
  command: string,
  kind: ShellEnvironment['kind'],
  cwd: string,
): string | undefined {
  const bashLike = kind === 'bash' || kind === 'wsl';
  if (bashLike && command.includes('\\')) return undefined;
  const normalized = command.trim().replaceAll('\\', '/');
  const match = bashLike
    ? /^(?:bash )?\.\/([A-Za-z0-9_./-]+\.sh)$/.exec(normalized)
    : /^\.\/([A-Za-z0-9_./-]+\.ps1)$/i.exec(normalized);
  if (!match) return undefined;
  try {
    const script = fs.realpathSync(path.resolve(cwd, match[1]!));
    const relative = path.relative(cwd, script);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    const stat = fs.statSync(script);
    if (!stat.isFile() || stat.size > 1024 * 1024) return undefined;
    return createHash('sha256')
      .update(script)
      .update('\0')
      .update(fs.readFileSync(script))
      .digest('hex');
  } catch {
    return undefined;
  }
}

function interpreterArgs(environment: ShellEnvironment, command: string): string[] {
  if (environment.kind === 'bash' || environment.kind === 'wsl') {
    return ['--noprofile', '--norc', '-c', command];
  }
  const utf8 =
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; ';
  return ['-NoProfile', '-NonInteractive', '-Command', utf8 + command];
}

function getTaskkillPath(): string {
  if (process.platform !== 'win32') return 'taskkill';
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const candidate = path.join(systemRoot, 'System32', 'taskkill.exe');
  try {
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    /* Fall back to PATH */
  }
  return 'taskkill.exe';
}

interface NativeBashGroup {
  environment: ShellEnvironment;
  token: string;
  pid?: number;
  ready: Promise<void>;
  accept: (text: string) => string;
}

/** 从解释器启动时的私有 stderr 握手取得 MSYS 进程组；不把握手内容回填模型。 */
function createNativeBashGroup(environment: ShellEnvironment): NativeBashGroup | undefined {
  if (process.platform !== 'win32' || environment.kind !== 'bash') return undefined;
  let resolveReady: () => void = () => {};
  let pending = '';
  let accepted = false;
  const group: NativeBashGroup = {
    environment,
    token: randomUUID(),
    ready: new Promise<void>((resolve) => {
      resolveReady = resolve;
    }),
    accept(text) {
      if (accepted) return text;
      pending += text;
      const newline = pending.indexOf('\n');
      if (newline < 0) return '';
      accepted = true;
      const prefix = `${group.token}:`;
      const line = pending.slice(0, newline).trimEnd();
      const pid = line.startsWith(prefix) ? Number(line.slice(prefix.length)) : Number.NaN;
      if (Number.isSafeInteger(pid) && pid > 0) group.pid = pid;
      resolveReady();
      return group.pid ? pending.slice(newline + 1) : pending;
    },
  };
  return group;
}

/** 只向本次解释器报告的 MSYS 进程组发信号；失败不得作为退出证明。 */
function signalNativeBashGroup(group: NativeBashGroup, signal: 'TERM' | 'KILL'): boolean {
  if (!group.pid) return false;
  const result = spawnSync(
    group.environment.executable,
    ['--noprofile', '--norc', '-c', `kill -${signal} -- -${group.pid}`],
    { windowsHide: true, timeout: 3000, env: limitedEnvironment('bash') },
  );
  return result.status === 0;
}

/** Windows taskkill 无法覆盖已重挂父进程的 MSYS 后代，须同时核对 MSYS 进程组。 */
function nativeBashGroupStopped(group: NativeBashGroup): boolean {
  if (!group.pid) return false;
  const result = spawnSync(group.environment.executable, ['--noprofile', '--norc', '-c', 'ps -l'], {
    windowsHide: true,
    timeout: 3000,
    encoding: 'utf8',
    env: limitedEnvironment('bash'),
  });
  if (result.status !== 0 || !result.stdout.includes('PGID')) return false;
  return !result.stdout.split('\n').some((line) => {
    const columns = line.trim().split(/\s+/);
    return /^\d+$/.test(columns[0] ?? '') && Number(columns[2]) === group.pid;
  });
}

function stopProcessTree(child: ChildProcess, nativeGroup?: NativeBashGroup): boolean {
  if (!child.pid) return false;
  if (process.platform === 'win32') {
    const groupStopped = !nativeGroup || signalNativeBashGroup(nativeGroup, 'TERM');
    const result = spawnSync(getTaskkillPath(), ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 3000,
    });
    // MSYS 组信号可能先让 Windows launcher 退出，taskkill 此时找不到 PID；
    // 调用方仍须等待 close 并核对进程组消失，不能只凭此返回值宣称已回收。
    return groupStopped && (result.status === 0 || Boolean(nativeGroup));
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
    return true;
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* Already gone. */
    }
    return false;
  }
}

function forceProcessTree(child: ChildProcess, nativeGroup?: NativeBashGroup): boolean {
  if (!child.pid) return false;
  if (process.platform === 'win32') {
    const groupStopped = !nativeGroup || signalNativeBashGroup(nativeGroup, 'KILL');
    const result = spawnSync(getTaskkillPath(), ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 3000,
    });
    return groupStopped && (result.status === 0 || Boolean(nativeGroup));
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
    return true;
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* Already gone. */
    }
    return false;
  }
}

async function confirmProcessTreeStopped(
  child: ChildProcess,
  terminationSucceeded: boolean,
  nativeGroup?: NativeBashGroup,
): Promise<boolean> {
  if (!terminationSucceeded || !child.pid) return false;
  if (nativeGroup) {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (nativeBashGroupStopped(nativeGroup)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }
  if (process.platform === 'win32') return true; // taskkill /T /F reported successful termination.
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      process.kill(-child.pid, 0);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function waitForClose(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), milliseconds);
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

function resultDirectory(rootDir: string): string {
  return path.join(rootDir, '.kapibala', 'tool-results');
}

/** 仅清理受管 UUID 文件，避免删除用户在同目录保存的结果。 */
export function cleanupCommandResults(rootDir: string, now = Date.now()): void {
  const directory = resultDirectory(rootDir);
  if (!fs.existsSync(directory)) return;
  const manifest = path.join(directory, RESULT_MANIFEST);
  if (!fs.existsSync(manifest) || !fs.lstatSync(manifest).isFile()) return;
  const cutoff = now - 7 * 86_400_000;
  const retained: string[] = [];
  for (const line of fs.readFileSync(manifest, 'utf8').split('\n')) {
    if (!line) continue;
    let record: { name: string; dev: number; ino: number };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    if (!OWNED_RESULT.test(record.name)) continue;
    const file = path.join(directory, record.name);
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.dev !== record.dev || stat.ino !== record.ino) continue;
    if (stat.mtimeMs < cutoff) fs.unlinkSync(file);
    else retained.push(line);
  }
  const replacement = path.join(directory, `.managed-results-${randomUUID()}.tmp`);
  fs.writeFileSync(replacement, retained.length ? `${retained.join('\n')}\n` : '', { mode: 0o600 });
  fs.renameSync(replacement, manifest);
}

function recordManagedResult(directory: string, file: string, descriptor: number): void {
  const stat = fs.fstatSync(descriptor);
  fs.appendFileSync(
    path.join(directory, RESULT_MANIFEST),
    `${JSON.stringify({ name: path.basename(file), dev: stat.dev, ino: stat.ino })}\n`,
    { mode: 0o600 },
  );
}

/** 使用固定解释器执行命令；超时和中止必须先处理进程树再返回。 */
export function createRunCommandTool(
  environment: ShellEnvironment,
): Tool<RunCommandInput, CommandResult> {
  return defineTool({
    name: 'run_command',
    description: `Run a ${
      environment.kind === 'wsl' ? 'bash (WSL)' : environment.kind
    } command as the current OS user. The file tool PathSandbox does not isolate this process or its network access.`,
    metadata: {
      source: 'builtin',
      permissions: ['fs:read', 'fs:write', 'exec', 'net:outbound', 'env:read'],
      dangerous: true,
      managesTimeout: true,
    },
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: `Command using ${
            environment.kind === 'wsl' ? 'bash' : environment.kind
          } syntax.`,
        },
        cwd: { type: 'string', description: 'Working directory; defaults to workspace root.' },
        timeout_ms: { type: 'integer', description: 'Timeout in milliseconds, maximum 600000.' },
      },
      required: ['command'],
    },
    approvalScope(input, rootDir): ShellScope {
      validateCommand(input);
      const cwd = effectiveCwd(input, rootDir);
      const timeoutMs = effectiveTimeout(input);
      const scriptDigest = directScriptDigest(input.command, environment.kind, cwd);
      const stat = fs.statSync(environment.executable);
      const executableDigest = createHash('sha256')
        .update(JSON.stringify([environment.executable, stat.size, stat.mtimeMs]))
        .digest('hex');
      const environmentDigest = createHash('sha256')
        .update(JSON.stringify(limitedEnvironment(environment.kind)))
        .digest('hex');
      return {
        command: input.command,
        interpreter: environment.kind,
        executablePath: environment.executable,
        cwd,
        executableDigest,
        ...(scriptDigest ? { scriptDigest } : {}),
        executionFingerprint: executionFingerprint({
          command: input.command,
          shell: environment.kind,
          executable: executableDigest,
          cwd,
          environmentDigest,
          timeoutMs,
          outputLimitBytes: FILE_LIMIT,
          targetDigest: scriptDigest,
        }),
      };
    },
    async execute(input, ctx): Promise<CommandResult> {
      const startedAt = Date.now();
      validateCommand(input);
      if (ctx.signal?.aborted) {
        throw new KapibalaError('Command aborted before start', {
          code: 'ABORTED',
          retryPolicy: 'after_user_action',
          safeMessage: 'Command was not started because the run was aborted',
        });
      }
      const cwd = effectiveCwd(input, ctx.rootDir);
      const timeoutMs = effectiveTimeout(input);
      cleanupCommandResults(ctx.rootDir);
      const nativeGroup = createNativeBashGroup(environment);
      const command = nativeGroup
        ? `printf '${nativeGroup.token}:%s\\n' "$$" >&2\n${input.command}`
        : input.command;
      const child = spawn(environment.executable, interpreterArgs(environment, command), {
        cwd,
        env: limitedEnvironment(environment.kind),
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const inline: Buffer[] = [];
      let inlineBytes = 0;
      let outputBytes = 0;
      let fileBytes = 0;
      let outputFile: string | undefined;
      let outputFileTruncated = false;
      let outputFailure = false;
      let lastProgressAt = startedAt;
      let descriptor: number | undefined;
      const collect = (chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputFailure) return;
        if (inlineBytes < INLINE_LIMIT) {
          const part = chunk.subarray(0, INLINE_LIMIT - inlineBytes);
          inline.push(part);
          inlineBytes += part.length;
        }
        if (outputBytes > INLINE_LIMIT && descriptor === undefined) {
          const directory = resultDirectory(ctx.rootDir);
          fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
          outputFile = path.join(directory, `run-${randomUUID()}.txt`);
          descriptor = fs.openSync(outputFile, 'wx', 0o600);
          recordManagedResult(directory, outputFile, descriptor);
          const prefix = Buffer.concat(inline);
          fs.writeSync(descriptor, prefix);
          fileBytes = prefix.length;
          const remaining = chunk.subarray(
            Math.max(0, prefix.length - (outputBytes - chunk.length)),
          );
          const writable = utf8Prefix(remaining, FILE_LIMIT - fileBytes);
          if (writable.length > 0) fs.writeSync(descriptor, writable);
          fileBytes += writable.length;
          if (writable.length < remaining.length) outputFileTruncated = true;
        } else if (descriptor !== undefined && !outputFileTruncated) {
          const writable = utf8Prefix(chunk, FILE_LIMIT - fileBytes);
          if (writable.length > 0) fs.writeSync(descriptor, writable);
          fileBytes += writable.length;
          if (writable.length < chunk.length) outputFileTruncated = true;
        } else if (descriptor !== undefined) {
          outputFileTruncated = true;
        }
      };
      const onData = (chunk: Buffer): void => {
        try {
          collect(chunk);
        } catch {
          outputFailure = true;
          if (descriptor !== undefined) {
            try {
              fs.closeSync(descriptor);
            } catch {
              /* Storage failure is reported below. */
            }
            descriptor = undefined;
          }
        }
        const now = Date.now();
        if (now - lastProgressAt >= 250) {
          lastProgressAt = now;
          ctx.onProgress?.({ elapsedMs: now - startedAt, outputBytes });
        }
      };
      // 每个管道独立解码，避免跨 chunk 或 stdout/stderr 交错时拼坏 UTF-8 字符。
      // 非法输入也先规范为文本，再按 UTF-8 字节限流，避免替换符扩大模型输出。
      for (const stream of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder('utf8');
        stream?.on('data', (chunk: Buffer) => {
          let text = decoder.write(chunk);
          if (stream === child.stderr && nativeGroup) text = nativeGroup.accept(text);
          if (text) onData(Buffer.from(text, 'utf8'));
        });
        stream?.once('end', () => {
          const text = decoder.end();
          if (text) onData(Buffer.from(text, 'utf8'));
        });
      }
      const close = new Promise<{ code: number | null }>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve({ code }));
      });
      let closed = false;
      void close
        .finally(() => {
          closed = true;
        })
        .catch(() => {
          /* Main await handles spawn failures. */
        });
      try {
        await ctx.onProcessSpawned?.();
      } catch {
        if (nativeGroup) await waitForClose(nativeGroup.ready, 1000);
        stopProcessTree(child, nativeGroup);
        if (!(await waitForClose(close, 2000))) {
          forceProcessTree(child, nativeGroup);
          await waitForClose(close, 3000);
        }
        if (descriptor !== undefined) fs.closeSync(descriptor);
        throw new KapibalaError('Process started but spawn audit failed', {
          code: 'OUTCOME_UNKNOWN',
          retryPolicy: 'after_user_action',
          safeMessage: 'Command started but audit failed; outcome is unknown',
        });
      }
      let stopReason: 'timeout' | 'aborted' | undefined;
      let stopPromise: Promise<boolean> | undefined;
      const stop = (reason: 'timeout' | 'aborted'): void => {
        if (stopPromise) return;
        stopReason = reason;
        stopPromise = (async () => {
          if (nativeGroup) await waitForClose(nativeGroup.ready, 1000);
          const stopped = stopProcessTree(child, nativeGroup);
          if (await waitForClose(close, 2000)) {
            if (await confirmProcessTreeStopped(child, stopped, nativeGroup)) return true;
          }
          const forced = forceProcessTree(child, nativeGroup);
          if (!(await waitForClose(close, 3000))) return false;
          return confirmProcessTreeStopped(child, forced, nativeGroup);
        })();
      };
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      const progressTimer = setInterval(() => {
        const now = Date.now();
        if (now - lastProgressAt >= 500) {
          lastProgressAt = now;
          ctx.onProgress?.({ elapsedMs: now - startedAt, outputBytes });
        }
      }, 500);
      const onAbort = () => stop('aborted');
      if (ctx.signal?.aborted) onAbort();
      else ctx.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const outcome = await Promise.race([
          close.then((value) => ({ kind: 'closed' as const, value })),
          new Promise<{ kind: 'unknown' }>((resolve) => {
            const check = () => {
              if (closed) return;
              if (stopPromise)
                void stopPromise.then((confirmed) => {
                  if (!confirmed) resolve({ kind: 'unknown' });
                });
              else setTimeout(check, 10);
            };
            check();
          }),
        ]);
        if (outcome.kind === 'unknown') {
          throw new KapibalaError('Command process tree could not be confirmed stopped', {
            code: 'OUTCOME_UNKNOWN',
            retryPolicy: 'after_user_action',
            safeMessage: 'Command outcome is unknown; inspect the system before retrying',
          });
        }
        if (stopReason) {
          if (!(await stopPromise)) {
            throw new KapibalaError('Command process tree could not be confirmed stopped', {
              code: 'OUTCOME_UNKNOWN',
              retryPolicy: 'after_user_action',
              safeMessage: 'Command outcome is unknown; inspect the system before retrying',
            });
          }
          throw new KapibalaError(`Command ${stopReason}`, {
            code: stopReason === 'timeout' ? 'COMMAND_TIMEOUT' : 'ABORTED',
            retryPolicy: 'after_user_action',
            safeMessage: `Command ${stopReason}; process exit was observed`,
          });
        }
        if (outputFailure) {
          throw new KapibalaError('Command output storage failed', {
            code: 'OUTPUT_STORAGE_FAILED',
            retryPolicy: 'after_user_action',
            safeMessage: 'Command finished but its output could not be stored',
          });
        }
        const inlineBuffer = Buffer.concat(inline);
        // 内联缓冲可能止于多字节字符中间，只回填完整的 UTF-8 字符。
        const output = utf8Prefix(inlineBuffer, INLINE_LIMIT).toString('utf8');
        return {
          exitCode: outcome.value.code,
          output,
          outputTruncated: outputBytes > INLINE_LIMIT,
          ...(outputFile ? { outputFile } : {}),
          outputFileTruncated,
          outputBytes,
          shell: environment.kind,
        };
      } finally {
        clearTimeout(timer);
        clearInterval(progressTimer);
        ctx.signal?.removeEventListener('abort', onAbort);
        if (descriptor !== undefined) fs.closeSync(descriptor);
      }
    },
  });
}
