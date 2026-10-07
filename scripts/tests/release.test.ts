import { describe, expect, it, vi } from 'vitest';
import {
  createReleaseNotes,
  isPropagationLag,
  nextVersion,
  planPublication,
  readRegistry,
  validateNpmVersion,
  validateRelease,
  validateReleaseNotes,
} from '../release.js';

const manifests = [
  { name: 'kapibala-monorepo', version: '0.0.4' },
  { name: '@kiturone/kapibala', version: '0.0.4' },
  {
    name: '@kiturone/kapibala-cli',
    version: '0.0.4',
    dependencies: { '@kiturone/kapibala': 'workspace:*' },
  },
];
const expected = { name: '@kiturone/kapibala', version: '0.0.4', integrity: 'sha512-test' };
const existing = {
  name: expected.name,
  version: expected.version,
  dist: { integrity: expected.integrity },
};

describe('release validation', () => {
  it('rejects scaffold placeholders before a release is tagged or published', () => {
    expect(() => validateReleaseNotes('# Kapibala v0.0.4：<发布主题，发布前替换>')).toThrow(/占位/);
    expect(() => validateReleaseNotes('本版交付 <发布前补全：一段话概述>')).toThrow(/占位/);
    expect(() => validateReleaseNotes('已于 <发布日期> 发布')).toThrow(/占位/);
    expect(() => validateReleaseNotes('<!-- 交付要点：能力、边界、已知限制，逐条列出 -->')).toThrow(
      /占位/,
    );
    expect(() => validateReleaseNotes('# Kapibala v0.0.4\n\n修复历史会话恢复问题。')).not.toThrow();
  });
  it('requires an npm version with trusted-publishing support', () => {
    for (const version of ['11.5.1', '11.15.0', '12.0.2']) {
      expect(() => validateNpmVersion(version)).not.toThrow();
    }
    for (const version of ['10.9.0', '11.4.9', '11.5.0', 'unknown']) {
      expect(() => validateNpmVersion(version)).toThrow(/npm/i);
    }
  });
  it('requires one version across the tag, manifests and CLI display', () => {
    expect(validateRelease('v0.0.4', manifests, '0.0.4')).toBe('0.0.4');
    expect(() => validateRelease('v0.0.5', manifests, '0.0.4')).toThrow(/version/i);
    expect(() => validateRelease('v0.0.4', manifests, '0.0.3')).toThrow(/version/i);
    expect(() =>
      validateRelease(
        'v0.0.4',
        [manifests[0], { ...manifests[1], version: '0.0.3' }, manifests[2]],
        '0.0.4',
      ),
    ).toThrow(/version/i);
  });

  it('rejects malformed, prerelease and non-decimal-position tags', () => {
    for (const tag of [
      'main',
      'v0.0.10',
      'v0.10.0',
      'v0.0.4-beta.1',
      'v00.0.4',
      'v0.0.4\ninjected',
    ]) {
      expect(() => validateRelease(tag, manifests, '0.0.4')).toThrow(/tag/i);
    }
  });

  it('carries decimal positions to the next version', () => {
    expect(nextVersion('0.0.3')).toBe('0.0.4');
    expect(nextVersion('0.0.9')).toBe('0.1.0');
    expect(nextVersion('0.9.0')).toBe('0.9.1');
    expect(nextVersion('0.9.9')).toBe('1.0.0');
    expect(nextVersion('2.9.9')).toBe('3.0.0');
    expect(() => nextVersion('0.0.10')).toThrow(/version/i);
    expect(() => nextVersion('v0.0.3')).toThrow(/version/i);
  });

  it('treats only registry propagation lag as a retryable smoke failure', () => {
    expect(
      isPropagationLag(
        'npm failed: npm error code ETARGET\nnpm error notarget No matching version found for @kiturone/kapibala-cli@0.0.4.',
      ),
    ).toBe(true);
    expect(isPropagationLag('npm failed: 1')).toBe(false);
    expect(isPropagationLag('npm failed: npm error code ECONNREFUSED')).toBe(false);
    expect(isPropagationLag('npm failed: npm error code E404 - Not found')).toBe(false);
  });

  it('prepares a new publication and skips only an identical existing version', () => {
    expect(planPublication(expected, { 'dist-tags': { latest: '0.0.3' }, versions: {} })).toBe(
      'publish',
    );
    expect(
      planPublication(expected, {
        'dist-tags': { latest: '0.0.4' },
        versions: { '0.0.4': existing },
      }),
    ).toBe('skip');
    expect(() =>
      planPublication(expected, {
        'dist-tags': { latest: '0.0.4' },
        versions: { '0.0.4': { ...existing, dist: { integrity: 'different' } } },
      }),
    ).toThrow(/integrity/i);
  });

  it('refuses to downgrade latest or silently repair an inconsistent existing tag', () => {
    expect(() =>
      planPublication(expected, { 'dist-tags': { latest: '0.0.5' }, versions: {} }),
    ).toThrow(/newer/i);
    expect(() =>
      planPublication(expected, {
        'dist-tags': { latest: '0.0.3' },
        versions: { '0.0.4': existing },
      }),
    ).toThrow(/latest/i);
  });

  it('converts release-note relative links to the pinned source tag', () => {
    expect(
      createReleaseNotes(
        '[Migration](../migration/v0.0.4.md) [Web](https://example.com)',
        'v0.0.4',
      ),
    ).toBe(
      '[Migration](https://github.com/tedburner/kapibala/blob/v0.0.4/docs/migration/v0.0.4.md) [Web](https://example.com)',
    );
  });
});

describe('public registry lookup', () => {
  it('treats only HTTP 404 as an absent package', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    expect(await readRegistry(expected.name, fetcher)).toEqual({ versions: {} });
    fetcher.mockResolvedValue(new Response('unavailable', { status: 503 }));
    await expect(readRegistry(expected.name, fetcher)).rejects.toThrow(/503/);
  });

  it('rejects malformed metadata and propagates transport failures before publishing', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'bad metadata' })));
    await expect(readRegistry(expected.name, fetcher)).rejects.toThrow(/metadata/i);
    fetcher.mockRejectedValue(new Error('connection reset'));
    await expect(readRegistry(expected.name, fetcher)).rejects.toThrow(/connection reset/);
  });
});
