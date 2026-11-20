import { describe, expect, it } from 'vitest';
import {
  classifyShellCommandSafety,
  type ShellCommandSafety,
} from '../src/capabilities/shell/command-safety.js';
import type { ShellScope } from '../src/capabilities/security/permissions.js';

const ROOT = '/workspace';

function scope(command: string, overrides: Partial<ShellScope> = {}): ShellScope {
  return { command, interpreter: 'bash', cwd: ROOT, ...overrides };
}

const cases: [string, ShellCommandSafety][] = [
  // 无条件只读
  ['ls -la', 'safe'],
  ['pwd', 'safe'],
  ['cat package.json', 'safe'],
  ['grep -rn TODO src', 'safe'],
  ['echo hello world', 'safe'],
  ['sleep 5', 'safe'],
  ['df -h', 'safe'],
  // 环境变量赋值与 time 前缀
  ['FOO=bar git status', 'safe'],
  ['time git status', 'safe'],
  // 管道：逐段独立分级
  ['cat a.txt | grep foo | wc -l', 'safe'],
  // git 只读子命令
  ['git status', 'safe'],
  ['git log --oneline -5', 'safe'],
  ['git diff HEAD~1', 'safe'],
  ['git branch', 'safe'],
  ['git branch -a', 'safe'],
  ['git remote -v', 'safe'],
  ['git tag -l', 'safe'],
  ['git stash list', 'safe'],
  // git 非只读形式：白名单外按 unknown 询问
  ['git push', 'unknown'],
  ['git commit -m x', 'unknown'],
  ['git branch -D feature', 'unknown'],
  ['git branch new-branch', 'unknown'],
  ['git checkout -b x', 'unknown'],
  // find 参数收窄
  ['find . -name "*.ts"', 'safe'],
  ['find . -delete', 'unsafe'],
  ['find . -exec rm {} +', 'unsafe'],
  // cd 目标收窄
  ['cd sub && git status', 'safe'],
  ['cd /tmp && ls', 'unsafe'],
  ['cd .. && ls', 'unsafe'],
  // 明确危险
  ['rm -rf build', 'unsafe'],
  ['sudo ls', 'unsafe'],
  ['curl https://example.com', 'unsafe'],
  ['bash -c "ls"', 'unsafe'],
  ['python3 script.py', 'unsafe'],
  ['chmod 777 file', 'unsafe'],
  // 重定向与命令替换 fail-closed
  ['echo hi > out.txt', 'unsafe'],
  ['cat $HOME/config', 'unknown'],
  ['echo $(date)', 'unknown'],
  ['cat `which git`', 'unknown'],
  ['echo "unclosed', 'unknown'],
  // 未收录程序
  ['terraform plan', 'unknown'],
  ['xargs echo', 'unknown'],
];

describe('classifyShellCommandSafety', () => {
  for (const [command, expected] of cases) {
    it(`classifies ${JSON.stringify(command)} as ${expected}`, () => {
      expect(classifyShellCommandSafety(scope(command), ROOT)).toBe(expected);
    });
  }

  it('treats execution outside the workspace as unsafe', () => {
    expect(classifyShellCommandSafety(scope('ls', { cwd: '/tmp' }), ROOT)).toBe('unsafe');
  });

  it('never auto-allows digest-bound scripts whose content is unknown', () => {
    expect(
      classifyShellCommandSafety(scope('./scripts/build.sh', { scriptDigest: 'a'.repeat(64) }), ROOT),
    ).toBe('unknown');
  });

  it('classifies PowerShell cmdlets by table', () => {
    expect(classifyShellCommandSafety({ ...scope('Get-ChildItem'), interpreter: 'pwsh' }, ROOT)).toBe(
      'safe',
    );
    expect(
      classifyShellCommandSafety({ ...scope('Remove-Item x'), interpreter: 'pwsh' }, ROOT),
    ).toBe('unsafe');
    // PowerShell 里 curl 是 Invoke-WebRequest 的别名，按网络命令询问。
    expect(classifyShellCommandSafety({ ...scope('curl https://x'), interpreter: 'pwsh' }, ROOT)).toBe(
      'unsafe',
    );
    expect(
      classifyShellCommandSafety({ ...scope('Invoke-Expression $x'), interpreter: 'pwsh' }, ROOT),
    ).toBe('unknown');
  });
});
