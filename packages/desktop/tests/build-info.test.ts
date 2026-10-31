import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readBuildInfo, testPaths } from '../src/main/build-info.js';
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
it('已打包的测试产物仍显式标为测试，缺少身份时阻断而不冒充正式版', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-build-info-'));
  directories.push(root);
  expect(readBuildInfo(root, false).kind).toBe('development');
  expect(() => readBuildInfo(root, true)).toThrow('PACKAGED_BUILD_IDENTITY_REQUIRED');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      kapibalaBuild: {
        kind: 'test',
        sourceSha: 'a'.repeat(40),
        dirty: true,
        platform: process.platform,
        arch: process.arch,
        verification: 'passed',
      },
    }),
  );
  expect(readBuildInfo(root, true).kind).toBe('test');
  expect(() =>
    testPaths({ kind: 'test' }, { enabled: '1', home: 'relative', userData: root }),
  ).toThrow('ISOLATED_PATHS_REQUIRED');
  expect(
    testPaths({ kind: 'test' }, { enabled: '1', home: root, userData: path.join(root, 'state') }),
  ).toEqual({ home: root, userData: path.join(root, 'state') });
});
it('正式候选必须有干净 CI 身份，不能启用专用测试目录覆盖', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-candidate-info-'));
  directories.push(root);
  const build = {
    kind: 'candidate',
    sourceSha: 'a'.repeat(40),
    dirty: false,
    platform: process.platform,
    arch: process.arch,
    verification: 'passed',
    runId: '42',
    runAttempt: '1',
  };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ kapibalaBuild: build }));
  expect(readBuildInfo(root, true).kind).toBe('candidate');
  expect(() =>
    testPaths({ kind: 'candidate' }, { enabled: '1', home: root, userData: root }),
  ).toThrow('ISOLATED_PATHS_REQUIRED');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ kapibalaBuild: { ...build, dirty: true } }),
  );
  expect(() => readBuildInfo(root, true)).toThrow('PACKAGED_BUILD_IDENTITY_REQUIRED');
});
