import { describe, expect, it } from 'vitest';
import {
  type CommandCandidate,
  matchCommandCandidates,
  moveCommandSelection,
  selectCommandWindow,
} from '../src/view-model/commands.js';

const command = (
  name: string,
  baseOrder: number,
  extra: Partial<Extract<CommandCandidate, { kind: 'command' }>> = {},
): CommandCandidate => ({
  kind: 'command',
  id: `command:${name}`,
  name,
  description: '',
  sourceLabel: '内置命令',
  baseOrder,
  ...extra,
});

const ids = (candidates: readonly CommandCandidate[], query: string) =>
  matchCommandCandidates(candidates, query).map((match) => match.candidate.id);

describe('command palette metadata matching', () => {
  it('orders exact, prefix, substring and subsequence fuzzy name matches before base order', () => {
    const candidates = [
      command('method', 0),
      command('remodel', 1),
      command('models', 2),
      command('model', 3),
      command('else', 4, { description: 'model', sourceLabel: 'model' }),
      command('mod', 5),
    ];
    expect(ids(candidates, '/MoD')).toEqual([
      'command:mod',
      'command:models',
      'command:model',
      'command:remodel',
      'command:method',
    ]);
    expect(matchCommandCandidates(candidates, 'model')[0].match).toBe('exact');
  });

  it('keeps stable base order within the same name match tier regardless of metadata text', () => {
    expect(
      ids(
        [
          command('model-z', 1),
          command('model-a', 2, { description: 'model', sourceLabel: 'model' }),
        ],
        'model',
      ),
    ).toEqual(['command:model-z', 'command:model-a']);
  });

  it('uses curated commands, opaque skill IDs and prompt server/name order on bare Slash', () => {
    const candidates: readonly CommandCandidate[] = [
      {
        kind: 'prompt',
        id: 'prompt:z/a',
        name: 'same',
        description: '',
        sourceLabel: 'z',
        server: 'z',
        promptName: 'a',
      },
      { kind: 'skill', id: 'skill:z', name: 'same', description: '', sourceLabel: '项目' },
      command('z', 1),
      {
        kind: 'prompt',
        id: 'prompt:a/z',
        name: 'same',
        description: '',
        sourceLabel: 'a',
        server: 'a',
        promptName: 'z',
      },
      { kind: 'skill', id: 'skill:a', name: 'same', description: '', sourceLabel: '用户' },
      command('a', 2),
      {
        kind: 'prompt',
        id: 'prompt:a/a',
        name: 'same',
        description: '',
        sourceLabel: 'a',
        server: 'a',
        promptName: 'a',
      },
    ];
    const expected = [
      'command:z',
      'command:a',
      'skill:a',
      'skill:z',
      'prompt:a/a',
      'prompt:a/z',
      'prompt:z/a',
    ];
    expect(ids(candidates, '/')).toEqual(expected);
    expect(ids([...candidates].reverse(), ' / ')).toEqual(expected);
    expect(ids(candidates, 'same')).toEqual(expected.slice(2));
  });

  it('shows one canonical action while aliases still participate in matching', () => {
    const exit = command('exit', 1, { aliases: ['quit', '/q'] });
    const candidates = [exit, exit, command('status', 0)];
    expect(ids(candidates, '/')).toEqual(['command:status', 'command:exit']);
    expect(ids(candidates, '/qui')).toEqual(['command:exit']);
    expect(matchCommandCandidates(candidates, '/q')[0]).toMatchObject({
      candidate: { name: 'exit', id: 'command:exit' },
      match: 'exact',
      matchedName: '/q',
    });
  });

  it('preserves host availability and execution references without using them as authority', () => {
    const candidate = command('model', 0, {
      argumentHint: '<id>',
      availability: { enabled: false, reason: '任务正在收尾' },
      executionRef: 'opaque-invocation',
    });
    expect(matchCommandCandidates([candidate], '/')[0].candidate).toBe(candidate);
  });

  it('does not mutate source metadata and safely returns no results for unmatched names', () => {
    const candidates = Object.freeze([
      Object.freeze(command('status', 2)),
      Object.freeze(command('help', 1)),
    ]);
    expect(ids(candidates, '/')).toEqual(['command:help', 'command:status']);
    expect(candidates.map((candidate) => candidate.name)).toEqual(['status', 'help']);
    expect(matchCommandCandidates(candidates, 'missing')).toEqual([]);
  });
});

describe('complete command list selection window', () => {
  const matches = matchCommandCandidates(
    Array.from({ length: 7 }, (_, index) => command(`item-${index}`, index)),
    '/',
  );

  it('defaults to three visible rows and counts all hidden results', () => {
    expect(selectCommandWindow(matches)).toMatchObject({
      selectedIndex: 0,
      startIndex: 0,
      remainingCount: 4,
      moreLabel: '+4 more',
    });
    expect(selectCommandWindow(matches).visible).toEqual(matches.slice(0, 3));
    expect(matches).toHaveLength(7);
  });

  it('allows navigation to every result and scrolls only when the selected row leaves the window', () => {
    let index = 0;
    let start = 0;
    for (let expected = 1; expected < matches.length; expected += 1) {
      index = moveCommandSelection(matches.length, index, 1);
      const window = selectCommandWindow(matches, index, start);
      expect(index).toBe(expected);
      expect(window.visible).toContain(matches[expected]);
      expect(window.remainingCount).toBe(4);
      start = window.startIndex;
    }
    expect(start).toBe(4);
    expect(selectCommandWindow(matches, 5, start).startIndex).toBe(4);
    expect(selectCommandWindow(matches, 3, start).startIndex).toBe(3);
    expect(moveCommandSelection(matches.length, index, 1)).toBe(6);
    expect(moveCommandSelection(matches.length, 0, -1)).toBe(0);
  });

  it('handles empty results, stale indices, shorter replacement lists and invalid numeric inputs', () => {
    expect(selectCommandWindow([])).toEqual({
      selectedIndex: -1,
      startIndex: 0,
      visible: [],
      remainingCount: 0,
      moreLabel: undefined,
    });
    expect(moveCommandSelection(0, 20, 1)).toBe(-1);
    expect(selectCommandWindow(matches.slice(0, 2), 6, 4)).toMatchObject({
      selectedIndex: 1,
      startIndex: 0,
      remainingCount: 0,
      moreLabel: undefined,
    });
    expect(
      selectCommandWindow(matches, Number.NaN, Number.POSITIVE_INFINITY, 0).visible,
    ).toHaveLength(1);
    expect(moveCommandSelection(matches.length, Number.NaN, Number.NaN)).toBe(0);
  });
});
