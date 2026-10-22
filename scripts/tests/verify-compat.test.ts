import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CompatCombo,
  type HarnessResult,
  checkTarball,
  isLegacyInstallValid,
  readLegacyManifest,
} from '../verify-compat.js';

const candidate: CompatCombo = { id: 'new-new', client: 'new', host: 'new' };
const legacy: CompatCombo = { id: 'old-old', client: 'old', host: 'old' };

const normal = (combo: CompatCombo): HarnessResult => ({
  ok: true,
  transport: 'stdio',
  clientVersion: combo.client === 'old' ? 'old' : 'candidate',
  negative: {
    invalidParams: 'INVALID_PARAMS',
    pingAfterInvalid: true,
  },
  list: { before: 0, after: 1, cursor: null },
  tool: { outcome: 'completed', file: 'compat' },
  dedupe: { sameRunId: true, newEvents: 0 },
  approval: {
    outcome: 'completed',
    file: 'approved',
    prompts: [{ toolName: 'write_file', target: 'write_file compat/approved.txt' }],
  },
  cancel: { outcome: 'cancelled' },
  historyClosed: true,
  reopened: { messages: 3, historyClosed: true },
  events: { toolFinishes: 2, texts: ['tool-done', 'partial'] },
  hostExit: { code: 0, signal: null },
  daemonStopped: true,
  stderr: '',
});

const cursor = (combo: CompatCombo): HarnessResult => ({
  ok: true,
  transport: 'stdio',
  clientVersion: combo.client === 'old' ? 'old' : 'candidate',
  unsupportedCapability: 'PROTOCOL_MISMATCH',
  longRun: { outcome: 'completed', textLength: 73_739 },
  snapshot: {
    messages: 2,
    historyClosed: true,
    firstPageCursor: true,
    firstPageBytes: 196_094,
  },
  explicitCursor:
    combo.client === 'old'
      ? { rejected: true, error: 'Unexpected token', aliveAfter: false }
      : { rejected: false, chunk: true, hasHistory: false, cursor: true, aliveAfter: true },
  daemonStopped: true,
  stderr: '',
});

describe('compat evidence helpers', () => {
  it('accepts both client generations on the normal path', async () => {
    const { assertNormalResult } = await import('../verify-compat.js');
    expect(() => assertNormalResult(normal(candidate), candidate)).not.toThrow();
    expect(() => assertNormalResult(normal(legacy), legacy)).not.toThrow();
  });

  it('rejects placeholder legacy validation evidence', async () => {
    const { assertNormalResult } = await import('../verify-compat.js');
    expect(() =>
      assertNormalResult(
        {
          ...normal(legacy),
          negative: {
            invalidParams: 'legacy-client-skips-local-validation',
            pingAfterInvalid: true,
          },
        },
        legacy,
      ),
    ).toThrow(/INVALID_PARAMS/);
  });

  it('rejects replay events, weak approvals and unclean shutdown', async () => {
    const { assertNormalResult } = await import('../verify-compat.js');
    expect(() =>
      assertNormalResult(
        { ...normal(candidate), dedupe: { sameRunId: true, newEvents: 1 } },
        candidate,
      ),
    ).toThrow(/replay emitted new events/);
    expect(() =>
      assertNormalResult(
        { ...normal(candidate), approval: { outcome: 'completed', file: 'approved', prompts: [] } },
        candidate,
      ),
    ).toThrow(/approval prompt/);
    expect(() =>
      assertNormalResult(
        { ...normal(candidate), hostExit: { code: null, signal: 'SIGTERM' } },
        candidate,
      ),
    ).toThrow(/exit cleanly/);
  });

  it('keeps the old cursor defect version-specific', async () => {
    const { assertCursorResult } = await import('../verify-compat.js');
    expect(() => assertCursorResult(cursor(candidate), candidate)).not.toThrow();
    expect(() => assertCursorResult(cursor(legacy), legacy)).not.toThrow();
    expect(() =>
      assertCursorResult(
        { ...cursor(legacy), explicitCursor: { rejected: true, aliveAfter: true } },
        legacy,
      ),
    ).toThrow(/cursor defect/);
    expect(() =>
      assertCursorResult(
        {
          ...cursor(candidate),
          explicitCursor: {
            rejected: false,
            chunk: true,
            hasHistory: true,
            cursor: true,
            aliveAfter: true,
          },
        },
        candidate,
      ),
    ).toThrow(/cursor page shape/);
    expect(() =>
      assertCursorResult({ ...cursor(candidate), unsupportedCapability: 'accepted' }, candidate),
    ).toThrow(/unknown capability/);
  });

  it('compares tarball bytes against the fixed sha256 and integrity', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-compat-test-'));
    const file = path.join(directory, 'fixture.tgz');
    const bytes = Buffer.from('fixed legacy tarball bytes');
    fs.writeFileSync(file, bytes);
    const expected = {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    };
    try {
      expect(checkTarball(file, expected)).toMatchObject({ ok: true, bytes: bytes.length });
      fs.writeFileSync(file, Buffer.from('tampered'));
      expect(checkTarball(file, expected).ok).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects floating or non-registry legacy manifests', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-compat-manifest-'));
    const write = (entries: unknown[]) => {
      const file = path.join(directory, 'manifest.json');
      fs.writeFileSync(file, JSON.stringify(entries));
      return file;
    };
    const valid = readLegacyManifest();
    const entry = valid[0];
    try {
      expect(() =>
        readLegacyManifest(
          write([{ ...entry, tarball: 'https://example.com/kapibala.tgz' }, ...valid.slice(1)]),
        ),
      ).toThrow(/registry\.npmjs\.org/);
      expect(() =>
        readLegacyManifest(write([{ ...entry, version: 'latest' }, ...valid.slice(1)])),
      ).toThrow(/Invalid legacy version/);
      expect(() =>
        readLegacyManifest(write([{ ...entry, name: '@kiturone/other' }, ...valid.slice(1)])),
      ).toThrow(/package names/);
      expect(isLegacyInstallValid(directory, valid)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
