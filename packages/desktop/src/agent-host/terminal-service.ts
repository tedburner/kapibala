/**
 * 会话级保活伪终端宿主服务（运行于 `agent-host` utilityProcess）。
 *
 * 设计取舍与安全边界（设计 018 §6.2 & §10.2 决策 1）：
 * - 采用 `await import('node-pty')` 延迟加载原生模块；当预编译二进制缺失或加载异常时返回 `status: 'unavailable'`，
 *   绝不拖垮 `agent-host` 主通道或影响对话流；
 * - 严格在宿主侧校验 `shellId` 白名单（仅允许本机探测到的已知交互式 Shell），拒绝渲染进程传入任意可执行文件路径；
 * - Windows 优先走 `useConpty: true, useConptyDll: true`，若遇旧系统 DLL 加载异常（如错误码 126）自动回退系统内置 ConPTY；
 *   macOS 首次启动前自动自愈 `app.asar.unpacked/.../spawn-helper` 的 `0o755` 可执行权限位；
 * - 配额硬上限：单会话最多 `MAX_SESSION_TERMINALS = 3` 个终端，全宿主最多 `MAX_LIVE_TERMINALS = 8` 个存活 PTY 进程。
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { KapibalaError, isSamePath } from '@kiturone/kapibala';
import {
  MAX_SNAPSHOT_REPLAY_TOTAL_BYTES,
  type TerminalDataBatcher,
  type TerminalReplayBuffer,
  appendTerminalReplay,
  clearTerminalReplay,
  createTerminalDataBatcher,
  createTerminalReplayBuffer,
  readTerminalReplayText,
  sliceReplayTailByJsonBytes,
} from './terminal-replay.js';

/** 全宿主允许同时存活的伪终端子进程硬上限。 */
export const MAX_LIVE_TERMINALS = 8;

/** 单个会话允许同时保活的终端标签硬上限。 */
export const MAX_SESSION_TERMINALS = 3;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MIN_COLS = 2;
const MAX_COLS = 500;
const MIN_ROWS = 1;
const MAX_ROWS = 200;

/** 最小化 `node-pty` 进程句柄契约，解耦静态顶层导入以便懒加载与测试替身注入。 */
export interface PtyProcessLike {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void } | undefined;
  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): { dispose(): void } | undefined;
}

/** 最小化 `node-pty` 模块契约。 */
export interface PtyModuleLike {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
      useConpty?: boolean;
      useConptyDll?: boolean;
    },
  ): PtyProcessLike;
}

/** 可选交互式 Shell 候选项（仅暴露稳定短 ID 与展示名，可执行文件绝对路径留在宿主进程内）。 */
export interface TerminalShellCandidate {
  readonly id: string;
  readonly label: string;
  readonly executable: string;
  readonly args: readonly string[];
}

/** 向渲染层投影的单个终端状态快照。 */
export interface TerminalInstanceSnapshot {
  readonly id: string;
  readonly title: string;
  readonly cwdLabel: string;
  readonly shell: string;
  readonly status: 'starting' | 'running' | 'exited' | 'unavailable';
  readonly exitCode?: number | null;
  readonly replayBuffer: string;
  readonly unavailableReason?: string;
}

/** 向渲染层投影的会话终端集合快照。 */
export interface TerminalSessionSnapshot {
  readonly terminals: readonly TerminalInstanceSnapshot[];
  readonly activeTerminalId?: string;
  readonly shells: readonly { readonly id: string; readonly label: string }[];
  readonly unavailableReason?: string;
}

/** 终端实时流式通知回调载荷。 */
export type TerminalServiceEvent =
  | {
      readonly type: 'data';
      readonly workspaceId: string;
      readonly sessionKey: string;
      readonly terminalId: string;
      readonly data: string;
    }
  | {
      readonly type: 'exit';
      readonly workspaceId: string;
      readonly sessionKey: string;
      readonly terminalId: string;
      readonly exitCode: number | null;
    };

/** `TerminalService` 构造选项。 */
export interface TerminalServiceOptions {
  readonly hostEnv?: NodeJS.ProcessEnv;
  readonly onEvent?: (event: TerminalServiceEvent) => void;
  /** 可选注入伪终端模块加载器，缺省走 `await import('node-pty')`。 */
  readonly ptyLoader?: () => Promise<PtyModuleLike>;
  /** 可选注入 Shell 候选探测器，缺省扫描当前操作系统标准解释器。 */
  readonly shellDetector?: () => readonly TerminalShellCandidate[];
  readonly batchIntervalMs?: number;
  /** 可选注入进程树异步清理钩子（测试替身用；生产在 Windows 下缺省执行异步 `taskkill /T /F`）。 */
  readonly processTreeKiller?: (pid: number) => Promise<void>;
}

interface ManagedTerminalEntry {
  readonly id: string;
  readonly workspaceId: string;
  readonly sessionKey: string;
  readonly title: string;
  readonly cwd: string;
  readonly cwdLabel: string;
  readonly shellId: string;
  readonly shellLabel: string;
  status: 'running' | 'exited' | 'unavailable';
  exitCode?: number | null;
  unavailableReason?: string;
  readonly replay: TerminalReplayBuffer;
  readonly batcher: TerminalDataBatcher;
  pid?: number;
  treeKilled?: boolean;
  pty?: PtyProcessLike;
  dataSub?: { dispose(): void };
  exitSub?: { dispose(): void };
  exitPromise?: Promise<void>;
  resolveExit?: () => void;
}

const POISON_ENV_KEYS = new Set([
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'NODE_OPTIONS',
  'KPBL_EXTERNAL_FORWARDED_ENV',
  'KPBL_DESKTOP_DEV_TOKEN',
  'KPBL_DESKTOP_E2E',
  'KPBL_DESKTOP_HOME',
  'KPBL_DESKTOP_USER_DATA',
]);

function clampCols(cols?: number): number {
  if (cols === undefined || !Number.isFinite(cols)) return DEFAULT_COLS;
  return Math.min(MAX_COLS, Math.max(MIN_COLS, Math.floor(cols)));
}

function clampRows(rows?: number): number {
  if (rows === undefined || !Number.isFinite(rows)) return DEFAULT_ROWS;
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.floor(rows)));
}

function findExecutableInPath(binaryName: string, rawPath: string | undefined): string | undefined {
  if (!rawPath) return undefined;
  for (const segment of rawPath.split(path.delimiter)) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const candidate = path.join(trimmed, binaryName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** 探测本机真实存在的可信交互式 Shell 清单。 */
export function detectInteractiveShells(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): readonly TerminalShellCandidate[] {
  const candidates: TerminalShellCandidate[] = [];
  const seenPaths = new Set<string>();
  const pushIfExists = (
    id: string,
    label: string,
    executable: string | undefined,
    args: string[],
  ) => {
    if (!executable || !fs.existsSync(executable)) return;
    const key = platform === 'win32' ? executable.toLowerCase() : executable;
    if (seenPaths.has(key)) return;
    seenPaths.add(key);
    candidates.push({ id, label, executable, args });
  };

  if (platform === 'win32') {
    const sysRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows';
    pushIfExists('pwsh', 'PowerShell 7 (pwsh)', findExecutableInPath('pwsh.exe', env.PATH), [
      '-NoLogo',
    ]);
    pushIfExists(
      'powershell',
      'Windows PowerShell',
      path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo'],
    );
    pushIfExists(
      'cmd',
      'Command Prompt (cmd)',
      env.COMSPEC || path.join(sysRoot, 'System32', 'cmd.exe'),
      [],
    );
    pushIfExists('git-bash', 'Git Bash', findExecutableInPath('bash.exe', env.PATH), ['--login']);
    return candidates;
  }

  if (env.SHELL && path.isAbsolute(env.SHELL)) {
    const base = path.basename(env.SHELL);
    pushIfExists(`env-${base}`, `${base} (默认)`, env.SHELL, ['-l']);
  }
  pushIfExists('zsh', 'zsh', '/bin/zsh', ['-l']);
  pushIfExists('bash', 'bash', '/bin/bash', ['-l']);
  pushIfExists('homebrew-fish', 'fish', '/opt/homebrew/bin/fish', ['-l']);
  pushIfExists('local-fish', 'fish', '/usr/local/bin/fish', ['-l']);
  pushIfExists('sh', 'sh', '/bin/sh', []);
  return candidates;
}

/** 构造净化后的交互式终端子进程环境变量表。 */
export function buildSanitizedTerminalEnv(
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (POISON_ENV_KEYS.has(key) || key.startsWith('VSCODE_')) continue;
    clean[key] = value;
  }
  clean.TERM = 'xterm-256color';
  clean.COLORTERM = 'truecolor';

  if (platform !== 'win32') {
    if (!clean.LANG && !clean.LC_ALL) {
      clean.LANG = 'en_US.UTF-8';
    }
    if (platform === 'darwin') {
      const existingParts = (clean.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin').split(':');
      for (const extra of ['/usr/local/bin', '/opt/homebrew/bin']) {
        if (!existingParts.includes(extra) && fs.existsSync(extra)) {
          existingParts.unshift(extra);
        }
      }
      clean.PATH = existingParts.join(':');
    }
  }
  return clean;
}

let spawnHelperChecked = false;

/**
 * macOS 打包解包后 `spawn-helper` 可能丢失可执行权限位导致 `posix_spawnp failed`：
 * 在首次调用 `node-pty` 前按 `app.asar.unpacked` 实际路径补齐 `0o755`。
 */
function ensureDarwinSpawnHelperExecutable(): void {
  if (spawnHelperChecked || process.platform !== 'darwin') return;
  spawnHelperChecked = true;
  try {
    const req = createRequire(import.meta.url);
    const pkgJsonPath = req.resolve('node-pty/package.json');
    const pkgDir = path.dirname(pkgJsonPath).replace('app.asar', 'app.asar.unpacked');
    const helperCandidates = [
      path.join(pkgDir, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper'),
      path.join(pkgDir, 'build', 'Release', 'spawn-helper'),
    ];
    for (const helper of helperCandidates) {
      if (!fs.existsSync(helper)) continue;
      const stat = fs.statSync(helper);
      if ((stat.mode & 0o111) === 0) {
        fs.chmodSync(helper, 0o755);
      }
    }
  } catch {
    // 非打包环境或路径不存在时忽略，交由后续 spawn 真实诊断。
  }
}

async function defaultLoadNodePty(): Promise<PtyModuleLike> {
  ensureDarwinSpawnHelperExecutable();
  const mod = (await import('node-pty')) as unknown as PtyModuleLike & {
    default?: PtyModuleLike;
  };
  return mod.default ?? mod;
}

function shouldRetryWithoutConptyDll(error: unknown): boolean {
  if (process.platform !== 'win32') return false;
  const text = error instanceof Error ? error.message : String(error);
  return /conpty|126|AttachConsole|openconsole/i.test(text);
}

/**
 * Windows 下异步调用 `taskkill /T /F /PID <pid>` 清理伪终端整棵进程树（3s 超时封顶，绝不阻塞 `agent-host` 事件循环）。
 */
function killWindowsProcessTree(pid: number, env: Record<string, string>): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 3_000);
    try {
      const child = execFile(
        'taskkill',
        ['/T', '/F', '/PID', String(pid)],
        { windowsHide: true, env },
        () => finish(),
      );
      child.on('error', finish);
    } catch {
      finish();
    }
  });
}

function createTerminalLimitError(message: string): KapibalaError {
  return new KapibalaError(message, {
    code: 'TERMINAL_LIMIT_REACHED',
    retryPolicy: 'after_user_action',
    safeMessage: message,
  });
}

/**
 * 桌面宿主会话级保活终端服务。
 */
export class TerminalService {
  private readonly hostEnv: NodeJS.ProcessEnv;
  private readonly onEvent?: (event: TerminalServiceEvent) => void;
  private readonly ptyLoader: () => Promise<PtyModuleLike>;
  private readonly shellDetector: () => readonly TerminalShellCandidate[];
  private readonly batchIntervalMs?: number;
  private readonly processTreeKiller?: (pid: number) => Promise<void>;
  private readonly bySession = new Map<string, ManagedTerminalEntry[]>();
  private readonly activeBySession = new Map<string, string>();
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly sessionInvalidationEpoch = new Map<string, number>();
  private cachedPtyPromise?: Promise<PtyModuleLike>;
  private disposed = false;

  constructor(options: TerminalServiceOptions = {}) {
    this.hostEnv = options.hostEnv ?? process.env;
    this.onEvent = options.onEvent;
    this.ptyLoader = options.ptyLoader ?? defaultLoadNodePty;
    this.shellDetector = options.shellDetector ?? (() => detectInteractiveShells(this.hostEnv));
    this.batchIntervalMs = options.batchIntervalMs;
    this.processTreeKiller = options.processTreeKiller;
  }

  /** 当前存活中的底层伪终端子进程总数（已退出或降级项不占用进程配额）。 */
  liveCount(): number {
    let total = 0;
    for (const list of this.bySession.values()) {
      for (const item of list) {
        if (item.status === 'running' && item.pty) total += 1;
      }
    }
    return total;
  }

  /** 返回当前平台可用的受信任交互式 Shell 列表。 */
  listShells(): readonly { readonly id: string; readonly label: string }[] {
    return this.shellDetector().map(({ id, label }) => ({ id, label }));
  }

  /**
   * 幂等确保指定会话拥有至少一个终端实例并回传完整回放快照：
   * 按 `sessionKey` 串行互斥，并发调用共享同一次初始化而不会重复拉起双份 PTY。
   */
  async ensure(input: {
    readonly workspaceId: string;
    readonly sessionKey: string;
    readonly cwd: string;
    readonly cwdLabel?: string;
    readonly shellId?: string;
    readonly cols?: number;
    readonly rows?: number;
  }): Promise<TerminalSessionSnapshot> {
    if (this.disposed) throw new Error('HOST_UNAVAILABLE');
    const startEpoch = this.sessionInvalidationEpoch.get(input.sessionKey) ?? 0;
    return await this.withSessionLock(input.sessionKey, async () => {
      if (this.disposed) throw new Error('HOST_UNAVAILABLE');
      if ((this.sessionInvalidationEpoch.get(input.sessionKey) ?? 0) !== startEpoch) {
        return this.snapshotSession(input.sessionKey);
      }
      const existing = this.bySession.get(input.sessionKey);
      if (existing && existing.length > 0) {
        return this.snapshotSession(input.sessionKey);
      }
      return await this.createUnlocked(input, startEpoch);
    });
  }

  /**
   * 在会话内新建子终端，或通过 `replaceTerminalId` 原地重拉已退出/不可用的终端实例。
   */
  async create(input: {
    readonly workspaceId: string;
    readonly sessionKey: string;
    readonly cwd: string;
    readonly cwdLabel?: string;
    readonly shellId?: string;
    readonly replaceTerminalId?: string;
    readonly cols?: number;
    readonly rows?: number;
  }): Promise<TerminalSessionSnapshot> {
    if (this.disposed) throw new Error('HOST_UNAVAILABLE');
    const startEpoch = this.sessionInvalidationEpoch.get(input.sessionKey) ?? 0;
    return await this.withSessionLock(input.sessionKey, () =>
      this.createUnlocked(input, startEpoch),
    );
  }

  private async createUnlocked(
    input: {
      readonly workspaceId: string;
      readonly sessionKey: string;
      readonly cwd: string;
      readonly cwdLabel?: string;
      readonly shellId?: string;
      readonly replaceTerminalId?: string;
      readonly cols?: number;
      readonly rows?: number;
    },
    startEpoch: number,
  ): Promise<TerminalSessionSnapshot> {
    if (this.disposed) throw new Error('HOST_UNAVAILABLE');
    if ((this.sessionInvalidationEpoch.get(input.sessionKey) ?? 0) !== startEpoch) {
      return this.snapshotSession(input.sessionKey);
    }
    if (!fs.existsSync(input.cwd)) {
      return {
        terminals: this.snapshotSession(input.sessionKey).terminals,
        activeTerminalId: this.activeBySession.get(input.sessionKey),
        shells: this.listShells(),
        unavailableReason: `终端工作目录不存在：${path.basename(input.cwd)}`,
      };
    }

    const initialList = this.bySession.get(input.sessionKey) ?? [];
    const initialReplaceIndex = input.replaceTerminalId
      ? initialList.findIndex(
          (t) => t.id === input.replaceTerminalId && t.workspaceId === input.workspaceId,
        )
      : -1;

    if (initialReplaceIndex < 0 && initialList.length >= MAX_SESSION_TERMINALS) {
      throw createTerminalLimitError(`单会话最多同时开启 ${MAX_SESSION_TERMINALS} 个终端。`);
    }

    if (initialReplaceIndex >= 0) {
      const old = initialList[initialReplaceIndex]!;
      await this.teardownEntry(old);
      if (this.disposed) throw new Error('HOST_UNAVAILABLE');
      if ((this.sessionInvalidationEpoch.get(input.sessionKey) ?? 0) !== startEpoch) {
        return this.snapshotSession(input.sessionKey);
      }
    }

    if (this.liveCount() >= MAX_LIVE_TERMINALS) {
      throw createTerminalLimitError(
        `全局活跃终端已达上限（${MAX_LIVE_TERMINALS} 个），请先关闭闲置终端。`,
      );
    }

    const shells = this.shellDetector();
    const chosenShell =
      (input.shellId ? shells.find((s) => s.id === input.shellId) : undefined) ?? shells[0];

    const listBeforeLoad = this.bySession.get(input.sessionKey) ?? [];
    const replaceIdxBeforeLoad = input.replaceTerminalId
      ? listBeforeLoad.findIndex(
          (t) => t.id === input.replaceTerminalId && t.workspaceId === input.workspaceId,
        )
      : -1;
    const terminalId =
      replaceIdxBeforeLoad >= 0 ? listBeforeLoad[replaceIdxBeforeLoad]!.id : randomUUID();
    const ordinal =
      replaceIdxBeforeLoad >= 0 ? replaceIdxBeforeLoad + 1 : listBeforeLoad.length + 1;
    const cwdLabel = input.cwdLabel?.trim() || path.basename(input.cwd) || 'workspace';
    const title = `终端 ${ordinal} · ${cwdLabel}`;

    if (!chosenShell) {
      const unavailableEntry = this.createUnavailableEntry({
        id: terminalId,
        workspaceId: input.workspaceId,
        sessionKey: input.sessionKey,
        title,
        cwd: input.cwd,
        cwdLabel,
        reason: '未在当前系统探测到可用的交互式 Shell 解释器（TERMINAL_UNAVAILABLE）。',
      });
      this.installEntry(input.sessionKey, listBeforeLoad, replaceIdxBeforeLoad, unavailableEntry);
      return this.snapshotSession(input.sessionKey);
    }

    let ptyModule: PtyModuleLike;
    try {
      this.cachedPtyPromise ??= this.ptyLoader();
      ptyModule = await this.cachedPtyPromise;
    } catch (loadErr) {
      this.cachedPtyPromise = undefined;
      if (this.disposed) throw new Error('HOST_UNAVAILABLE');
      if ((this.sessionInvalidationEpoch.get(input.sessionKey) ?? 0) !== startEpoch) {
        return this.snapshotSession(input.sessionKey);
      }
      const listOnErr = this.bySession.get(input.sessionKey) ?? [];
      const replaceOnErr = input.replaceTerminalId
        ? listOnErr.findIndex(
            (t) => t.id === input.replaceTerminalId && t.workspaceId === input.workspaceId,
          )
        : -1;
      const reason = `当前平台未就绪伪终端原生扩展（TERMINAL_UNAVAILABLE）：${loadErr instanceof Error ? loadErr.message : String(loadErr)}`;
      const unavailableEntry = this.createUnavailableEntry({
        id: terminalId,
        workspaceId: input.workspaceId,
        sessionKey: input.sessionKey,
        title,
        cwd: input.cwd,
        cwdLabel,
        reason,
      });
      this.installEntry(input.sessionKey, listOnErr, replaceOnErr, unavailableEntry);
      return this.snapshotSession(input.sessionKey);
    }

    // 跨越异步模块加载点后同步复核宿主存活性、会话纪元、工作目录及双层配额，杜绝孤儿 PTY 与并发超额。
    if (this.disposed) throw new Error('HOST_UNAVAILABLE');
    if ((this.sessionInvalidationEpoch.get(input.sessionKey) ?? 0) !== startEpoch) {
      return this.snapshotSession(input.sessionKey);
    }
    if (!fs.existsSync(input.cwd)) {
      return {
        terminals: this.snapshotSession(input.sessionKey).terminals,
        activeTerminalId: this.activeBySession.get(input.sessionKey),
        shells: this.listShells(),
        unavailableReason: `终端工作目录不存在：${path.basename(input.cwd)}`,
      };
    }

    const list = this.bySession.get(input.sessionKey) ?? [];
    const replaceIndex = input.replaceTerminalId
      ? list.findIndex(
          (t) => t.id === input.replaceTerminalId && t.workspaceId === input.workspaceId,
        )
      : -1;
    if (replaceIndex < 0 && list.length >= MAX_SESSION_TERMINALS) {
      throw createTerminalLimitError(`单会话最多同时开启 ${MAX_SESSION_TERMINALS} 个终端。`);
    }
    if (this.liveCount() >= MAX_LIVE_TERMINALS) {
      throw createTerminalLimitError(
        `全局活跃终端已达上限（${MAX_LIVE_TERMINALS} 个），请先关闭闲置终端。`,
      );
    }

    const cols = clampCols(input.cols);
    const rows = clampRows(input.rows);
    const env = buildSanitizedTerminalEnv(this.hostEnv);

    let ptyProcess: PtyProcessLike;
    try {
      ptyProcess = this.spawnWithFallback(ptyModule, chosenShell, {
        cols,
        rows,
        cwd: input.cwd,
        env,
      });
    } catch (spawnErr) {
      const reason = `拉起终端进程失败（TERMINAL_UNAVAILABLE）：${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`;
      const unavailableEntry = this.createUnavailableEntry({
        id: terminalId,
        workspaceId: input.workspaceId,
        sessionKey: input.sessionKey,
        title,
        cwd: input.cwd,
        cwdLabel,
        reason,
      });
      this.installEntry(input.sessionKey, list, replaceIndex, unavailableEntry);
      return this.snapshotSession(input.sessionKey);
    }

    const replay = createTerminalReplayBuffer();
    const batcher = createTerminalDataBatcher((batch) => {
      if (this.disposed) return;
      this.onEvent?.({
        type: 'data',
        workspaceId: input.workspaceId,
        sessionKey: input.sessionKey,
        terminalId,
        data: batch,
      });
    }, this.batchIntervalMs);

    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    const recordedPid =
      Number.isInteger(ptyProcess.pid) &&
      ptyProcess.pid > 0 &&
      ptyProcess.pid !== process.pid &&
      ptyProcess.pid !== process.ppid
        ? ptyProcess.pid
        : undefined;

    const entry: ManagedTerminalEntry = {
      id: terminalId,
      workspaceId: input.workspaceId,
      sessionKey: input.sessionKey,
      title,
      cwd: input.cwd,
      cwdLabel,
      shellId: chosenShell.id,
      shellLabel: chosenShell.label,
      status: 'running',
      replay,
      batcher,
      pid: recordedPid,
      pty: ptyProcess,
      exitPromise,
      resolveExit,
    };

    entry.dataSub = ptyProcess.onData((chunk) => {
      if (this.disposed || !chunk) return;
      appendTerminalReplay(entry.replay, chunk);
      entry.batcher.push(chunk);
    });

    entry.exitSub = ptyProcess.onExit(({ exitCode }) => {
      entry.batcher.flush();
      entry.batcher.dispose();
      entry.status = 'exited';
      entry.exitCode = Number.isFinite(exitCode) ? exitCode : 0;
      entry.pty = undefined;
      entry.resolveExit?.();
      if (!this.disposed) {
        this.onEvent?.({
          type: 'exit',
          workspaceId: entry.workspaceId,
          sessionKey: entry.sessionKey,
          terminalId: entry.id,
          exitCode: entry.exitCode,
        });
      }
    });

    this.installEntry(input.sessionKey, list, replaceIndex, entry);
    return this.snapshotSession(input.sessionKey);
  }

  /** 向指定运行中终端写入键盘输入或粘贴文本。 */
  write(input: {
    readonly workspaceId: string;
    readonly sessionKey: string;
    readonly terminalId: string;
    readonly data: string;
  }): void {
    const entry = this.requireOwnedTerminal(input.workspaceId, input.sessionKey, input.terminalId);
    if (entry.status !== 'running' || !entry.pty || !input.data) return;
    entry.pty.write(input.data);
  }

  /** 同步更新伪终端行列窗口尺寸（钳制于安全边界内防异常数值触发底层断言崩溃）。 */
  resize(input: {
    readonly workspaceId: string;
    readonly sessionKey: string;
    readonly terminalId: string;
    readonly cols: number;
    readonly rows: number;
  }): void {
    const entry = this.requireOwnedTerminal(input.workspaceId, input.sessionKey, input.terminalId);
    if (entry.status !== 'running' || !entry.pty) return;
    try {
      entry.pty.resize(clampCols(input.cols), clampRows(input.rows));
    } catch {
      // 进程刚退出瞬间的竞态 resize 静默忽略。
    }
  }

  /** 清空指定终端的宿主侧回放缓冲（配合前端视口清屏）。 */
  clear(input: {
    readonly workspaceId: string;
    readonly sessionKey: string;
    readonly terminalId: string;
  }): void {
    const entry = this.requireOwnedTerminal(input.workspaceId, input.sessionKey, input.terminalId);
    clearTerminalReplay(entry.replay);
  }

  /** 关闭并销毁单个子终端实例，等待底层进程释放目录句柄后返回剩余终端快照。 */
  async close(input: {
    readonly workspaceId: string;
    readonly sessionKey: string;
    readonly terminalId: string;
  }): Promise<TerminalSessionSnapshot> {
    return await this.withSessionLock(input.sessionKey, async () => {
      const list = this.bySession.get(input.sessionKey);
      if (!list) return this.snapshotSession(input.sessionKey);
      const idx = list.findIndex(
        (item) => item.id === input.terminalId && item.workspaceId === input.workspaceId,
      );
      if (idx < 0) return this.snapshotSession(input.sessionKey);
      const [removed] = list.splice(idx, 1);
      if (list.length === 0) {
        this.bySession.delete(input.sessionKey);
        this.activeBySession.delete(input.sessionKey);
      } else if (this.activeBySession.get(input.sessionKey) === input.terminalId) {
        this.activeBySession.set(
          input.sessionKey,
          list[Math.min(idx, list.length - 1)]?.id ?? list[0]!.id,
        );
      }
      if (removed) await this.teardownEntry(removed);
      return this.snapshotSession(input.sessionKey);
    });
  }

  /** 按会话键销毁其名下全部终端（会话关闭、归档或删除时调用），并推进纪元中止挂起中的创建。 */
  async closeBySession(sessionKey: string): Promise<void> {
    this.bumpSessionEpoch(sessionKey);
    const list = this.bySession.get(sessionKey);
    if (!list) return;
    this.bySession.delete(sessionKey);
    this.activeBySession.delete(sessionKey);
    await Promise.all(list.map((item) => this.teardownEntry(item)));
  }

  /** 按受管工作树路径销毁绑定在该目录上的全部终端，确保 Windows 删除 Worktree 前完全释放目录句柄。 */
  async closeByCwd(targetCwd: string): Promise<void> {
    const pendingTeardowns: Promise<void>[] = [];
    for (const [sessionKey, list] of [...this.bySession.entries()]) {
      const survivors: ManagedTerminalEntry[] = [];
      let removedAny = false;
      for (const item of list) {
        if (isSamePath(item.cwd, targetCwd)) {
          removedAny = true;
          pendingTeardowns.push(this.teardownEntry(item));
        } else {
          survivors.push(item);
        }
      }
      if (removedAny) {
        this.bumpSessionEpoch(sessionKey);
      }
      if (survivors.length === 0) {
        this.bySession.delete(sessionKey);
        this.activeBySession.delete(sessionKey);
      } else if (survivors.length !== list.length) {
        this.bySession.set(sessionKey, survivors);
        this.activeBySession.set(sessionKey, survivors[0]!.id);
      }
    }
    await Promise.all(pendingTeardowns);
  }

  /** 宿主断连或退出时回收全部伪终端子进程并等待退出。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const sessionKey of this.bySession.keys()) {
      this.bumpSessionEpoch(sessionKey);
    }
    const allEntries = [...this.bySession.values()].flat();
    this.bySession.clear();
    this.activeBySession.clear();
    await Promise.all(allEntries.map((item) => this.teardownEntry(item)));
  }

  private bumpSessionEpoch(sessionKey: string): void {
    this.sessionInvalidationEpoch.set(
      sessionKey,
      (this.sessionInvalidationEpoch.get(sessionKey) ?? 0) + 1,
    );
  }

  private async withSessionLock<T>(sessionKey: string, task: () => Promise<T>): Promise<T> {
    const prev = this.sessionLocks.get(sessionKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => gate);
    this.sessionLocks.set(sessionKey, chained);
    await prev;
    try {
      return await task();
    } finally {
      release();
      if (this.sessionLocks.get(sessionKey) === chained) {
        this.sessionLocks.delete(sessionKey);
      }
    }
  }

  private spawnWithFallback(
    ptyModule: PtyModuleLike,
    shell: TerminalShellCandidate,
    opts: { cols: number; rows: number; cwd: string; env: Record<string, string> },
  ): PtyProcessLike {
    const baseOptions = {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
      ...(process.platform === 'win32' ? { useConpty: true, useConptyDll: true } : {}),
    };
    try {
      return ptyModule.spawn(shell.executable, [...shell.args], baseOptions);
    } catch (firstErr) {
      if (shouldRetryWithoutConptyDll(firstErr)) {
        return ptyModule.spawn(shell.executable, [...shell.args], {
          ...baseOptions,
          useConpty: true,
          useConptyDll: false,
        });
      }
      throw firstErr;
    }
  }

  private createUnavailableEntry(input: {
    id: string;
    workspaceId: string;
    sessionKey: string;
    title: string;
    cwd: string;
    cwdLabel: string;
    reason: string;
  }): ManagedTerminalEntry {
    return {
      id: input.id,
      workspaceId: input.workspaceId,
      sessionKey: input.sessionKey,
      title: input.title,
      cwd: input.cwd,
      cwdLabel: input.cwdLabel,
      shellId: 'unavailable',
      shellLabel: 'unavailable',
      status: 'unavailable',
      unavailableReason: input.reason,
      replay: createTerminalReplayBuffer(),
      batcher: createTerminalDataBatcher(() => {}),
    };
  }

  private installEntry(
    sessionKey: string,
    list: ManagedTerminalEntry[],
    replaceIndex: number,
    entry: ManagedTerminalEntry,
  ): void {
    if (replaceIndex >= 0) {
      list[replaceIndex] = entry;
    } else {
      list.push(entry);
    }
    this.bySession.set(sessionKey, list);
    this.activeBySession.set(sessionKey, entry.id);
  }

  private async teardownEntry(entry: ManagedTerminalEntry): Promise<void> {
    entry.batcher.flush();
    entry.batcher.dispose();
    entry.dataSub?.dispose();
    entry.dataSub = undefined;
    const proc = entry.pty;
    entry.pty = undefined;
    if (proc) {
      try {
        proc.kill();
      } catch {
        // 进程已退出时忽略回收异常。
      }
      if (entry.exitPromise) {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          entry.exitPromise.then(() => true),
          new Promise<boolean>((resolve) => {
            timeoutHandle = setTimeout(() => resolve(false), 800);
          }),
        ]);
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }
    }
    const pid = entry.pid;
    if (!entry.treeKilled && pid !== undefined && pid > 0) {
      entry.treeKilled = true;
      if (this.processTreeKiller) {
        await this.processTreeKiller(pid);
      } else if (process.platform === 'win32') {
        await killWindowsProcessTree(pid, buildSanitizedTerminalEnv(this.hostEnv));
      }
    }
    entry.exitSub?.dispose();
    entry.exitSub = undefined;
  }

  private requireOwnedTerminal(
    workspaceId: string,
    sessionKey: string,
    terminalId: string,
  ): ManagedTerminalEntry {
    const list = this.bySession.get(sessionKey);
    const found = list?.find((item) => item.id === terminalId && item.workspaceId === workspaceId);
    if (!found) {
      throw new KapibalaError('TERMINAL_NOT_FOUND', {
        code: 'TERMINAL_NOT_FOUND',
        retryPolicy: 'never',
        safeMessage: '目标终端不存在或已关闭。',
      });
    }
    return found;
  }

  private snapshotSession(sessionKey: string): TerminalSessionSnapshot {
    const list = this.bySession.get(sessionKey) ?? [];
    for (const item of list) {
      item.batcher.flush();
    }
    const perTerminalJsonBudget = Math.floor(
      MAX_SNAPSHOT_REPLAY_TOTAL_BYTES / Math.max(1, list.length),
    );
    const activeId = this.activeBySession.get(sessionKey) ?? list[0]?.id;
    const firstUnavailable = list.find((item) => item.status === 'unavailable')?.unavailableReason;
    return {
      terminals: list.map((item) => ({
        id: item.id,
        title: item.title,
        cwdLabel: item.cwdLabel,
        shell: item.shellLabel,
        status: item.status,
        ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
        replayBuffer: sliceReplayTailByJsonBytes(
          readTerminalReplayText(item.replay),
          perTerminalJsonBudget,
        ),
        ...(item.unavailableReason ? { unavailableReason: item.unavailableReason } : {}),
      })),
      ...(activeId ? { activeTerminalId: activeId } : {}),
      shells: this.listShells(),
      ...(firstUnavailable ? { unavailableReason: firstUnavailable } : {}),
    };
  }
}
