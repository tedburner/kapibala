import { describe, expect, it } from 'vitest';
import { parseSkillDocument } from '../src/capabilities/skills/frontmatter.js';

describe('skill frontmatter contract', () => {
  it.each(["Review the user's code", "Don't skip tests"])(
    'accepts plain description %s',
    (description) => {
      const result = parseSkillDocument(
        `---\nname: review\ndescription: ${description} # note\n---\nbody`,
        '/skills/review/SKILL.md',
      );
      expect(result.description).toBe(description);
    },
  );
  it('parses folded descriptions, lists and metadata without consuming body separators', () => {
    const result = parseSkillDocument(
      '\uFEFF---\r\nname: review\r\ndescription: >-\r\n  Review code\r\n  before merging.\r\nallowed-tools:\r\n  - Read\r\n  - Grep\r\nmetadata:\r\n  author: "team #1"\r\n---\r\n# Review\r\n---\r\nKeep this.\r\n',
      '/skills/review/SKILL.md',
    );
    expect(result.description).toBe('Review code before merging.');
    expect(result.allowedTools).toEqual(['Read', 'Grep']);
    expect(result.metadata).toEqual({ author: 'team #1' });
    expect(result.body).toBe('# Review\n---\nKeep this.\n');
    expect(result.available).toBe(true);
  });

  it.each([
    ['|', 'one\ntwo\n'],
    ['|-', 'one\ntwo'],
    ['|+', 'one\ntwo\n\n'],
    ['>', 'one two\n'],
  ])('preserves block scalar %s semantics', (indicator, expected) => {
    const result = parseSkillDocument(
      `---\nname: review\ndescription: ${indicator}\n  one\n  two\n\n---\nbody`,
      '/skills/review/SKILL.md',
    );
    expect(result.description).toBe(expected);
  });

  it('folds blank lines between plain lines and keeps extra breaks around more-indented lines', () => {
    const result = parseSkillDocument(
      '---\nname: review\ndescription: >\n  alpha\n\n  beta\n---\nbody',
      '/skills/review/SKILL.md',
    );
    expect(result.description).toBe('alpha\nbeta\n');
    const indented = parseSkillDocument(
      '---\nname: review\ndescription: >\n  para\n\n   * bullet\n\n   * list\n\n  tail\n---\nbody',
      '/skills/review/SKILL.md',
    );
    expect(indented.description).toBe('para\n\n * bullet\n\n * list\n\ntail\n');
  });

  it('keeps isolated quotes in plain scalars while still cutting trailing comments', () => {
    const result = parseSkillDocument(
      `---\nname: review\ndescription: Don't — "ok" and 'oops # note\n---\nbody`,
      '/skills/review/SKILL.md',
    );
    expect(result.description).toBe(`Don't — "ok" and 'oops`);
  });

  it('keeps independent user and model invocation controls', () => {
    const result = parseSkillDocument(
      '---\ndescription: "Review: safely # now" # comment\ndisable-model-invocation: true\nuser-invocable: false\nallowed-tools: ["Read", Grep]\n---\nbody',
      '/skills/review/SKILL.md',
    );
    expect(result.name).toBe('review');
    expect(result.modelInvocable).toBe(false);
    expect(result.userInvocable).toBe(false);
    expect(result.diagnostics.some((d) => d.code === 'SKILL_NAME_FALLBACK')).toBe(true);
  });

  it.each([
    'name: review\ndescription: ok\nname: again',
    'name: review\ndescription: ok\ndisable-model-invocation: yes',
    'name: review\ndescription: &anchor ok',
    'name: review\ndescription: "unclosed',
    "name: review\ndescription: 'one' 'two'",
    'name: bad--name\ndescription: ok',
    'name: review\ndescription: 123',
  ])('rejects unsafe or malformed metadata', (header) => {
    expect(() =>
      parseSkillDocument(`---\n${header}\n---\nbody`, '/skills/review/SKILL.md'),
    ).toThrow();
  });

  it('diagnoses unsupported execution fields rather than silently running inline', () => {
    const result = parseSkillDocument(
      '---\nname: review\ndescription: ok\ncontext: fork\n---\nbody',
      '/skills/review/SKILL.md',
    );
    expect(result.available).toBe(false);
    expect(result.diagnostics.some((d) => d.code === 'SKILL_UNSUPPORTED')).toBe(true);
  });

  it('retains long descriptions but rejects unclosed and oversized headers', () => {
    const result = parseSkillDocument(
      `---\nname: review\ndescription: ${'文'.repeat(1100)}\n---\nbody`,
      '/skills/review/SKILL.md',
    );
    expect(Array.from(result.description)).toHaveLength(1100);
    expect(result.diagnostics.some((d) => d.code === 'SKILL_DESCRIPTION_LONG')).toBe(true);
    expect(() => parseSkillDocument('---\ndescription: ok', '/skills/review/SKILL.md')).toThrow();
    expect(() =>
      parseSkillDocument(
        `---\ndescription: ${'x'.repeat(17000)}\n---\nbody`,
        '/skills/review/SKILL.md',
      ),
    ).toThrow();
  });
});
