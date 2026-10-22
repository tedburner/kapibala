import { describe, expect, it } from 'vitest';
import {
  type BaselineCandidateContext,
  assertBaselineCandidate,
} from '../validate-soak-candidate.js';
import { SOAK_TIERS } from '../verify-soak.js';

const context = (): BaselineCandidateContext => {
  const environment = {
    commit: 'a'.repeat(40),
    platform: 'linux',
    arch: 'x64',
    node: 'v24.22.1',
    image: 'ubuntu24',
    imageVersion: '20261021.345.10',
  };
  return {
    current: { ...environment },
    frozen: { ...environment },
    startedAt: Date.parse('2026-10-22T00:00:00Z'),
    exitCode: 1,
  };
};
const candidate = () => ({
  commit: 'a'.repeat(40),
  generatedAt: '2026-10-22T00:31:00Z',
  worktreeDirty: false,
  debugOverride: false,
  environment: { platform: 'linux', arch: 'x64', node: 'v24.22.1' },
  tier: 'release',
  tierConfig: SOAK_TIERS.release,
  verdict: {
    status: 'pending',
    failures: [] as string[],
    pending: ['Release soak has no frozen RSS/heap baseline; review required.'],
  },
  baseline: { status: 'pending' },
  result: {
    ok: true,
    tier: 'release',
    rounds: 1000,
    durationMs: 1_800_000,
    roundCounts: { session: 350, run: 300, cancel: 300, tree: 50 },
    outcomes: { completed: 300, cancelled: 350 },
    maxOpenSessions: 1,
    recycles: [
      { transport: 'stdio', round: 20, exit: { code: 0 } },
      { transport: 'socket', round: 40 },
    ],
    treeRounds: Array.from({ length: 50 }, (_, index) => ({
      round: (index + 1) * 20,
      aliveBefore: { shell: true, child: true },
      aliveAfter: { shell: false, child: false },
    })),
    samples: [
      { round: 25, heapUsed: 100, daemonRss: 200, stdioRss: null as number | null },
      { round: 1000, heapUsed: 101, daemonRss: 201, stdioRss: null as number | null },
    ],
    final: {
      snapshotOpenSessions: 1,
      stdioExit: { code: 0 },
      daemonStopped: true,
      lockRemoved: true,
      alivePids: [],
    },
  },
});

describe('baseline candidate acceptance', () => {
  it('accepts a full fresh collection while retaining pending release status', () => {
    const report = candidate();
    expect(() => assertBaselineCandidate(report, context())).not.toThrow();
    expect(report.verdict.status).toBe('pending');
  });

  it('rejects runner image, Node or source drift between collection rounds', () => {
    for (const field of ['imageVersion', 'node', 'commit'] as const) {
      const run = context();
      run.frozen[field] = 'different';
      expect(() => assertBaselineCandidate(candidate(), run)).toThrow(/environment changed/);
    }
  });

  it('rejects stale reports even when a crashed process also returns one', () => {
    const report = candidate();
    report.generatedAt = '2026-10-21T23:59:00Z';
    expect(() => assertBaselineCandidate(report, context())).toThrow(/fresh report/);
  });

  it('rejects short, failed, dirty, debug and insufficient-sample collections', () => {
    for (const mutate of [
      (r: ReturnType<typeof candidate>) => {
        r.result.durationMs = 1000;
      },
      (r: ReturnType<typeof candidate>) => {
        r.verdict.failures.push('probe failed');
      },
      (r: ReturnType<typeof candidate>) => {
        r.worktreeDirty = true;
      },
      (r: ReturnType<typeof candidate>) => {
        r.debugOverride = true;
      },
      (r: ReturnType<typeof candidate>) => {
        r.result.samples = r.result.samples.slice(0, 1);
      },
      (r: ReturnType<typeof candidate>) => {
        r.result.samples[0]!.stdioRss = 100;
      },
    ]) {
      const report = candidate();
      mutate(report);
      expect(() => assertBaselineCandidate(report, context())).toThrow();
    }
    expect(() => assertBaselineCandidate(candidate(), { ...context(), exitCode: 0 })).toThrow();
  });
});
