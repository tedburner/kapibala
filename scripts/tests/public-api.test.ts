import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectProtocolContract } from '../check-protocol-contract.js';
import { type ApiSnapshot, diffApiSnapshots } from '../check-public-api.js';

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
