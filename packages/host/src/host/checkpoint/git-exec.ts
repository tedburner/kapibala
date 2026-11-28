/**
 * @fileoverview Shadow Git 洁净子进程执行器、高危根目录门禁与 UTF-8 边界裁剪工具。
 *
 * 安全与跨平台约束：
 * - 严禁直接透传宿主 `process.env`：必须剥离全部继承的 `GIT_*` 仓库定位变量、`NODE_OPTIONS`
 *   与 `ELECTRON_RUN_AS_NODE`，防止父进程处在外层 Git Hook、子模块或 Electron 宿主时串改侧挂库；
 * - 统一注入 `GIT_TERMINAL_PROMPT=0` 与空 `GIT_ASKPASS`，杜绝子进程阻塞等待交互式凭据弹窗；
 * - Windows 强制启用 `-c core.longpaths=true` 与 `windowsHide: true`，且全程 `shell: false`。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSamePath, toNativePhysicalPath } from '@kiturone/kapibala';
import { CheckpointError } from './types.js';

/** 必须从继承环境中大小写不敏感剥离的敏感 Git 与运行时注入变量集合。 */
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

/** 禁止启用全盘扫描型检查点的用户目录相对子路径集合（仅精确匹配该目录自身，不拦截其下深层受管工作区或临时子目录）。 */
const UNSAFE_HOME_SUBDIRS = [
  'Desktop',
  'Documents',
  'Downloads',
  'Library',
  'AppData',
  path.join('AppData', 'Roaming'),
  path.join('AppData', 'Local'),
  path.join('AppData', 'LocalLow'),
] as const;

const POSIX_SYSTEM_ROOTS = [
  '/Users',
  '/home',
  '/etc',
  '/var',
  '/private/etc',
  '/private/var',
] as const;

/**
 * 构造供 `git` 子进程使用的洁净环境变量表。
 *
 * 前置约束：`overrides` 在清洗完成后叠加（如显式传入临时 `GIT_INDEX_FILE`），不会被误剥离；
 * 同时注入内部提交身份兜底，避免未配置全局 `~/.gitconfig` 的 CI 或新机器在 `commit-tree` 时报身份缺失。
 */
export function buildCleanGitEnv(
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
  clean.GIT_AUTHOR_NAME = 'Kapibala Checkpoint';
  clean.GIT_AUTHOR_EMAIL = 'checkpoint@kapibala.local';
  clean.GIT_COMMITTER_NAME = 'Kapibala Checkpoint';
  clean.GIT_COMMITTER_EMAIL = 'checkpoint@kapibala.local';

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
 * 计算 `executionRoot` 的 16 位十六进制分桶摘要（`sha256_16`）。
 *
 * 约束：Windows 下统一折叠为正斜杠与小写，保证大小写变体或 8.3 短路径展开后落入同一检查点桶。
 */
export function computeExecutionRootHash(canonicalExecutionRoot: string): string {
  const normalized =
    process.platform === 'win32'
      ? canonicalExecutionRoot.replaceAll('\\', '/').toLowerCase()
      : canonicalExecutionRoot;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * 将任意 `sessionId` 转换为合法、无目录穿越且无 Git 引用冲突的单一路径段。
 *
 * 取舍：对已是安全短 ASCII 标识符（字母数字、横杠、下划线）的会话 ID 保留可读前缀并附短摘要防碰撞，
 * 非法字符一律哈希化，杜绝 `..`、`.lock` 后缀或斜杠引发的 Git 引用 D/F 冲突。
 */
export function toSafeRefSegment(sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
  const cleaned = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').replace(/\.lock$/i, '_lock');
  const prefix = cleaned.slice(0, 36) || 'session';
  return `${prefix}-${digest}`;
}

function matchesUnsafeTarget(canonicalExecutionRoot: string, rawCandidate: string): boolean {
  if (!rawCandidate) return false;
  if (isSamePath(canonicalExecutionRoot, rawCandidate)) return true;
  try {
    const resolved = toNativePhysicalPath(path.resolve(rawCandidate));
    return isSamePath(canonicalExecutionRoot, resolved);
  } catch {
    return false;
  }
}

/**
 * 判定给定物理执行根是否属于禁止启用检查点的高危系统或个人根目录。
 *
 * 拦截范围（均采用精确目录身份比对，不误伤 `$HOME/AppData/Local/Temp/<dir>` 或 `~/.kapibala/workspaces/default` 等深层工作区）：
 * 1. 文件系统盘符根与 UNC 根（`/`、`C:\`）；
 * 2. 操作系统级共享根（`C:\Windows`、`C:\Users`、`/Users`、`/home`、`/etc`、`/var`）；
 * 3. 用户主目录 `$HOME` 本身、`%APPDATA%`、`%LOCALAPPDATA%`；
 * 4. `$HOME/{Desktop,Documents,Downloads,Library,AppData}` 及 `$HOME/AppData/{Roaming,Local,LocalLow}` 目录本身。
 */
export function isUnsafeCheckpointRoot(
  canonicalExecutionRoot: string,
  homeDir = os.homedir(),
  baseEnv: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const parsed = path.parse(canonicalExecutionRoot);
  if (
    parsed.root === canonicalExecutionRoot ||
    path.dirname(canonicalExecutionRoot) === canonicalExecutionRoot
  ) {
    return true;
  }

  if (process.platform === 'win32' || /^[A-Za-z]:[\\/]/.test(canonicalExecutionRoot)) {
    const driveRoot = parsed.root || 'C:\\';
    for (const sysCandidate of [
      path.win32.join(driveRoot, 'Windows'),
      path.win32.join(driveRoot, 'Users'),
      'C:\\Windows',
      'C:\\Users',
    ]) {
      if (matchesUnsafeTarget(canonicalExecutionRoot, sysCandidate)) {
        return true;
      }
    }
  }

  for (const posixRoot of POSIX_SYSTEM_ROOTS) {
    if (matchesUnsafeTarget(canonicalExecutionRoot, posixRoot)) {
      return true;
    }
  }

  for (const envKey of ['APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT', 'WINDIR']) {
    const envVal = baseEnv[envKey]?.trim();
    if (envVal && matchesUnsafeTarget(canonicalExecutionRoot, envVal)) {
      return true;
    }
  }

  let canonicalHome: string;
  try {
    canonicalHome = toNativePhysicalPath(path.resolve(homeDir));
  } catch {
    return false;
  }

  if (isSamePath(canonicalExecutionRoot, canonicalHome)) {
    return true;
  }

  for (const sub of UNSAFE_HOME_SUBDIRS) {
    const candidate = path.join(canonicalHome, sub);
    if (matchesUnsafeTarget(canonicalExecutionRoot, candidate)) {
      return true;
    }
  }
  return false;
}

/**
 * 检查点 `git` 子进程调用配置：
 * 传入 `--work-tree <executionRoot>` 的命令必须显式将 `cwd` 设为 `<executionRoot>` 以防子目录 `prefix` 偏移，
 * 裸仓命令则应显式传入 `sideGitDir` 或 `os.tmpdir()` 以防进程当前目录已被删除。
 */
export interface RunGitOptions {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly input?: Buffer | string;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly envOverrides?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** 允许的非零退出码集合（如 `check-ignore` 无命中时返回 1）；未列出的非零码抛 `CheckpointError`。 */
  readonly allowedExitCodes?: readonly number[];
  /** 标准输出最大采集字节上限；超出后立即中止读取并终止子进程（用于超大单文件 Patch 流式限流）。 */
  readonly maxStdoutBytes?: number;
}

/** 检查点 `git` 子进程原始二进制输出与流截断标记；达 `maxStdoutBytes` 提前终止时 `stdoutTruncated` 为 `true`。 */
export interface RunGitResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
}

/**
 * 以 `shell: false` 启动洁净 `git` 子进程并采集二进制输出。
 *
 * 失败边界：
 * - 找不到 `git` 可执行文件（`ENOENT`）时抛 `CHECKPOINT_GIT_UNAVAILABLE`；
 * - 超时或收到 `AbortSignal` 时立即终止子进程并抛出带 `TIMEOUT` / `ABORTED` 语义的异常；
 * - 退出码不在 `allowedExitCodes`（默认 `[0]`）内时抛 `CHECKPOINT_GIT_FAILED`。
 */
export async function runGit(options: RunGitOptions): Promise<RunGitResult> {
  if (options.signal?.aborted) {
    throw new CheckpointError('CHECKPOINT_GIT_FAILED', 'Git command aborted before spawn');
  }

  const fullArgs =
    process.platform === 'win32'
      ? ['-c', 'core.longpaths=true', ...options.args]
      : [...options.args];
  const env = buildCleanGitEnv(options.baseEnv, options.envOverrides);
  const allowed = new Set(options.allowedExitCodes ?? [0]);

  let effectiveCwd = options.cwd;
  if (effectiveCwd === undefined) {
    try {
      const procCwd = process.cwd();
      effectiveCwd = fs.existsSync(procCwd) ? procCwd : os.tmpdir();
    } catch {
      effectiveCwd = os.tmpdir();
    }
  }

  return new Promise<RunGitResult>((resolve, reject) => {
    const child = spawn('git', fullArgs, {
      cwd: effectiveCwd,
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
    let aborted = false;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (options.signal && onAbort) {
        options.signal.removeEventListener('abort', onAbort);
      }
      fn();
    };

    const killChild = () => {
      try {
        child.kill();
      } catch {
        /* 进程已退出时忽略。 */
      }
    };

    const timer =
      options.timeoutMs !== undefined && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killChild();
          }, options.timeoutMs)
        : undefined;

    const onAbort = options.signal
      ? () => {
          aborted = true;
          killChild();
        }
      : undefined;

    if (options.signal && onAbort) {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() => {
        if (err.code === 'ENOENT') {
          reject(new CheckpointError('CHECKPOINT_GIT_UNAVAILABLE', 'Git executable not found'));
          return;
        }
        reject(new CheckpointError('CHECKPOINT_GIT_FAILED', `Failed to spawn git: ${err.message}`));
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
      /* 子进程提前关闭管道时由 close 事件统一收敛退出状态，避免 EPIPE 未捕获崩溃。 */
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }

    child.on('close', (code) => {
      finish(() => {
        if (timedOut) {
          const err = new CheckpointError(
            'CHECKPOINT_GIT_FAILED',
            `Git command timed out after ${options.timeoutMs}ms`,
            'backoff',
          );
          (err as CheckpointError & { isTimeout?: boolean }).isTimeout = true;
          reject(err);
          return;
        }
        if (aborted) {
          reject(new CheckpointError('CHECKPOINT_GIT_FAILED', 'Git command aborted'));
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
            new CheckpointError(
              'CHECKPOINT_GIT_FAILED',
              `git ${options.args[0] ?? ''} exited with code ${exitCode}${stderr ? `: ${stderr}` : ''}`,
            ),
          );
          return;
        }
        resolve({ exitCode, stdout, stderr, stdoutTruncated: false });
      });
    });
  });
}

/** 解析 `-z` 输出的 NUL 分隔 UTF-8 路径流，自动过滤尾随空项。 */
export function splitNulStrings(buffer: Buffer): string[] {
  if (buffer.length === 0) return [];
  const raw = buffer.toString('utf8');
  const parts = raw.split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

/**
 * 在 UTF-8 码点边界安全裁剪二进制 Buffer，绝不切裂多字节字符产生 `U+FFFD` 乱码。
 *
 * 算法：若 `buf[maxBytes]` 为 UTF-8 续字节（`0b10xxxxxx`），向前回退至该多字节字符的首字节前截断。
 */
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
