import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCandidate } from './verify-platform.js';

/**
 * v0.0.10 soak 分档门禁：PR 10 轮、nightly 100 轮、release 1000 轮且至少 30 分钟。
 * 三档使用同一场景驱动与同一断言强度，仅改变轮数与节奏；原始采样与同 SHA 证据由本脚本归档。
 * 资源阈值只在固定环境测得基线后冻结；release 缺基线仍保存趋势，但以 pending 和非零退出码阻断发布。
 */

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const probePath = path.join(repositoryRoot, 'scripts/soak-probe.mjs');
const evidenceRoot = path.join(repositoryRoot, '.workbuddy/v0.0.10-soak/evidence');
const cliDist = path.join(repositoryRoot, 'packages/cli/dist');

type HostExit = { code: number | null; signal: string | null; timedOut?: boolean };
type SoakTier = 'pr' | 'nightly' | 'release';

export interface SoakSample {
  round: number;
  elapsedMs: number;
  rss: number;
  heapUsed: number;
  external: number;
  activeResources: number;
  activeResourceTypes: Record<string, number>;
  daemonRss: number | null;
  stdioRss: number | null;
}

export interface SoakProbeResult {
  ok: boolean;
  error?: string;
  stack?: string;
  tier: string;
  rounds: number;
  warmupRounds: number;
  paceMs: number;
  recycleEvery: number;
  treeEvery: number;
  sampleEvery: number;
  platform: string;
  node: string;
  arch: string;
  limits: Record<string, number>;
  daemon?: { pid: number; endpointType: string };
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  roundCounts?: { session: number; run: number; cancel: number; tree: number };
  outcomes?: { completed: number; cancelled: number };
  maxOpenSessions?: number;
  recycles?: { transport: 'stdio' | 'socket'; round: number; exit?: HostExit }[];
  treeRounds?: {
    round: number;
    shellPid: number;
    childPid: number;
    aliveBefore: { shell: boolean; child: boolean };
    aliveAfter: { shell: boolean; child: boolean };
  }[];
  samples?: SoakSample[];
  final?: {
    snapshotOpenSessions: number;
    stdioExit: HostExit;
    daemonStopped: boolean;
    lockRemoved: boolean;
    alivePids: number[];
  };
  failureCleanup?: unknown;
}

export interface SoakTierConfig {
  rounds: number;
  warmup: number;
  paceMs: number;
  recycleEvery: number;
  treeEvery: number;
  sampleEvery: number;
  minDurationMs: number;
}

/** 三档共用场景驱动；release 以 30 分钟 / 1000 轮推导每轮节奏，避免用空转或额外会话凑时长。 */
export const SOAK_TIERS: Readonly<Record<SoakTier, SoakTierConfig>> = Object.freeze({
  pr: Object.freeze({
    rounds: 10,
    warmup: 1,
    paceMs: 0,
    recycleEvery: 3,
    treeEvery: 5,
    sampleEvery: 1,
    minDurationMs: 0,
  }),
  nightly: Object.freeze({
    rounds: 100,
    warmup: 3,
    paceMs: 0,
    recycleEvery: 10,
    treeEvery: 10,
    sampleEvery: 5,
    minDurationMs: 0,
  }),
  release: Object.freeze({
    rounds: 1000,
    warmup: 3,
    paceMs: 1_800,
    recycleEvery: 20,
    treeEvery: 20,
    sampleEvery: 25,
    minDurationMs: 30 * 60 * 1000,
  }),
});

/** 固定环境实测三次后写入的冻结基线；未提供时不得把趋势观察当成通过阈值。 */
export interface SoakBaseline {
  rssGrowthBytesPerRound: number;
  heapGrowthBytesPerRound: number;
}

/** 证据状态、终端文案和退出码共用同一裁决；待补证据不能被发布流程当作通过。 */
export function soakGateVerdict(
  failures: readonly string[],
  pending: readonly string[],
): {
  status: 'failed' | 'pending' | 'passed';
  exitCode: number;
} {
  return {
    status: failures.length ? 'failed' : pending.length ? 'pending' : 'passed',
    exitCode: failures.length || pending.length ? 1 : 0,
  };
}

function ok(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** 用有限采样值与真实轮次计算斜率；不足两个不同轮次时返回 null，由基线门禁拒绝。 */
export function slopePerRound(
  samples: readonly SoakSample[],
  key: 'rss' | 'heapUsed' | 'daemonRss' | 'stdioRss',
): number | null {
  const points = samples
    .filter(
      (sample) =>
        Number.isFinite(sample.round) &&
        typeof sample[key] === 'number' &&
        Number.isFinite(sample[key]),
    )
    .map((sample) => [sample.round, sample[key] as number] as const);
  if (points.length < 2) return null;
  const meanX = points.reduce((total, [x]) => total + x, 0) / points.length;
  const meanY = points.reduce((total, [, y]) => total + y, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const [x, y] of points) {
    numerator += (x - meanX) * (y - meanY);
    denominator += (x - meanX) ** 2;
  }
  const slope = denominator === 0 ? Number.NaN : numerator / denominator;
  return Number.isFinite(slope) ? slope : null;
}

/** 断言分档轮数、混合场景、会话/进程释放与最终关停；任何一项缺失都不得判绿。 */
export function assertSoakResult(
  result: SoakProbeResult,
  config: SoakTierConfig,
  tier: SoakTier,
): void {
  ok(result.ok, `Soak probe failed: ${result.error ?? 'unknown error'}`);
  ok(result.tier === tier, `Soak tier mismatch: ${result.tier}`);
  ok(result.rounds === config.rounds, `Soak rounds ${result.rounds}, expected ${config.rounds}`);
  ok(
    (result.durationMs ?? 0) >= config.minDurationMs,
    `Soak lasted ${result.durationMs ?? 0}ms, required at least ${config.minDurationMs}ms`,
  );
  const counts = result.roundCounts;
  ok(counts, 'Soak round counts are missing');
  const counted = counts.session + counts.run + counts.cancel + counts.tree;
  ok(
    counted === config.rounds,
    `Soak executed ${counted} counted rounds, expected ${config.rounds}`,
  );
  ok(counts.session > 0, 'Soak never exercised session open/close');
  ok(counts.run > 0, 'Soak never exercised a completed run');
  ok(counts.cancel > 0, 'Soak never exercised run cancellation');
  ok(
    counts.tree === Math.floor(config.rounds / config.treeEvery),
    `Soak executed ${counts.tree} process-tree rounds, expected ${Math.floor(config.rounds / config.treeEvery)}`,
  );
  const outcomes = result.outcomes;
  ok(outcomes, 'Soak outcomes are missing');
  ok(outcomes.completed === counts.run, 'Soak completed-run count does not match run rounds');
  ok(
    outcomes.cancelled >= counts.cancel + counts.tree,
    'Soak cancelled-run count does not match cancel/tree rounds',
  );
  ok(result.maxOpenSessions === 1, `Soak observed ${result.maxOpenSessions} open sessions`);
  const recycles = result.recycles ?? [];
  if (config.rounds >= config.recycleEvery * 2) {
    ok(
      recycles.some((entry) => entry.transport === 'stdio') &&
        recycles.some((entry) => entry.transport === 'socket'),
      'Soak did not recycle both transports',
    );
  }
  for (const recycle of recycles) {
    if (recycle.transport !== 'stdio') continue;
    ok(
      recycle.exit?.code === 0 && !recycle.exit.timedOut,
      `stdio host exit was unclean at round ${recycle.round}: ${JSON.stringify(recycle.exit)}`,
    );
  }
  const treeRounds = result.treeRounds ?? [];
  ok(
    treeRounds.length === counts.tree,
    'Soak tree round records do not match executed tree rounds',
  );
  for (const round of treeRounds) {
    ok(
      round.aliveBefore.shell && round.aliveBefore.child,
      `Tree round ${round.round} did not start both processes`,
    );
    ok(
      !round.aliveAfter.shell && !round.aliveAfter.child,
      `Tree round ${round.round} left a process alive after cancellation`,
    );
  }
  const final = result.final;
  ok(final, 'Soak final state is missing');
  ok(final.snapshotOpenSessions === 1, 'Soak final snapshot shows a leaked session');
  ok(final.stdioExit.code === 0 && !final.stdioExit.timedOut, 'stdio host did not stop cleanly');
  ok(final.daemonStopped, 'daemon process survived shutdown');
  ok(final.lockRemoved, 'daemon lock was not removed');
  ok(final.alivePids.length === 0, `Soak left processes alive: ${final.alivePids.join(', ')}`);
  ok((result.samples?.length ?? 0) > 0, 'Soak produced no resource samples');
}

/** 按冻结阈值检查每轮增长；heap 或宿主 RSS 无有效斜率、已采样宿主样本不足时均失败。 */
export function applySoakBaseline(
  result: SoakProbeResult,
  baseline: SoakBaseline,
): {
  heapGrowthBytesPerRound: number | null;
  serverRssGrowthBytesPerRound: number | null;
  failures: string[];
} {
  const samples = result.samples ?? [];
  const heapGrowthBytesPerRound = slopePerRound(samples, 'heapUsed');
  const daemonSlope = slopePerRound(samples, 'daemonRss');
  const stdioSlope = slopePerRound(samples, 'stdioRss');
  const serverRssGrowthBytesPerRound =
    daemonSlope === null
      ? stdioSlope
      : stdioSlope === null
        ? daemonSlope
        : Math.max(daemonSlope, stdioSlope);
  const failures: string[] = [];
  if (
    !Number.isFinite(baseline.heapGrowthBytesPerRound) ||
    !Number.isFinite(baseline.rssGrowthBytesPerRound) ||
    baseline.heapGrowthBytesPerRound < 0 ||
    baseline.rssGrowthBytesPerRound < 0
  )
    failures.push('Frozen baseline limits must be finite nonnegative numbers');
  if (heapGrowthBytesPerRound === null) failures.push('heap samples insufficient for a slope');
  if (serverRssGrowthBytesPerRound === null)
    failures.push('host RSS samples insufficient for a slope');
  for (const [key, slope] of [
    ['daemonRss', daemonSlope],
    ['stdioRss', stdioSlope],
  ] as const) {
    if (
      slope === null &&
      samples.some((sample) => sample[key] !== null && sample[key] !== undefined)
    )
      failures.push(`${key} samples insufficient for a slope`);
  }
  if (
    heapGrowthBytesPerRound !== null &&
    heapGrowthBytesPerRound > baseline.heapGrowthBytesPerRound
  )
    failures.push(
      `heap grew ${Math.round(heapGrowthBytesPerRound)} bytes/round above frozen ${baseline.heapGrowthBytesPerRound}`,
    );
  if (
    serverRssGrowthBytesPerRound !== null &&
    serverRssGrowthBytesPerRound > baseline.rssGrowthBytesPerRound
  )
    failures.push(
      `host RSS grew ${Math.round(serverRssGrowthBytesPerRound)} bytes/round above frozen ${baseline.rssGrowthBytesPerRound}`,
    );
  return { heapGrowthBytesPerRound, serverRssGrowthBytesPerRound, failures };
}

function parseInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Invalid --${name}: ${value}`);
  return parsed;
}

interface CliOptions {
  tier: SoakTier;
  config: SoakTierConfig;
  debugOverride: boolean;
  baselineFile?: string;
  noBuild: boolean;
  keepTemp: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let tier: SoakTier = 'pr';
  let rounds: number | undefined;
  let paceMs: number | undefined;
  let recycleEvery: number | undefined;
  let treeEvery: number | undefined;
  let warmup: number | undefined;
  let sampleEvery: number | undefined;
  let baselineFile: string | undefined;
  let noBuild = false;
  let keepTemp = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--tier') tier = (argv[++index] ?? '') as SoakTier;
    else if (arg === '--rounds') rounds = parseInteger(argv[++index], 'rounds');
    else if (arg === '--pace-ms') paceMs = parseInteger(argv[++index], 'pace-ms');
    else if (arg === '--recycle-every') recycleEvery = parseInteger(argv[++index], 'recycle-every');
    else if (arg === '--tree-every') treeEvery = parseInteger(argv[++index], 'tree-every');
    else if (arg === '--warmup') warmup = parseInteger(argv[++index], 'warmup');
    else if (arg === '--sample-every') sampleEvery = parseInteger(argv[++index], 'sample-every');
    else if (arg === '--baseline') baselineFile = argv[++index];
    else if (arg === '--no-build') noBuild = true;
    else if (arg === '--keep-temp') keepTemp = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!(tier in SOAK_TIERS)) throw new Error(`Unknown soak tier: ${tier}`);
  const base = SOAK_TIERS[tier];
  const override = rounds !== undefined;
  return {
    tier,
    debugOverride: override,
    noBuild,
    keepTemp,
    baselineFile,
    config: {
      ...base,
      rounds: rounds ?? base.rounds,
      warmup: warmup ?? base.warmup,
      paceMs: paceMs ?? base.paceMs,
      recycleEvery: recycleEvery ?? base.recycleEvery,
      treeEvery: treeEvery ?? base.treeEvery,
      sampleEvery: sampleEvery ?? base.sampleEvery,
      minDurationMs: override ? 0 : base.minDurationMs,
    },
  };
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function gitValue(args: string[]): string {
  const result = spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function evidencePath(tier: SoakTier, commit: string, dirty: boolean): string {
  return path.join(
    evidenceRoot,
    `soak-${tier}-${commit.slice(0, 12) || 'nogit'}${dirty ? '-dirty' : ''}.json`,
  );
}

function runProbe(
  options: CliOptions,
  tempRoot: string,
): Promise<{ stdout: string; stderr: string; resultFile: string }> {
  const home = path.join(tempRoot, 'home');
  const workspace = path.join(tempRoot, 'workspace');
  const runtime = path.join(tempRoot, 'runtime');
  const resultFile = path.join(tempRoot, 'soak-result.json');
  fs.mkdirSync(path.join(home, '.kapibala'), { recursive: true });
  fs.mkdirSync(workspace);
  fs.mkdirSync(runtime);
  const timeoutMs = options.config.rounds * (options.config.paceMs + 10_000) + 10 * 60 * 1000;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        probePath,
        '--client',
        path.join(cliDist, 'client/index.js'),
        '--protocol',
        path.join(cliDist, 'protocol/index.js'),
        '--host',
        path.join(cliDist, 'bin.js'),
        '--root',
        workspace,
        '--home',
        home,
        '--runtime',
        runtime,
        '--result',
        resultFile,
        '--tier',
        options.tier,
        '--rounds',
        String(options.config.rounds),
        '--warmup',
        String(options.config.warmup),
        '--pace-ms',
        String(options.config.paceMs),
        '--recycle-every',
        String(options.config.recycleEvery),
        '--tree-every',
        String(options.config.treeEvery),
        '--sample-every',
        String(options.config.sampleEvery),
      ],
      {
        cwd: repositoryRoot,
        env: { ...process.env, HOME: home, USERPROFILE: home, KPBL_LOCAL_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-8_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8_000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Soak probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0)
        reject(new Error(`Soak probe exited with ${code ?? signal}:\n${stderr || stdout}`));
      else if (!fs.existsSync(resultFile))
        reject(new Error(`Soak probe produced no result file:\n${stderr || stdout}`));
      else resolve({ stdout, stderr, resultFile });
    });
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { config, tier } = options;
  if (options.debugOverride)
    console.log('⚠️  --rounds override enabled; this run cannot stand in for the tier evidence.');
  if (!options.noBuild) await buildCandidate();
  for (const relative of ['client/index.js', 'protocol/index.js', 'bin.js'])
    if (!fs.existsSync(path.join(cliDist, relative)))
      throw new Error(`Missing build output dist/${relative}; run pnpm build first`);

  const tempRoot = fs.mkdtempSync(
    path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'kpbl-soak-'),
  );
  let probe: SoakProbeResult | undefined;
  let probeOutput: { stdout: string; stderr: string; resultFile: string } | undefined;
  const failures: string[] = [];
  const pending: string[] = [];
  try {
    probeOutput = await runProbe(options, tempRoot);
    probe = readJson<SoakProbeResult>(probeOutput.resultFile);
    try {
      assertSoakResult(probe, config, tier);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }

    let baseline: {
      path: string;
      status: 'passed' | 'failed' | 'not-required' | 'pending';
      limits?: SoakBaseline;
      slopes?: {
        heapGrowthBytesPerRound: number | null;
        serverRssGrowthBytesPerRound: number | null;
      };
    } = {
      path: options.baselineFile ?? '',
      status: tier === 'release' ? 'pending' : 'not-required',
    };
    if (options.baselineFile) {
      const limits = readJson<SoakBaseline>(options.baselineFile);
      if (
        typeof limits.rssGrowthBytesPerRound !== 'number' ||
        typeof limits.heapGrowthBytesPerRound !== 'number'
      )
        throw new Error('Baseline must define rssGrowthBytesPerRound and heapGrowthBytesPerRound');
      const verdict = applySoakBaseline(probe, limits);
      baseline = {
        path: path.resolve(options.baselineFile),
        status: verdict.failures.length ? 'failed' : 'passed',
        limits,
        slopes: {
          heapGrowthBytesPerRound: verdict.heapGrowthBytesPerRound,
          serverRssGrowthBytesPerRound: verdict.serverRssGrowthBytesPerRound,
        },
      };
      failures.push(...verdict.failures);
    } else if (tier === 'release') {
      pending.push(
        'Release soak has no frozen RSS/heap baseline; collect three fixed-environment runs and freeze thresholds before release.',
      );
    }

    const verdict = soakGateVerdict(failures, pending);
    const commit = gitValue(['rev-parse', 'HEAD']);
    const dirty = gitValue(['status', '--porcelain']).length > 0;
    const evidence = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      command: `pnpm verify:soak${tier === 'pr' ? '' : ` --tier ${tier}`}`,
      commit,
      worktreeDirty: dirty,
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
      },
      tier,
      tierConfig: config,
      debugOverride: options.debugOverride,
      verdict: {
        status: verdict.status,
        failures,
        pending,
      },
      baseline,
      probe: probeOutput.stdout.trim(),
      probeStderr: probeOutput.stderr.trim(),
      result: probe,
    };
    fs.mkdirSync(evidenceRoot, { recursive: true });
    const file = evidencePath(tier, commit, dirty);
    fs.writeFileSync(file, JSON.stringify(evidence, null, 2));
    if (dirty)
      console.log('Worktree is dirty; evidence is marked and cannot stand in for a clean commit.');
    for (const failure of failures) console.error(`✘ ${failure}`);
    for (const entry of pending) console.log(`… ${entry}`);
    console.log(
      `Soak gate ${verdict.status}; tier=${tier}, rounds=${config.rounds}, duration=${Math.round((probe.durationMs ?? 0) / 1000)}s, pending=${pending.length}. Evidence: ${path.relative(repositoryRoot, file)}`,
    );
    process.exitCode = verdict.exitCode;
  } finally {
    if (!options.keepTemp) fs.rmSync(tempRoot, { recursive: true, force: true });
    else console.log(`Soak scratch retained at ${tempRoot}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`✘ Soak gate failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
