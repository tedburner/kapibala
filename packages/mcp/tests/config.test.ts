import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type McpConfigFile, resolveMcpConfig, validateServerName } from '../src/config.js';

describe('MCP Configuration & Server Name Validation (Task 3.2)', () => {
  // =========================================================================
  // Server 严格命名校验
  // =========================================================================
  describe('validateServerName', () => {
    it('accepts valid server names matching ^[a-zA-Z0-9_-]+$', () => {
      expect(validateServerName('github').valid).toBe(true);
      expect(validateServerName('my-mcp-server_123').valid).toBe(true);
      expect(validateServerName('UPPER_lower-99').valid).toBe(true);
      expect(validateServerName('a'.repeat(64)).valid).toBe(true);
    });

    it('rejects empty or non-string names', () => {
      expect(validateServerName('').valid).toBe(false);
      // @ts-expect-error test runtime boundary
      expect(validateServerName(null).valid).toBe(false);
      // @ts-expect-error test runtime boundary
      expect(validateServerName(undefined).valid).toBe(false);
    });

    it('rejects names exceeding 64 characters', () => {
      const result = validateServerName('a'.repeat(65));
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/exceeds maximum allowed length/i);
    });

    it('strictly rejects names with slashes (preventing Prompt ID ambiguity)', () => {
      expect(validateServerName('org/server').valid).toBe(false);
      expect(validateServerName('server\\sub').valid).toBe(false);
    });

    it("strictly rejects names with consecutive double underscores '__' (preventing tool name ambiguity)", () => {
      const result = validateServerName('my__server');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/consecutive double underscores/i);
    });

    it('strictly rejects special characters, spaces, and dots', () => {
      expect(validateServerName('server.name').valid).toBe(false);
      expect(validateServerName('server name').valid).toBe(false);
      expect(validateServerName('server$var').valid).toBe(false);
      expect(validateServerName('server@domain').valid).toBe(false);
    });
  });

  // =========================================================================
  // resolveMcpConfig 纯函数解析测试
  // =========================================================================
  describe('resolveMcpConfig', () => {
    it('returns empty servers and no fatal error when no configuration is present', () => {
      const result1 = resolveMcpConfig({ isProjectTrusted: true });
      expect(result1.servers.size).toBe(0);
      expect(result1.diagnostics).toHaveLength(0);
      expect(result1.hasFatalError).toBe(false);

      const result2 = resolveMcpConfig({
        globalConfig: {},
        projectConfig: {},
        isProjectTrusted: true,
      });
      expect(result2.servers.size).toBe(0);
      expect(result2.hasFatalError).toBe(false);
    });

    it('correctly discriminates between stdio and http server configs', () => {
      const globalConfig: McpConfigFile = {
        mcpServers: {
          git: {
            command: 'node',
            args: ['./mcp-git.js'],
          },
          remote_api: {
            url: 'https://mcp.example.com/sse',
            headers: { Authorization: 'Bearer test-token' },
          },
        },
      };

      const result = resolveMcpConfig({
        globalConfig,
        isProjectTrusted: true,
      });

      expect(result.servers.size).toBe(2);
      expect(result.hasFatalError).toBe(false);

      const git = result.servers.get('git');
      expect(git?.config.type).toBe('stdio');
      if (git?.config.type === 'stdio') {
        expect(git.config.command).toBe('node');
        expect(git.config.args).toEqual(['./mcp-git.js']);
      }

      const remote = result.servers.get('remote_api');
      expect(remote?.config.type).toBe('http');
      if (remote?.config.type === 'http') {
        expect(remote.config.url).toBe('https://mcp.example.com/sse');
        expect(remote.config.headers).toEqual({ Authorization: 'Bearer test-token' });
      }
    });

    it('flags fatal error when required server has invalid name or missing required fields', () => {
      const globalConfig: McpConfigFile = {
        mcpServers: {
          bad__name: {
            required: true,
            command: 'node',
          },
          broken_required: {
            required: true,
            // missing command or url
          },
          broken_optional: {
            required: false,
            // missing command or url
          },
        },
      };

      const result = resolveMcpConfig({
        globalConfig,
        isProjectTrusted: true,
      });

      // bad__name 和 broken_required 都是 required，导致 fatal
      expect(result.hasFatalError).toBe(true);
      expect(result.servers.has('bad__name')).toBe(false);
      expect(result.servers.has('broken_required')).toBe(false);
      expect(result.servers.has('broken_optional')).toBe(false);
      expect(result.diagnostics.length).toBeGreaterThanOrEqual(3);
    });

    it('excludes project config and retains global config when project is untrusted', () => {
      const globalConfig: McpConfigFile = {
        mcpServers: {
          trusted_global: {
            command: 'global-tool',
          },
          target_override: {
            command: 'global-command',
          },
        },
      };

      const projectConfig: McpConfigFile = {
        mcpServers: {
          project_only: {
            command: 'malicious-script',
          },
          target_override: {
            command: 'hijacked-command',
          },
        },
      };

      const result = resolveMcpConfig({
        globalConfig,
        projectConfig,
        isProjectTrusted: false, // 未受信任！
      });

      // 未受信任时，项目配置被全量排除
      expect(result.servers.has('project_only')).toBe(false);
      expect(result.servers.get('target_override')?.config).toMatchObject({
        command: 'global-command',
      });
      expect(result.servers.get('trusted_global')?.config).toMatchObject({
        command: 'global-tool',
      });

      // 生成了未信任警告诊断
      const untrustedDiags = result.diagnostics.filter((d) => d.code === 'MCP_PROJECT_UNTRUSTED');
      expect(untrustedDiags).toHaveLength(2);
    });

    it('performs whole-item override and enforces no fallback for disabled servers', () => {
      const globalConfig: McpConfigFile = {
        mcpServers: {
          my_server: {
            command: 'global-bin',
            args: ['--global-flag'],
            env: { SECRET: 'global' },
            enabled: true,
          },
          to_be_disabled: {
            command: 'active-service',
            enabled: true,
          },
        },
      };

      const projectConfig: McpConfigFile = {
        mcpServers: {
          my_server: {
            command: 'project-bin',
            args: ['--project-flag'],
            // 没有提供 env
          },
          to_be_disabled: {
            enabled: false,
          },
        },
      };

      const result = resolveMcpConfig({
        globalConfig,
        projectConfig,
        isProjectTrusted: true, // 受信任
      });

      // 1. 整项覆盖断言：不拼接 args，不浅合并全局的 env
      const myServer = result.servers.get('my_server');
      expect(myServer?.source).toBe('project');
      if (myServer?.config.type === 'stdio') {
        expect(myServer.config.command).toBe('project-bin');
        expect(myServer.config.args).toEqual(['--project-flag']);
        expect(myServer.config.env).toBeUndefined(); // 绝不补充全局 SECRET！
      }

      // 2. 禁用不回退断言：项目级标记 enabled: false 后，处于禁用态，绝不回退到全局启用配置
      const disabledServer = result.servers.get('to_be_disabled');
      expect(disabledServer?.source).toBe('project');
      expect(disabledServer?.config.enabled).toBe(false);
    });

    it('reads and validates the minimal configuration example documented in docs/mcp.md', () => {
      const docPath = path.resolve(process.cwd(), 'docs/mcp.md');
      expect(fs.existsSync(docPath)).toBe(true);

      const content = fs.readFileSync(docPath, 'utf8');
      const jsonMatch = content.match(/```json\r?\n([\s\S]*?)\r?\n```/);
      expect(jsonMatch).not.toBeNull();

      const parsedJson = JSON.parse(jsonMatch![1]) as McpConfigFile;
      expect(parsedJson.mcpServers).toBeDefined();

      const result = resolveMcpConfig({
        projectConfig: parsedJson,
        isProjectTrusted: true,
      });

      expect(result.hasFatalError).toBe(false);
      expect(result.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
      expect(result.servers.has('git-tools')).toBe(true);
      expect(result.servers.has('remote-search')).toBe(true);
      expect(result.servers.has('legacy-service')).toBe(true);
      expect(result.servers.get('legacy-service')?.config.enabled).toBe(false);
    });
  });
});
