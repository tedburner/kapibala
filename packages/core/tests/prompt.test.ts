import { describe, expect, it } from 'vitest';
import { PromptAssembler } from '../src/prompt/index.js';

describe('PromptAssembler tool-use guidance', () => {
  it('prefers a direct file read and stops redundant discovery once evidence is sufficient', () => {
    const prompt = new PromptAssembler({ rootDir: '/workspace' }).assemble();

    expect(prompt).toContain('When the user provides an exact file path, read it directly');
    expect(prompt).toContain('Do not broaden a successful exact lookup');
    expect(prompt).toContain('Stop calling tools once you have enough evidence');
    expect(prompt).toContain('Do not repeat an identical failed tool call');
  });
});
