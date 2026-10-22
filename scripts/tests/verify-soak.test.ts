import { describe, expect, it } from 'vitest';
import {
  SOAK_TIERS,
  type SoakProbeResult,
  type SoakSample,
  applySoakBaseline,
  assertSoakResult,
  slopePerRound,
  soakGateVerdict,
} from '../verify-soak.js';

const samples = (): SoakSample[] =>
  Array.from({ length: 10 }, (_, index) => ({
    round: index + 1,
    elapsedMs: (index + 1) * 100,
    rss: 10_000 + index * 100,
    heapUsed: 5_000 + index * 50,
    external: 1_000,
    activeResources: 4,
    activeResourceTypes: { Timeout: 2, TCPSocketWrap: 2 },
    daemonRss: 20_000 + index * 200,
    stdioRss: null,
  }));

const result = (): SoakProbeResult => ({
  ok: true,
  tier: 'pr',
  rounds: 10,
  warmupRounds: 1,
  paceMs: 0,
  recycleEvery: 3,
  treeEvery: 5,
  sampleEvery: 1,
  platform: 'darwin',
  node: 'v26.12.0',
  arch: 'arm64',
  limits: { maxOpenSessions: 8, maxConcurrentRuns: 4 },
  durationMs: 1_000,
  roundCounts: { session: 3, run: 2, cancel: 3, tree: 2 },
  outcomes: { completed: 2, cancelled: 5 },
  maxOpenSessions: 1,
  recycles: [
    { transport: 'stdio', round: 5, exit: { code: 0, signal: null } },
    { transport: 'socket', round: 8 },
  ],
  treeRounds: [
    {
      round: 5,
      shellPid: 10,
      childPid: 11,
      aliveBefore: { shell: true, child: true },
      aliveAfter: { shell: false, child: false },
    },
    {
      round: 10,
      shellPid: 12,
      childPid: 13,
      aliveBefore: { shell: true, child: true },
      aliveAfter: { shell: false, child: false },
    },
  ],
  samples: samples(),
  final: {
    snapshotOpenSessions: 1,
    stdioExit: { code: 0, signal: null },
    daemonStopped: true,
    lockRemoved: true,
    alivePids: [],
  },
});

describe('soak gate helpers', () => {
  it('returns a failing exit code while release evidence is pending', () => {
    expect(soakGateVerdict([], ['Release soak has no frozen RSS/heap baseline'])).toEqual({
      status: 'pending',
      exitCode: 1,
    });
    expect(soakGateVerdict(['host leaked'], ['missing baseline'])).toEqual({
      status: 'failed',
      exitCode: 1,
    });
    expect(soakGateVerdict([], [])).toEqual({ status: 'passed', exitCode: 0 });
  });

  it('computes per-round slopes and tolerates missing host samples', () => {
    expect(slopePerRound(samples(), 'heapUsed')).toBeCloseTo(50);
    expect(slopePerRound(samples(), 'daemonRss')).toBeCloseTo(200);
    expect(slopePerRound(samples(), 'stdioRss')).toBeNull();
    expect(slopePerRound(samples().slice(0, 1), 'heapUsed')).toBeNull();
  });

  it('accepts a balanced PR scenario', () => {
    expect(() => assertSoakResult(result(), SOAK_TIERS.pr, 'pr')).not.toThrow();
  });

  it('rejects leaked sessions, missing mixed rounds and survivor processes', () => {
    const leaked = result();
    leaked.maxOpenSessions = 2;
    expect(() => assertSoakResult(leaked, SOAK_TIERS.pr, 'pr')).toThrow(/open sessions/);

    const noCancel = result();
    noCancel.roundCounts = { session: 5, run: 3, cancel: 0, tree: 2 };
    noCancel.outcomes = { completed: 3, cancelled: 2 };
    expect(() => assertSoakResult(noCancel, SOAK_TIERS.pr, 'pr')).toThrow(/cancellation/);

    const survivor = result();
    survivor.treeRounds![0].aliveAfter.child = true;
    expect(() => assertSoakResult(survivor, SOAK_TIERS.pr, 'pr')).toThrow(/left a process alive/);

    const unclean = result();
    unclean.final!.stdioExit = { code: null, signal: 'SIGTERM', timedOut: true };
    expect(() => assertSoakResult(unclean, SOAK_TIERS.pr, 'pr')).toThrow(/cleanly/);

    const lingering = result();
    lingering.final!.alivePids = [42];
    expect(() => assertSoakResult(lingering, SOAK_TIERS.pr, 'pr')).toThrow(/left processes alive/);

    const failed = result();
    failed.ok = false;
    failed.error = 'fixture crashed';
    expect(() => assertSoakResult(failed, SOAK_TIERS.pr, 'pr')).toThrow(/fixture crashed/);
  });

  it('enforces the release minimum duration', () => {
    const short = result();
    short.durationMs = 1_000;
    expect(() =>
      assertSoakResult(short, { ...SOAK_TIERS.pr, minDurationMs: 30 * 60 * 1000 }, 'pr'),
    ).toThrow(/at least/);
  });

  it('applies frozen thresholds and names the exceeded budget', () => {
    const passing = applySoakBaseline(result(), {
      heapGrowthBytesPerRound: 50,
      rssGrowthBytesPerRound: 200,
    });
    expect(passing.failures).toEqual([]);
    expect(passing.serverRssGrowthBytesPerRound).toBeCloseTo(200);

    const heap = applySoakBaseline(result(), {
      heapGrowthBytesPerRound: 40,
      rssGrowthBytesPerRound: 200,
    });
    expect(heap.failures[0]).toMatch(/heap grew/);

    const rss = applySoakBaseline(result(), {
      heapGrowthBytesPerRound: 50,
      rssGrowthBytesPerRound: 150,
    });
    expect(rss.failures[0]).toMatch(/host RSS grew/);
  });

  it('fails baseline checks when slopes cannot be measured', () => {
    const baseline = { heapGrowthBytesPerRound: 50, rssGrowthBytesPerRound: 200 };
    for (const values of [[], samples().slice(0, 1), samples().map((s) => ({ ...s, round: 1 }))]) {
      expect(
        applySoakBaseline({ ...result(), samples: values }, baseline).failures.length,
      ).toBeGreaterThan(0);
    }
    const missingHeap = samples().map((s) => ({ ...s, heapUsed: Number.NaN }));
    expect(
      applySoakBaseline({ ...result(), samples: missingHeap }, baseline).failures,
    ).toContainEqual(expect.stringMatching(/heap.*insufficient/));
    const missingRss = samples().map((s) => ({ ...s, daemonRss: null }));
    expect(
      applySoakBaseline({ ...result(), samples: missingRss }, baseline).failures,
    ).toContainEqual(expect.stringMatching(/RSS.*insufficient/));
    const partialStdio = samples();
    partialStdio[0].stdioRss = 100;
    expect(
      applySoakBaseline({ ...result(), samples: partialStdio }, baseline).failures,
    ).toContainEqual(expect.stringMatching(/stdio.*insufficient/));
  });

  it('rejects nonfinite thresholds and ignores nonfinite slope coordinates', () => {
    expect(
      applySoakBaseline(result(), {
        heapGrowthBytesPerRound: Number.POSITIVE_INFINITY,
        rssGrowthBytesPerRound: 200,
      }).failures.length,
    ).toBeGreaterThan(0);
    expect(
      slopePerRound(
        samples().map((s) => ({ ...s, round: Number.POSITIVE_INFINITY })),
        'heapUsed',
      ),
    ).toBeNull();
  });
});
