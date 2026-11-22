import { describe, expect, it } from 'vitest';
import type { ShellScope } from '../src/capabilities/security/permissions.js';
import {
  type ShellCommandSafety,
  classifyShellCommandSafety,
} from '../src/capabilities/shell/command-safety.js';

const ROOT = '/workspace';

function scope(command: string, overrides: Partial<ShellScope> = {}): ShellScope {
  return { command, interpreter: 'bash', cwd: ROOT, ...overrides };
}

const cases: [string, ShellCommandSafety, Partial<ShellScope>?][] = [
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
  // git 写操作：vcs-write 映射为 safe，网络与破坏性仍询问
  ['git push', 'unsafe'],
  ['git commit -m x', 'safe'],
  ['git branch -D feature', 'unsafe'],
  ['git branch new-branch', 'safe'],
  ['git checkout -b x', 'safe'],
  // find 参数收窄
  ['find . -name "*.ts"', 'safe'],
  ['find . -delete', 'unsafe'],
  ['find . -exec rm {} +', 'unknown'],
  // cd 目标收窄
  ['cd sub && git status', 'safe'],
  ['cd /tmp && ls', 'unsafe'],
  ['cd .. && ls', 'unsafe'],
  // 明确危险
  ['rm -rf build', 'unsafe'],
  ['sudo ls', 'unsafe'],
  ['curl https://example.com', 'unsafe'],
  ['bash -c "ls"', 'unknown'],
  ['python3 script.py', 'safe', { scriptTrust: 'clean' }],
  ['python3 script.py', 'unknown'],
  ['chmod 777 file', 'unsafe'],
  // 重定向：工作区内目标不降级，越界仍询问
  ['echo hi > out.txt', 'safe'],
  ['echo hi > /tmp/out.txt', 'unsafe'],
  // 命令替换与变量 fail-closed
  ['cat $HOME/config', 'unknown'],
  ['echo $(date)', 'unknown'],
  ['cat `which git`', 'unknown'],
  ['echo "unclosed', 'unknown'],
  // 未收录程序
  ['terraform plan', 'unknown'],
  ['xargs echo', 'unknown'],
  // 进程替换：写端不可判读，fail-closed
  ['echo x >(tee .env)', 'unknown'],
  ['echo x > >(cat > .env)', 'unknown'],
  // sed 原地改写（含 -i.bak 后缀形态）不可按程序名放行
  ["sed -i.bak 's/a/b/' .env", 'unknown'],
  ['sed -n 1p .env', 'safe'],
  // escape 类敏感路径写入：三值 unsafe，Auto/Approval 询问
  ['echo x > .github/workflows/ci.yml', 'unsafe'],
  ['tee .git-credentials', 'unsafe'],
  ['echo x > .npmrc', 'unsafe'],
  ['cat > .netrc', 'unsafe'],
  ['echo x > docs/a.md', 'safe'],
  // glob 目标无法静态归因
  ['echo x > .git/*/pre-commit', 'unknown'],
  // PowerShell 路径型读 cmdlet 的越界检查
  ['Get-Content /etc/passwd', 'unsafe', { interpreter: 'pwsh' }],
  ['Get-Content ./a.txt', 'safe', { interpreter: 'pwsh' }],
  ['Select-String -Path /etc/passwd -Pattern x', 'unsafe', { interpreter: 'pwsh' }],
];

describe('classifyShellCommandSafety', () => {
  for (const [command, expected, overrides] of cases) {
    it(`classifies ${JSON.stringify(command)} as ${expected}`, () => {
      expect(classifyShellCommandSafety(scope(command, overrides), ROOT)).toBe(expected);
    });
  }

  it('treats execution outside the workspace as unsafe', () => {
    expect(classifyShellCommandSafety(scope('ls', { cwd: '/tmp' }), ROOT)).toBe('unsafe');
  });

  it('treats a digest-bound workspace script as safe only when git-clean', () => {
    expect(
      classifyShellCommandSafety(
        scope('./scripts/build.sh', { scriptDigest: 'a'.repeat(64), scriptTrust: 'clean' }),
        ROOT,
      ),
    ).toBe('safe');
    expect(
      classifyShellCommandSafety(
        scope('./scripts/build.sh', { scriptDigest: 'a'.repeat(64), scriptTrust: 'dirty' }),
        ROOT,
      ),
    ).toBe('unknown');
    expect(
      classifyShellCommandSafety(
        scope('./scripts/build.sh', { scriptDigest: 'a'.repeat(64) }),
        ROOT,
      ),
    ).toBe('unknown');
  });

  it('classifies PowerShell cmdlets by table', () => {
    expect(
      classifyShellCommandSafety({ ...scope('Get-ChildItem'), interpreter: 'pwsh' }, ROOT),
    ).toBe('safe');
    expect(
      classifyShellCommandSafety({ ...scope('Remove-Item x'), interpreter: 'pwsh' }, ROOT),
    ).toBe('unsafe');
    // PowerShell 里 curl 是 Invoke-WebRequest 的别名，按网络命令询问。
    expect(
      classifyShellCommandSafety({ ...scope('curl https://x'), interpreter: 'pwsh' }, ROOT),
    ).toBe('unsafe');
    expect(
      classifyShellCommandSafety({ ...scope('Invoke-Expression $x'), interpreter: 'pwsh' }, ROOT),
    ).toBe('unknown');
  });
});
