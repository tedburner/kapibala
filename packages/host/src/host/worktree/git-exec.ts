/**
 * @fileoverview 受管 Git Worktree 洁净子进程执行器与分支名规范化辅助函数。
 *
 * 安全不变量：
 * - 执行 `git` 子进程前统一剥离宿主继承的 `GIT_*`、`NODE_OPTIONS` 与 `ELECTRON_RUN_AS_NODE` 环境变量；
 * - 强制 `GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=""`、`windowsHide: true` 与 `shell: false`；
 * - Windows 自动前置 `-c core.longpaths=true`，防止深层 `node_modules` 或构建路径超出传统 260 字符上限。
 */

import { spawn } from 'node:child_process';
import { WorktreeError } from './types.js';

const SCRUBBED_ENV_KEYS_UPPER = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
  'GIT_PREFIX',
  'GIT_SUPER_PREFIX',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
]);

/**
 * 构造供工作树 `git` 子进程使用的洁净环境变量表（保留用户自身 `GIT_AUTHOR_*` 若已显式配置，仅剥离仓库定位污染）。
 */
export function buildWorktreeGitEnv(
  baseEnv: Readonly<Record<string, string | undefined>> = process.env,
  overrides?: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (SCRUBBED_ENV_KEYS_UPPER.has(key.toUpperCase())) continue;
    clean[key] = value;
  }
  clean.GIT_TERMINAL_PROMPT = '0';
  clean.GIT_ASKPASS = '';
  clean.SSH_ASKPASS = '';
  clean.GCM_INTERACTIVE = 'never';
  clean.LC_ALL = 'C';

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete clean[key];
      } else {
        clean[key] = value;
      }
    }
  }
  return clean;
}

/**
 * 工作树 `git` 子进程调用配置：要求调用方显式指定存在的仓库/工作树 `cwd`，
 * 未列入 `allowedExitCodes`（默认 `[0]`）的退出码将抛 `WorktreeError('WORKTREE_GIT_FAILED')`。
 */
export interface RunWorktreeGitOptions {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly input?: Buffer | string;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly envOverrides?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly allowedExitCodes?: readonly number[];
  readonly maxStdoutBytes?: number;
}

/**
 * 工作树 `git` 子进程采集结果；当输出达到 `maxStdoutBytes` 上限时提前终止子进程并置 `stdoutTruncated: true`（`exitCode` 归一为 `0`）。
 */
export interface RunWorktreeGitResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
}

/**
 * 以 `shell: false` 启动环境已清洗的 `git` 子进程：缺失可执行文件时抛 `WORKTREE_GIT_UNAVAILABLE`，超时或非允许退出码抛 `WORKTREE_GIT_FAILED`。
 */
export async function runWorktreeGit(
  options: RunWorktreeGitOptions,
): Promise<RunWorktreeGitResult> {
  const fullArgs =
    process.platform === 'win32'
      ? ['-c', 'core.longpaths=true', '-c', 'core.quotepath=false', ...options.args]
      : ['-c', 'core.quotepath=false', ...options.args];
  const env = buildWorktreeGitEnv(options.baseEnv, options.envOverrides);
  const allowed = new Set(options.allowedExitCodes ?? [0]);

  return new Promise<RunWorktreeGitResult>((resolve, reject) => {
    const child = spawn('git', fullArgs, {
      cwd: options.cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      fn();
    };

    const killChild = () => {
      try {
        child.kill();
      } catch {
        /* 已退出时忽略。 */
      }
    };

    const timer =
      options.timeoutMs !== undefined && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killChild();
          }, options.timeoutMs)
        : undefined;

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() => {
        if (err.code === 'ENOENT') {
          reject(new WorktreeError('WORKTREE_GIT_UNAVAILABLE', 'Git executable not found'));
          return;
        }
        reject(new WorktreeError('WORKTREE_GIT_FAILED', `Failed to spawn git: ${err.message}`));
      });
    });

    child.stdout.on('data', (chunk: Buffer) => {
      if (options.maxStdoutBytes !== undefined && stdoutBytes >= options.maxStdoutBytes) {
        stdoutTruncated = true;
        killChild();
        return;
      }
      if (
        options.maxStdoutBytes !== undefined &&
        stdoutBytes + chunk.length > options.maxStdoutBytes
      ) {
        const remain = options.maxStdoutBytes - stdoutBytes;
        stdoutChunks.push(chunk.subarray(0, remain));
        stdoutBytes += remain;
        stdoutTruncated = true;
        killChild();
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes < 16 * 1024) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    child.stdin.on('error', () => {
      /* 忽略提前关闭管道引发的 EPIPE。 */
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }

    child.on('close', (code) => {
      finish(() => {
        if (timedOut) {
          reject(
            new WorktreeError(
              'WORKTREE_GIT_FAILED',
              `Git command timed out after ${options.timeoutMs}ms`,
              'backoff',
            ),
          );
          return;
        }
        const stdout = Buffer.concat(stdoutChunks, stdoutBytes);
        if (stdoutTruncated) {
          resolve({ exitCode: 0, stdout, stderr: '', stdoutTruncated: true });
          return;
        }
        const exitCode = code ?? 1;
        const stderr = Buffer.concat(stderrChunks, stderrBytes).toString('utf8').trim();
        if (!allowed.has(exitCode)) {
          reject(
            new WorktreeError(
              'WORKTREE_GIT_FAILED',
              `git ${options.args.join(' ')} exited with code ${exitCode}${stderr ? `: ${stderr}` : ''}`,
            ),
          );
          return;
        }
        resolve({ exitCode, stdout, stderr, stdoutTruncated: false });
      });
    });
  });
}

/** 解析 Git `-z` 输出的 NUL 分隔 UTF-8 字节流，仅剥离末尾终止空串并保留中间合法项。 */
export function splitNulStrings(buffer: Buffer): string[] {
  if (buffer.length === 0) return [];
  const parts = buffer.toString('utf8').split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

/**
 * 将自由文本（任务描述或仓库目录名）压缩为 ≤ 36 字符的小写 ASCII 短段，并改写尾随 `.lock` 防碰撞 Git 引用锁文件。
 */
export function sanitizeWorktreeSlug(input: string | undefined, fallback = 'task'): string {
  if (!input) return fallback;
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/\.lock$/i, '-lock')
    .slice(0, 36)
    .replace(/-+$/g, '');
  return cleaned || fallback;
}

/** 在 UTF-8 码点边界安全裁剪 Patch 缓冲，避免产生半截多字节字符。 */
export function truncateUtf8Safe(
  buf: Buffer,
  maxBytes: number,
): { readonly text: string; readonly byteLength: number; readonly truncated: boolean } {
  if (buf.length <= maxBytes) {
    return { text: buf.toString('utf8'), byteLength: buf.length, truncated: false };
  }
  if (maxBytes <= 0) {
    return { text: '', byteLength: 0, truncated: true };
  }
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  const sliced = buf.subarray(0, end);
  return {
    text: sliced.toString('utf8'),
    byteLength: sliced.length,
    truncated: true,
  };
}
