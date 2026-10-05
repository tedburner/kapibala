import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bumpCliVersionSource,
  bumpPackageJson,
  chooseBranchBase,
  developmentBranchName,
  isGreaterVersion,
  parseTargetVersion,
  prepareVersionBump,
  restoreVersionBump,
  sanitizeBranchName,
  sanitizeTopic,
} from '../flow.js';

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('branch naming', () => {
  it('uses local main when fetching fails even if a stale remote tracking ref exists', () => {
    expect(chooseBranchBase(false, true)).toBe('main');
    expect(chooseBranchBase(true, true)).toBe('origin/main');
    expect(chooseBranchBase(true, false)).toBe('main');
  });
  it('sanitizes topics while keeping CJK letters', () => {
    expect(sanitizeTopic('Fix Login Flow!')).toBe('fix-login-flow');
    expect(sanitizeTopic('  历史会话 压缩  ')).toBe('历史会话-压缩');
    expect(sanitizeTopic('a__b')).toBe('a-b');
    expect(sanitizeTopic('--leading..dots--')).toBe('leading.dots');
  });

  it('rejects empty topics and reserved suffixes', () => {
    expect(() => sanitizeTopic('!!!')).toThrow(/topic/i);
    expect(() => sanitizeTopic('abc.lock')).toThrow(/topic/i);
    expect(() => sanitizeBranchName('a..b')).toThrow(/branch/i);
    expect(sanitizeBranchName('-x')).toBe('x');
    expect(sanitizeBranchName('feat/demo')).toBe('feat/demo');
  });

  it('falls back to a timestamp slug when no topic is given', () => {
    const now = new Date('2026-10-05T11:48:00');
    expect(developmentBranchName('feat', undefined, now)).toBe('feat/2026-10-05-1148');
    expect(developmentBranchName('fix', 'Patch Shell Detection')).toBe('fix/patch-shell-detection');
    expect(() => developmentBranchName('release', 'x')).toThrow(/prefix/i);
  });
});

describe('version selection', () => {
  it('derives the next version or accepts an explicit greater one', () => {
    expect(parseTargetVersion(undefined, '0.0.3')).toBe('0.0.4');
    expect(parseTargetVersion('v0.1.0', '0.0.3')).toBe('0.1.0');
    expect(() => parseTargetVersion('0.0.3', '0.0.3')).toThrow(/greater/i);
    expect(() => parseTargetVersion('0.0.2', '0.0.3')).toThrow(/greater/i);
    expect(() => parseTargetVersion('0.0.10', '0.0.3')).toThrow(/version/i);
    expect(() => parseTargetVersion('abc', '0.0.3')).toThrow(/version/i);
  });

  it('compares versions numerically instead of lexicographically', () => {
    expect(isGreaterVersion('0.1.0', '0.0.9')).toBe(true);
    expect(isGreaterVersion('1.0.0', '0.9.9')).toBe(true);
    expect(isGreaterVersion('0.0.3', '0.0.3')).toBe(false);
  });
});

describe('version bumping', () => {
  it('prepares all changes before writing and leaves files intact when a source is invalid', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kapibala-flow-'));
    temporaryRoots.push(root);
    for (const file of [
      'package.json',
      'packages/core/package.json',
      'packages/cli/package.json',
    ]) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), '{"version":"0.0.3"}\n');
    }
    fs.mkdirSync(path.join(root, 'packages/cli/src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages/cli/src/version.ts'), 'invalid source\n');
    expect(() => prepareVersionBump(root, '0.0.4')).toThrow(/CLI_VERSION/);
    expect(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).toBe('{"version":"0.0.3"}\n');
  });

  it('restores only files still containing the version bump', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kapibala-flow-'));
    temporaryRoots.push(root);
    for (const file of [
      'package.json',
      'packages/core/package.json',
      'packages/cli/package.json',
    ]) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), '{"version":"0.0.3"}\n');
    }
    fs.mkdirSync(path.join(root, 'packages/cli/src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'packages/cli/src/version.ts'),
      "export const CLI_VERSION = '0.0.3';\n",
    );
    const changes = prepareVersionBump(root, '0.0.4');
    for (const change of changes) fs.writeFileSync(path.join(root, change.file), change.updated);
    fs.rmSync(path.join(root, 'packages/cli/package.json'));
    fs.writeFileSync(path.join(root, 'packages/cli/src/version.ts'), 'concurrent edit\n');
    expect(restoreVersionBump(root, changes)).toEqual([
      'packages/cli/package.json',
      'packages/cli/src/version.ts',
    ]);
    expect(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).toBe('{"version":"0.0.3"}\n');
    expect(fs.readFileSync(path.join(root, 'packages/cli/src/version.ts'), 'utf8')).toBe(
      'concurrent edit\n',
    );
  });

  it('rewrites manifest version while preserving formatting', () => {
    const content =
      '{\n  "name": "kapibala-monorepo",\n  "version": "0.0.3",\n  "private": true\n}\n';
    expect(bumpPackageJson(content, '0.0.4')).toBe(
      '{\n  "name": "kapibala-monorepo",\n  "version": "0.0.4",\n  "private": true\n}\n',
    );
    expect(() => bumpPackageJson('{"name":"x"}', '0.0.4')).toThrow(/version/i);
  });

  it('rewrites the CLI display version and fails loudly when absent', () => {
    expect(bumpCliVersionSource("export const CLI_VERSION = '0.0.3';\n", '0.0.4')).toBe(
      "export const CLI_VERSION = '0.0.4';\n",
    );
    expect(() => bumpCliVersionSource('export const x = 1;\n', '0.0.4')).toThrow(/CLI_VERSION/i);
  });
});
