import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 专项覆盖按设计方案固定；日常平台脚本的 pending 不能替代这些发布必需项。 */
const REQUIRED_COVERAGE = {
  'G-N20': ['node20'],
  'G-ACL': ['windows-cross-user'],
  'G-PTY': ['windows-conpty', 'macos-pty', 'linux-pty'],
  'G-TREE': ['windows-git-bash', 'windows-powershell', 'macos', 'linux'],
  'G-MCP': ['stdio', 'http'],
  'G-SOAK': ['release'],
} as const;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function reportUrl(value: unknown): boolean {
  if (!text(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * 发布前检查经审核的证据索引；每个必需专项必须覆盖目标提交、完整平台范围和干净的正式运行。
 * 这里只验证索引和审核声明，不生成通过记录，也不能代替真实执行或人工审阅原始日志。
 */
export function assertReleaseEvidence(value: unknown, expectedCommit: string): void {
  ensure(/^[a-f0-9]{40}$/.test(expectedCommit), 'Expected candidate SHA must be a full commit SHA');
  ensure(record(value) && value.schemaVersion === 1, 'Invalid release evidence manifest');
  ensure(value.commit === expectedCommit, 'Release evidence manifest SHA does not match candidate');
  ensure(Array.isArray(value.checks), 'Release evidence checks are missing');
  const seen = new Set<string>();
  for (const check of value.checks) {
    ensure(
      record(check) && typeof check.id === 'string' && Object.hasOwn(REQUIRED_COVERAGE, check.id),
      'Unknown release evidence gate',
    );
    const id = check.id;
    ensure(!seen.has(id), `Duplicate release evidence gate: ${id}`);
    seen.add(id);
    ensure(check.commit === expectedCommit, `${id}: report SHA does not match candidate`);
    ensure(check.status === 'passed', `${id}: mandatory evidence must be passed`);
    ensure(check.worktreeDirty === false, `${id}: worktreeDirty must be false`);
    ensure(check.debugOverride === false, `${id}: debugOverride must be false`);
    for (const field of ['environment', 'command', 'reviewer', 'reviewedAt'])
      ensure(text(check[field]), `${id}: ${field} is missing`);
    ensure(Number.isFinite(Date.parse(check.reviewedAt as string)), `${id}: reviewedAt is invalid`);
    ensure(
      Array.isArray(check.logs) && check.logs.length > 0 && check.logs.every(reportUrl),
      `${id}: logs must contain HTTPS report links without credentials`,
    );
    ensure(Array.isArray(check.coverage), `${id}: coverage is missing`);
    for (const coverage of REQUIRED_COVERAGE[id as keyof typeof REQUIRED_COVERAGE])
      ensure(check.coverage.includes(coverage), `${id}: missing coverage ${coverage}`);
    if (id === 'G-SOAK') {
      ensure(
        Number.isSafeInteger(check.rounds) && (check.rounds as number) >= 1000,
        'G-SOAK: at least 1000 rounds are required',
      );
      ensure(
        typeof check.durationMs === 'number' &&
          Number.isFinite(check.durationMs) &&
          check.durationMs >= 1_800_000,
        'G-SOAK: at least 30 minutes are required',
      );
      ensure(check.baselineReviewed === true, 'G-SOAK: frozen baseline must be reviewed');
    }
  }
  for (const id of Object.keys(REQUIRED_COVERAGE))
    ensure(seen.has(id), `Missing release evidence gate: ${id}`);
}

function main(): void {
  const args = process.argv.slice(2);
  let commit: string | undefined;
  let file: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--sha') commit = args[++index];
    else if (args[index] === '--manifest') file = args[++index];
    else throw new Error('Usage: check-release-evidence --sha <commit> [--manifest <file>]');
  }
  ensure(commit, 'Expected candidate SHA is required (--sha)');
  const source = file ? fs.readFileSync(file, 'utf8') : process.env.KPBL_RELEASE_EVIDENCE;
  ensure(
    typeof source === 'string' && source.trim().length > 0,
    'Missing release evidence: use --manifest or KPBL_RELEASE_EVIDENCE',
  );
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('Invalid release evidence JSON');
  }
  assertReleaseEvidence(value, commit);
  console.log(`Release evidence verified: 6 required gates at ${commit}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Release evidence check failed');
    process.exitCode = 1;
  }
}
