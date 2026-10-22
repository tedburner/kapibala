import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { collectProtocolContract } from '../check-protocol-contract.js';
import {
  type ApiSnapshot,
  diffApiSnapshots,
  publicApiSourceIncludes,
} from '../check-public-api.js';

const fixtures = path.resolve('scripts/fixtures/public-api');

const snapshot = (names: string[]): ApiSnapshot => ({
  schemaVersion: 1,
  entries: [
    {
      id: 'core',
      entry: 'packages/core/src/index.ts',
      exports: names.map((name) => ({
        name,
        kind: 'class',
        declarations: [`declare class ${name} {}`],
      })),
    },
  ],
  packages: [],
});

describe('public contract fixtures', () => {
  it('discovers CLI sources when the Windows config and checkout are on different drives', () => {
    const windowsJoin = path.win32.join;
    const join = vi.spyOn(path, 'join').mockImplementation(windowsJoin);
    let includes: string[];
    try {
      includes = publicApiSourceIncludes('D:\\repo');
    } finally {
      join.mockRestore();
    }
    // 使用实际编译器的文件匹配器；只替换文件系统，保留异盘绝对 glob 的解析行为。
    const matchFiles = (ts as unknown as { matchFiles: (...args: unknown[]) => string[] })
      .matchFiles;
    const tree: Record<string, { files: string[]; directories: string[] }> = {
      'D:/repo/packages/cli/src': {
        files: ['index.ts'],
        directories: ['client', 'protocol', 'view-model'],
      },
      'D:/repo/packages/cli/src/client': { files: ['index.ts'], directories: [] },
      'D:/repo/packages/cli/src/protocol': { files: ['index.ts'], directories: [] },
      'D:/repo/packages/cli/src/view-model': { files: ['index.ts'], directories: [] },
    };
    const files = matchFiles(
      'C:/temp/api',
      ['.ts'],
      [],
      includes,
      false,
      'D:/repo',
      undefined,
      (directory: string) => tree[directory.replace(/\\/g, '/')] ?? { files: [], directories: [] },
      (directory: string) => directory.replace(/\\/g, '/'),
    );
    expect(files).toEqual(
      expect.arrayContaining([
        'D:/repo/packages/cli/src/client/index.ts',
        'D:/repo/packages/cli/src/protocol/index.ts',
        'D:/repo/packages/cli/src/view-model/index.ts',
      ]),
    );
  });

  it('keeps the v0.0.9 baseline and reviewed migration consistent', () => {
    const baseline = JSON.parse(
      fs.readFileSync(path.join(fixtures, 'v0.0.9/public-api.json'), 'utf8'),
    ) as ApiSnapshot;
    const current = JSON.parse(
      fs.readFileSync(path.join(fixtures, 'current.json'), 'utf8'),
    ) as ApiSnapshot;
    const migration = JSON.parse(
      fs.readFileSync(path.join(fixtures, 'migration.json'), 'utf8'),
    ) as { changes: { added: string[]; removed: string[]; changed: string[] } };
    expect(diffApiSnapshots(baseline, current)).toEqual(migration.changes);
    expect(migration.changes.removed).toContain('core:sharedWorkspaceLeaseCoordinator');
  });

  it('reports removals, additions and declaration changes separately', () => {
    expect(diffApiSnapshots(snapshot(['Kept', 'Removed']), snapshot(['Kept', 'Added']))).toEqual({
      added: ['core:Added'],
      removed: ['core:Removed'],
      changed: [],
    });
    const changed: ApiSnapshot = {
      ...snapshot(['Kept']),
      entries: [
        {
          id: 'core',
          entry: 'packages/core/src/index.ts',
          exports: [{ name: 'Kept', kind: 'class', declarations: ['declare class Kept { x: 1 }'] }],
        },
      ],
    };
    expect(diffApiSnapshots(snapshot(['Kept']), changed).changed).toEqual(['core:Kept']);
  });

  it('freezes wire methods, snapshot selectors and every advertised budget', () => {
    const contract = collectProtocolContract();
    expect(contract.methods).toContain('session/snapshot');
    expect(contract.resultSelections['session/snapshot']).toEqual([
      'snapshot:first',
      'snapshot:page',
    ]);
    expect(Object.keys(contract.limits).sort()).toEqual(
      [
        'approvalTimeoutMs',
        'initializationTimeoutMs',
        'maxConcurrentRuns',
        'maxConnections',
        'maxFrameBytes',
        'maxInflightRequests',
        'maxOpenSessions',
        'maxOperationIds',
        'maxPendingApprovals',
        'maxSendQueueBytes',
        'maxSnapshotBytes',
      ].sort(),
    );
  });
});
