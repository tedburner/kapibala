import { describe, expect, it } from 'vitest';
import type { ShellScope } from '../src/capabilities/security/permissions.js';
import {
  type ShellCommandClass,
  classifyShellCommandClass,
  findProtectedShellTargets,
  toShellCommandSafety,
} from '../src/capabilities/shell/command-class.js';

const ROOT = '/workspace';

function scope(command: string, overrides: Partial<ShellScope> = {}): ShellScope {
  return { command, interpreter: 'bash', cwd: ROOT, ...overrides };
}

const cases: [string, ShellCommandClass, Partial<ShellScope>?][] = [
  // read
  ['git status', 'read'],
  ['rg TODO src', 'read'],
  ['cat package.json', 'read'],
  ['find . -name "*.ts"', 'read'],
  // workspace-write
  ['pnpm build', 'workspace-write'],
  ['echo hi > out.txt', 'workspace-write'],
  ['pnpm --filter @scope/pkg test', 'workspace-write'],
  ['tsc --noEmit', 'workspace-write'],
  ['node scripts/dev.mjs', 'workspace-write'],
  ['npx biome check', 'network'],
  ['./scripts/dev.sh', 'unknown'],
  ['./scripts/dev.sh', 'workspace-write', { scriptDigest: 'a'.repeat(64) }],
  // vcs-write
  ['git add .', 'vcs-write'],
  ['git commit -m x', 'vcs-write'],
  ['git checkout main', 'vcs-write'],
  // network
  ['pnpm install', 'network'],
  ['git push', 'network'],
  ['gh pr list', 'network'],
  ['docker compose up', 'network'],
  ['curl https://example.com', 'network'],
  // destructive
  ['rm -rf build', 'destructive'],
  ['git reset --hard', 'destructive'],
  ['git restore -- .', 'destructive'],
  ['git checkout -- file', 'destructive'],
  ['git stash drop', 'destructive'],
  ['git branch -D feature', 'destructive'],
  ['git config user.name x', 'destructive'],
  ['mv a b', 'destructive'],
  // escape
  ['cd /tmp && ls', 'escape'],
  ['cat /etc/passwd', 'escape'],
  ['rg secret /home', 'escape'],
  ['echo x > /tmp/y', 'escape'],
  ['node /tmp/x.js', 'escape'],
  // unknown
  ['cat $HOME/config', 'unknown'],
  ['bash -c "ls"', 'unknown'],
  ['sed -i s/a/b/ package.json', 'unknown'],
  ['find . -exec rm {} +', 'unknown'],
  ['eval x', 'unknown'],
  ['xargs rm', 'unknown'],
];

describe('classifyShellCommandClass', () => {
  for (const [command, expected, overrides] of cases) {
    it(`classifies ${JSON.stringify(command)} as ${expected}`, () => {
      expect(classifyShellCommandClass(scope(command, overrides), ROOT)).toBe(expected);
    });
  }

  it('treats a cwd outside the workspace as escape', () => {
    expect(classifyShellCommandClass(scope('ls', { cwd: '/tmp' }), ROOT)).toBe('escape');
  });

  it('uses the digest only as a workspace-script signal', () => {
    expect(
      classifyShellCommandClass(
        scope('./scripts/build.sh', { scriptDigest: 'a'.repeat(64) }),
        ROOT,
      ),
    ).toBe('workspace-write');
  });

  it('aggregates segments by the strictest class', () => {
    expect(classifyShellCommandClass(scope('git status && rm -rf x'), ROOT)).toBe('destructive');
    expect(classifyShellCommandClass(scope('cat a | terraform plan'), ROOT)).toBe('unknown');
    expect(classifyShellCommandClass(scope('ls /etc && rm -rf x'), ROOT)).toBe('escape');
  });

  it('keeps in-workspace redirection attached to the command class', () => {
    expect(classifyShellCommandClass(scope('pnpm test > log'), ROOT)).toBe('workspace-write');
  });

  it('classifies PowerShell write cmdlets by target boundary', () => {
    expect(
      classifyShellCommandClass({ ...scope('Set-Content out.txt hi'), interpreter: 'pwsh' }, ROOT),
    ).toBe('workspace-write');
    expect(
      classifyShellCommandClass({ ...scope('Out-File /tmp/x'), interpreter: 'pwsh' }, ROOT),
    ).toBe('escape');
    expect(
      classifyShellCommandClass({ ...scope('Invoke-Expression $x'), interpreter: 'pwsh' }, ROOT),
    ).toBe('unknown');
  });
});

describe('findProtectedShellTargets', () => {
  it('finds redirections into hard-forbidden paths', () => {
    expect(findProtectedShellTargets(scope('echo x > .git/hooks/pre-commit'), ROOT)).toEqual([
      '.git/hooks/pre-commit',
    ]);
    expect(findProtectedShellTargets(scope('echo x > .kapibala/permissions.json'), ROOT)).toEqual([
      '.kapibala/permissions.json',
    ]);
  });

  it('finds cp / tee / sed -i / find -delete targets', () => {
    expect(findProtectedShellTargets(scope('cp payload .env'), ROOT)).toEqual(['.env']);
    expect(findProtectedShellTargets(scope('tee -a .env.local'), ROOT)).toEqual(['.env.local']);
    expect(findProtectedShellTargets(scope('sed -i s/a/b/ .env'), ROOT)).toEqual(['.env']);
    expect(findProtectedShellTargets(scope('find .git/hooks -delete'), ROOT)).toEqual([
      '.git/hooks',
    ]);
  });

  it('ignores example env files and targets outside the workspace', () => {
    expect(findProtectedShellTargets(scope('echo x > .env.example'), ROOT)).toEqual([]);
    expect(findProtectedShellTargets(scope('cp a /tmp/.env'), ROOT)).toEqual([]);
  });

  it('finds PowerShell write cmdlets', () => {
    expect(
      findProtectedShellTargets(
        { ...scope('Set-Content .git/hooks/pre-commit hi'), interpreter: 'pwsh' },
        ROOT,
      ),
    ).toEqual(['.git/hooks/pre-commit']);
  });
});

describe('toShellCommandSafety', () => {
  const mapping: [ShellCommandClass, string][] = [
    ['read', 'safe'],
    ['workspace-write', 'safe'],
    ['vcs-write', 'safe'],
    ['network', 'unsafe'],
    ['destructive', 'unsafe'],
    ['escape', 'unsafe'],
    ['unknown', 'unknown'],
  ];
  for (const [input, expected] of mapping) {
    it(`maps ${input} to ${expected}`, () => {
      expect(toShellCommandSafety(input)).toBe(expected);
    });
  }
});
