import { describe, expect, it } from 'vitest';
import {
  type StatusSegment,
  buildStatusSegments,
  selectStatusSegments,
} from '../src/view-model/status.js';

describe('pure status segments', () => {
  it('keeps request context, run cumulative tokens and unknown child usage separate', () => {
    const segments = buildStatusSegments({
      phase: 'settling',
      model: 'model',
      permissionMode: 'Approval',
      gitBranch: 'main',
      contextUsage: {
        usedTokens: 1200,
        limitTokens: 8000,
        estimatedLimit: false,
        estimatedUsage: true,
      },
      runUsage: { promptTokens: 15000, completionTokens: 500, totalTokens: 15500 },
      tasks: [
        {
          agentId: 'child',
          description: 'Inspect',
          role: 'explore',
          status: 'completed',
          originBranchId: 'feature',
          isOtherBranch: true,
          delivery: 'pending',
        },
      ],
    });
    expect(segments.find((segment) => segment.id === 'context')?.text).toContain('≈1200/8000');
    expect(segments.find((segment) => segment.id === 'run-usage')?.text).toContain('15500');
    expect(segments.find((segment) => segment.id === 'children-usage')?.text).toContain('未知');
    expect(segments.find((segment) => segment.id === 'tasks')?.text).toMatch(/1.*待收集/);
    expect(segments.find((segment) => segment.id === 'task-branch')?.text).toContain('异分支');
    expect(segments.every((segment) => segment.detailRef.length > 0)).toBe(true);
    expect(JSON.stringify(segments)).not.toMatch(/树级|费用|16000/);
  });

  it('does not derive unknown context from cumulative run input or invent missing usage', () => {
    const segments = buildStatusSegments({
      phase: 'idle',
      runUsage: { promptTokens: 9000, completionTokens: 1000, totalTokens: 10000 },
    });
    expect(segments.find((segment) => segment.id === 'context')).toBeUndefined();
    expect(segments.find((segment) => segment.id === 'children-usage')).toBeUndefined();
    expect(
      buildStatusSegments({ phase: 'running' }).some((segment) => segment.id === 'run-usage'),
    ).toBe(false);
  });

  it('selects critical phase and action hints before optional metadata at narrow widths', () => {
    const segments: StatusSegment[] = [
      { id: 'model', text: 'MODEL', priority: 10, detailRef: 'model' },
      { id: 'phase', text: 'BUSY', priority: 100, detailRef: 'phase' },
      { id: 'action', text: 'STOP', priority: 90, detailRef: 'action' },
      { id: 'git', text: 'main', priority: 1, detailRef: 'git' },
    ];
    const original = JSON.stringify(segments);
    expect(
      selectStatusSegments(segments, 11, (text) => text.length).map((segment) => segment.id),
    ).toEqual(['phase', 'action']);
    expect(
      selectStatusSegments(segments, 4, (text) => text.length).map((segment) => segment.id),
    ).toEqual(['phase']);
    expect(selectStatusSegments(segments, 0, (text) => text.length)).toEqual([]);
    expect(selectStatusSegments(segments, 3, (text) => text.length)).toEqual([]);
    expect(JSON.stringify(segments)).toBe(original);
  });
});
