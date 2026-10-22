import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertReleaseEvidence } from '../check-release-evidence.js';

const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const script = fileURLToPath(new URL('../check-release-evidence.ts', import.meta.url));
const requirements = {
  'G-N20': ['node20'],
  'G-ACL': ['windows-cross-user'],
  'G-PTY': ['windows-conpty', 'macos-pty', 'linux-pty'],
  'G-TREE': ['windows-git-bash', 'windows-powershell', 'macos', 'linux'],
  'G-MCP': ['stdio', 'http'],
  'G-SOAK': ['release'],
};

function receipt() {
  return {
    schemaVersion: 1,
    commit: sha,
    checks: Object.entries(requirements).map(([id, coverage]) => ({
      id,
      coverage,
      commit: sha,
      status: 'passed',
      worktreeDirty: false,
      debugOverride: false,
      environment: 'fixture OS / Node / terminal',
      command: 'fixture acceptance command',
      logs: ['https://example.test/acceptance/report'],
      reviewer: 'fixture reviewer',
      reviewedAt: '2026-10-21T12:00:00Z',
      ...(id === 'G-SOAK' ? { rounds: 1000, durationMs: 1_800_000, baselineReviewed: true } : {}),
    })),
  };
}

describe('release acceptance evidence', () => {
  it('accepts reviewed evidence covering every required gate at the candidate SHA', () => {
    expect(() => assertReleaseEvidence(receipt(), sha)).not.toThrow();
  });

  it('rejects absent, partial, duplicate, and unknown gate receipts', () => {
    expect(() => assertReleaseEvidence(undefined, sha)).toThrow(/evidence/i);
    const partial = receipt();
    partial.checks.pop();
    expect(() => assertReleaseEvidence(partial, sha)).toThrow(/G-SOAK/);
    const duplicate = receipt();
    duplicate.checks.push(duplicate.checks[0]);
    expect(() => assertReleaseEvidence(duplicate, sha)).toThrow(/duplicate/i);
    const unknown = receipt();
    unknown.checks[0].id = 'G-UNKNOWN';
    expect(() => assertReleaseEvidence(unknown, sha)).toThrow(/unknown/i);
  });

  it('rejects stale SHAs at both the manifest and individual report boundaries', () => {
    expect(() => assertReleaseEvidence({ ...receipt(), commit: otherSha }, sha)).toThrow(/SHA/);
    const stale = receipt();
    stale.checks[2].commit = otherSha;
    expect(() => assertReleaseEvidence(stale, sha)).toThrow(/G-PTY.*SHA/);
  });

  it.each(['pending', 'failed', 'not-applicable'])('blocks a %s mandatory gate', (status) => {
    const value = receipt();
    value.checks[1].status = status;
    expect(() => assertReleaseEvidence(value, sha)).toThrow(/G-ACL.*passed/);
  });

  it('rejects partial platform coverage and missing audit information', () => {
    const value = receipt();
    value.checks[2].coverage = ['macos-pty', 'linux-pty'];
    expect(() => assertReleaseEvidence(value, sha)).toThrow(/windows-conpty/);
    for (const field of ['environment', 'command', 'reviewer', 'reviewedAt', 'logs']) {
      const incomplete = receipt();
      delete (incomplete.checks[0] as Record<string, unknown>)[field];
      expect(() => assertReleaseEvidence(incomplete, sha)).toThrow(new RegExp(field));
    }
  });

  it('rejects dirty or debug reports and a short or unreviewed release soak', () => {
    for (const field of ['worktreeDirty', 'debugOverride'] as const) {
      const value = receipt();
      value.checks[0][field] = true;
      expect(() => assertReleaseEvidence(value, sha)).toThrow(new RegExp(field));
    }
    for (const metrics of [
      { rounds: 999 },
      { durationMs: 1_799_999 },
      { baselineReviewed: false },
    ]) {
      const value = receipt();
      Object.assign(value.checks[5], metrics);
      expect(() => assertReleaseEvidence(value, sha)).toThrow(/G-SOAK/);
    }
  });

  it('fails the actual CLI without evidence and accepts receipt files or the CI environment', () => {
    const env = { ...process.env, KPBL_RELEASE_EVIDENCE: '' };
    const absent = spawnSync(process.execPath, ['--import', 'tsx', script, '--sha', sha], {
      env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(absent.status).toBe(1);
    expect(absent.stderr).toMatch(/Missing release evidence/);
    const fromEnvironment = spawnSync(process.execPath, ['--import', 'tsx', script, '--sha', sha], {
      env: { ...env, KPBL_RELEASE_EVIDENCE: JSON.stringify(receipt()) },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(fromEnvironment.status).toBe(0);
    expect(fromEnvironment.stdout).toContain('6 required gates');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-release-evidence-'));
    try {
      const file = path.join(directory, 'receipt.json');
      fs.writeFileSync(file, JSON.stringify(receipt()));
      const accepted = spawnSync(
        process.execPath,
        ['--import', 'tsx', script, '--sha', sha, '--manifest', file],
        { env, encoding: 'utf8', timeout: 10_000 },
      );
      expect(accepted.status).toBe(0);
      expect(accepted.stdout).toContain('6 required gates');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
