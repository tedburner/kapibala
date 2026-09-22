import { describe, expect, it } from 'vitest';
import { getCurrentGitBranch } from '../src/git.js';

describe('getCurrentGitBranch', () => {
  it('returns the trimmed branch name reported by Git', () => {
    expect(getCurrentGitBranch('C:\\repo', () => '  feature/footer  \n')).toBe('feature/footer');
  });

  it('returns undefined when Git cannot resolve a branch', () => {
    expect(getCurrentGitBranch('C:\\not-a-repo', () => '')).toBeUndefined();
    expect(
      getCurrentGitBranch('C:\\not-a-repo', () => {
        throw new Error('not a git repository');
      }),
    ).toBeUndefined();
  });
});
