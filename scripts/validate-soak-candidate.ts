import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SOAK_TIERS,
  type SoakProbeResult,
  assertSoakResult,
  slopePerRound,
} from './verify-soak.js';

/** 单次采集与首轮冻结的执行环境；提交、完整 Node 版本和 runner 镜像必须一致。 */
export interface BaselineEnvironment {
  commit: string;
  platform: string;
  arch: string;
  node: string;
  image: string;
  imageVersion: string;
}

/** 采集校验需要真实退出码与启动时刻，防止失败进程复用上一轮残留报告。 */
export interface BaselineCandidateContext {
  current: BaselineEnvironment;
  frozen: BaselineEnvironment;
  startedAt: number;
  exitCode: number;
}

interface CandidateReport {
  commit: string;
  generatedAt: string;
  worktreeDirty: boolean;
  debugOverride: boolean;
  environment: { platform: string; arch: string; node: string };
  tier: string;
  tierConfig: unknown;
  verdict: { status: string; failures: string[]; pending: string[] };
  baseline: { status: string };
  result: SoakProbeResult;
}

/** 只接受缺少冻结阈值的完整采集；此检查通过不代表发布资源门禁通过。 */
export function assertBaselineCandidate(value: unknown, context: BaselineCandidateContext): void {
  const report = value as CandidateReport;
  assert.deepEqual(context.current, context.frozen, 'Baseline collection environment changed');
  assert(
    Number.isFinite(context.startedAt) && Date.parse(report.generatedAt) >= context.startedAt,
    'Collection did not produce a fresh report',
  );
  assert.equal(context.exitCode, 1, 'Missing baseline must remain nonzero');
  assert.equal(report.commit, context.current.commit);
  assert.equal(report.worktreeDirty, false);
  assert.equal(report.debugOverride, false);
  assert.deepEqual(report.environment, {
    platform: context.current.platform,
    arch: context.current.arch,
    node: context.current.node,
  });
  assert.equal(report.environment.platform, 'linux');
  assert.equal(report.environment.arch, 'x64');
  assert.match(report.environment.node, /^v24\./);
  assert.equal(report.tier, 'release');
  assert.deepEqual(report.tierConfig, SOAK_TIERS.release);
  assert.equal(report.verdict.status, 'pending');
  assert.deepEqual(report.verdict.failures, []);
  assert.equal(report.verdict.pending.length, 1);
  assert.match(report.verdict.pending[0]!, /^Release soak has no frozen RSS\/heap baseline;/);
  assert.equal(report.baseline.status, 'pending');
  assertSoakResult(report.result, SOAK_TIERS.release, 'release');
  assert.notEqual(slopePerRound(report.result.samples!, 'heapUsed'), null);
  const rss = (['daemonRss', 'stdioRss'] as const).map((key) => {
    const slope = slopePerRound(report.result.samples!, key);
    if (report.result.samples!.some((sample) => sample[key] !== null && sample[key] !== undefined))
      assert.notEqual(slope, null, `${key} samples insufficient for a slope`);
    return slope;
  });
  assert(
    rss.some((slope) => slope !== null),
    'Missing host RSS slope',
  );
}

/** 为同一 runner 的连续三次长跑归档报告；不生成阈值，也不把候选采集改写为发布通过。 */
function main(): void {
  const [attemptArg, startedArg, exitArg] = process.argv.slice(2);
  const attempt = Number(attemptArg);
  assert(
    Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= 3,
    'Invalid collection attempt',
  );
  const current: BaselineEnvironment = {
    commit: process.env.GITHUB_SHA ?? '',
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    image: process.env.ImageOS ?? '',
    imageVersion: process.env.ImageVersion ?? '',
  };
  assert.match(current.commit, /^[a-f0-9]{40}$/);
  assert.equal(current.image, 'ubuntu24');
  assert(current.imageVersion.length > 0, 'Missing runner image version');
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const evidence = path.join(root, '.workbuddy/v0.0.10-soak/evidence');
  const candidates = path.join(root, '.workbuddy/v0.0.10-soak/baseline-candidates');
  const environmentFile = path.join(candidates, 'environment.json');
  const frozen: BaselineEnvironment =
    attempt === 1 ? current : JSON.parse(fs.readFileSync(environmentFile, 'utf8'));
  const files = fs
    .readdirSync(evidence)
    .filter((name) => name === `soak-release-${current.commit.slice(0, 12)}.json`);
  assert.equal(files.length, 1, 'Expected one clean release report for this source commit');
  const source = path.join(evidence, files[0]!);
  const report: unknown = JSON.parse(fs.readFileSync(source, 'utf8'));
  assertBaselineCandidate(report, {
    current,
    frozen,
    startedAt: Number(startedArg),
    exitCode: Number(exitArg),
  });
  const destination = path.join(candidates, String(attempt));
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(source, path.join(destination, files[0]!), fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(
    path.join(destination, 'runner-image.json'),
    JSON.stringify({ image: current.image, version: current.imageVersion, node: current.node }),
    { flag: 'wx' },
  );
  if (attempt === 1) fs.writeFileSync(environmentFile, JSON.stringify(current), { flag: 'wx' });
  console.log(`Collected baseline candidate ${attempt}/3; release acceptance remains pending.`);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\nBaseline candidate ${attempt}/3 collected on ${current.imageVersion}; thresholds still require review. Release acceptance remains pending.\n`,
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
