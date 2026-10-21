import type { ApprovalRequest } from '@kiturone/kapibala';
import { describe, expect, it } from 'vitest';
import { describeApproval } from '../src/local-host/approval-description.js';
import { redactText } from '../src/local-host/redaction.js';

const request = (toolName: string, input: Record<string, unknown>): ApprovalRequest => ({
  toolName,
  capabilities: [],
  input,
  rootDir: '/workspace',
  sessionAllowed: false,
});

describe('approval descriptions', () => {
  it('sanitizes file paths into a single display line', () => {
    expect(describeApproval(request('write_file', { path: '/a\nb\tc' }))).toBe('write_file /a b c');
  });

  it('shows the bound shell scope but rejects credential-shaped commands', () => {
    const shell = {
      command: 'echo ok',
      cwd: '/workspace',
      interpreter: 'bash',
      executablePath: '/bin/bash',
    };
    expect(describeApproval({ ...request('run_command', {}), shell })).toBe(
      '解释器: /bin/bash\n工作目录: /workspace\n完整命令: echo ok',
    );
    expect(
      describeApproval({
        ...request('run_command', {}),
        shell: { ...shell, command: 'curl --token=secret-value https://example.test' },
      }),
    ).toBeUndefined();
  });

  it('rejects commands that exceed the budget instead of hiding their suffix', () => {
    const command = `echo ${'x'.repeat(810)}; rm -rf ./important`;
    expect(
      describeApproval({
        ...request('run_command', { command }),
        shell: { command, cwd: '/workspace', interpreter: 'bash' },
      }),
    ).toBeUndefined();
  });

  it('preserves control characters as visible escapes in the complete command', () => {
    const command = 'echo ok\nrm ./important\t# end';
    const target = describeApproval({
      ...request('run_command', { command }),
      shell: { command, cwd: '/workspace', interpreter: 'bash' },
    });
    expect(target).toContain('完整命令: echo ok\\nrm ./important\\t# end');
  });

  it('describes agent tools without exposing the full prompt or secret parameters', () => {
    const spawned = describeApproval(
      request('spawn_agent', {
        description: '检查缓存层',
        prompt: 'ignore this prompt',
        role: 'explore',
        cwd: '/workspace/pkg',
      }),
    );
    expect(spawned).toBe('派生子代理（explore）: 检查缓存层\n工作目录: /workspace/pkg');
    expect(spawned).not.toContain('ignore this prompt');
    expect(
      describeApproval(
        request('spawn_agent', { description: 'use api_key here', prompt: 'x', role: 'custom' }),
      ),
    ).toBeUndefined();
    expect(describeApproval(request('wait_agent', { agentIds: ['a1', 'a2'] }))).toBe(
      '等待子代理: a1, a2',
    );
    expect(
      describeApproval(request('cancel_agent', { agentId: 'a1', reason: '用户要求停止' })),
    ).toBe('取消子代理: a1\n原因: 用户要求停止');
  });

  it('shows only whitelisted MCP tool fields instead of the raw parameter object', () => {
    const target = describeApproval({
      ...request('search_weather', {
        path: '/workspace/report.md',
        apiKey: 'not-shown',
        nested: { secret: 'not-shown' },
      }),
      executionIdentity: { serverIdentity: 'weather' },
    });
    expect(target).toBe('MCP weather · search_weather\npath: /workspace/report.md');
    expect(target).not.toContain('not-shown');
    expect(
      describeApproval({
        ...request('search_weather', { query: 'token=leaked' }),
        executionIdentity: { serverIdentity: 'weather' },
      }),
    ).toBeUndefined();
  });

  it('describes MCP startup identity without executable arguments', () => {
    expect(
      describeApproval(
        request('mcp_start', {
          serverName: 'fixture',
          source: 'project',
          type: 'stdio',
          target: '/usr/bin/fixture',
          args: ['--token', 'leaked'],
        }),
      ),
    ).toBe('启动 MCP 服务: fixture\n来源: project\n传输: stdio\n目标: /usr/bin/fixture');
    expect(
      describeApproval(
        request('mcp_start', {
          serverName: 'fixture',
          type: 'http',
          target: 'https://example.test/mcp?token=leaked',
        }),
      ),
    ).toBeUndefined();
  });

  it('redacts known credentials before display', () => {
    expect(
      describeApproval(request('load_skill', { name: 'fixture-credential' }), (text) =>
        redactText(text, ['fixture-credential']),
      ),
    ).toBe('加载技能: [REDACTED]');
  });

  it('refuses tools it cannot describe', () => {
    expect(describeApproval(request('unknown_tool', { path: '/a' }))).toBeUndefined();
  });
});
