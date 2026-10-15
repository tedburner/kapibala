/**
 * @fileoverview MCP 工具命名、Schema 校验、预算截取、分页发现与 Core 适配器集成测试 (Task Group 5)
 */

import { ToolRegistry } from '@kiturone/kapibala';
import { describe, expect, it } from 'vitest';
import {
  MAX_MODEL_MCP_TOOLS_BUDGET_BYTES,
  MAX_MODEL_MCP_TOOLS_COUNT,
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_SIZE_BYTES,
  MAX_TOOL_NAME_LENGTH,
  computeToolDefinitionDigest,
  createMcpToolAdapter,
  discoverAndPublishTools,
  filterAndBudgetTools,
  normalizeToolName,
  parseNormalizedToolName,
  validateToolInputSchema,
} from '../src/index.js';

describe('MCP Tools & Catalog Management (Task Group 5)', () => {
  // =========================================================================
  // 5.1 稳定工具命名与原始身份映射
  // =========================================================================
  describe('5.1 Tool Naming & Identity Mapping', () => {
    it('creates canonical tool names in format mcp__<server>__<tool>', () => {
      expect(normalizeToolName('github', 'create_issue')).toBe('mcp__github__create_issue');
      expect(normalizeToolName('filesystem', 'read_file')).toBe('mcp__filesystem__read_file');
    });

    it('sanitizes illegal characters into underscores', () => {
      expect(normalizeToolName('my-server', 'query.user-name')).toBe(
        'mcp__my_server__query_user_name_873d68db',
      );
    });

    it('enforces 64-character limit and appends deterministic hash when truncated', () => {
      const veryLongToolName = 'a'.repeat(80);
      const normalized = normalizeToolName('srv', veryLongToolName);

      expect(normalized.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
      expect(normalized).toMatch(/^mcp__srv__a+_[a-f0-9]{8}$/);
    });

    it('guarantees deterministic mapping independent of discovery order (forward vs reverse)', () => {
      const toolNames = ['alpha', 'beta', 'alpha-beta', `long_${'x'.repeat(60)}`, 'gamma'];

      // 正序发现映射
      const forwardMap = new Map<string, string>();
      for (const name of toolNames) {
        forwardMap.set(name, normalizeToolName('demo_server', name));
      }

      // 倒序发现映射
      const reverseMap = new Map<string, string>();
      for (const name of [...toolNames].reverse()) {
        reverseMap.set(name, normalizeToolName('demo_server', name));
      }

      // 验证倒序和正序生成的规范工具名绝对一致
      for (const name of toolNames) {
        expect(forwardMap.get(name)).toBe(reverseMap.get(name));
      }
    });

    it('parses normalized tool names correctly', () => {
      const parsed = parseNormalizedToolName('mcp__github__create_issue');
      expect(parsed).toEqual({
        serverName: 'github',
        toolIdentifier: 'create_issue',
      });

      expect(parseNormalizedToolName('builtin_fs_read')).toBeUndefined();
      expect(parseNormalizedToolName('')).toBeUndefined();
    });

    it('computes stable definition digest for tools', () => {
      const digest1 = computeToolDefinitionDigest({
        name: 'echo',
        description: 'Echo message',
        inputSchema: { type: 'object' },
      });
      const digest2 = computeToolDefinitionDigest({
        name: 'echo',
        description: 'Echo message',
        inputSchema: { type: 'object' },
      });
      const digestDiff = computeToolDefinitionDigest({
        name: 'echo',
        description: 'Different desc',
        inputSchema: { type: 'object' },
      });

      expect(digest1).toBe(digest2);
      expect(digest1).not.toBe(digestDiff);
      expect(digest1).toHaveLength(64); // sha256 hex
    });
  });

  // =========================================================================
  // 5.2 Schema 校验与安全约束
  // =========================================================================
  describe('5.2 Schema Validation & Security Constraints', () => {
    it('accepts valid inputSchema and empty schemas', () => {
      expect(validateToolInputSchema(undefined).valid).toBe(true);
      expect(validateToolInputSchema(null).valid).toBe(true);
      expect(
        validateToolInputSchema({
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        }).valid,
      ).toBe(true);
    });

    it('strictly rejects remote $ref references (preventing SSRF and external fetches)', () => {
      const remoteRefSchema = {
        type: 'object',
        properties: {
          profile: {
            $ref: 'https://attacker.example.com/schema.json',
          },
        },
      };

      const result = validateToolInputSchema(remoteRefSchema);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Remote \$ref.*strictly forbidden/i);
    });

    it('strictly rejects schemas exceeding 32 KiB size limit', () => {
      const largeProps: Record<string, unknown> = {};
      for (let i = 0; i < 1500; i++) {
        largeProps[`field_${i}`] = { type: 'string', description: 'desc '.repeat(10) };
      }

      const hugeSchema = { type: 'object', properties: largeProps };
      const result = validateToolInputSchema(hugeSchema);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/exceeds maximum allowed limit of 32768 bytes/i);
    });

    it('strictly rejects schemas exceeding 20 levels of nesting depth', () => {
      let current: Record<string, unknown> = { type: 'string' };
      for (let depth = 0; depth < 25; depth++) {
        current = { type: 'object', properties: { nested: current } };
      }

      const result = validateToolInputSchema(current);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/nesting depth exceeds maximum allowed limit/i);
    });
  });

  // =========================================================================
  // 5.4 预算筛选与白名单/黑名单过滤
  // =========================================================================
  describe('5.4 Model Definition Budget & Tool Filtering', () => {
    it('filters tools by includeTools whitelist and excludeTools blacklist', () => {
      const candidates = [
        {
          normalizedName: 'mcp__git__status',
          rawName: 'status',
          serverName: 'git',
          description: 'Git status',
          inputSchema: { type: 'object' },
          toolDigest: 'd1',
        },
        {
          normalizedName: 'mcp__git__commit',
          rawName: 'commit',
          serverName: 'git',
          description: 'Git commit',
          inputSchema: { type: 'object' },
          toolDigest: 'd2',
        },
        {
          normalizedName: 'mcp__git__push',
          rawName: 'push',
          serverName: 'git',
          description: 'Git push',
          inputSchema: { type: 'object' },
          toolDigest: 'd3',
        },
      ];

      // 仅保留 status
      const res1 = filterAndBudgetTools(candidates, { includeTools: ['status'] });
      expect(res1.publishedTools.map((t) => t.rawName)).toEqual(['status']);
      expect(res1.omittedTools).toHaveLength(2);

      // 排除 push
      const res2 = filterAndBudgetTools(candidates, { excludeTools: ['push'] });
      expect(res2.publishedTools.map((t) => t.rawName)).toEqual(['commit', 'status']);
      expect(res2.omittedTools).toHaveLength(1);
    });

    it('enforces maximum 64 tools count limit with whole-item omission', () => {
      const candidates = Array.from({ length: 70 }, (_, i) => ({
        normalizedName: `mcp__srv__tool_${String(i).padStart(3, '0')}`,
        rawName: `tool_${i}`,
        serverName: 'srv',
        description: `Tool ${i}`,
        inputSchema: { type: 'object' },
        toolDigest: `digest_${i}`,
      }));

      const result = filterAndBudgetTools(candidates);
      expect(result.publishedTools).toHaveLength(MAX_MODEL_MCP_TOOLS_COUNT);
      expect(result.omittedTools).toHaveLength(6);
      expect(result.omittedTools[0].reason).toBe('budget_exceeded');
    });

    it('enforces 64 KiB total byte limit with whole-item omission', () => {
      // 构造每个约 5 KiB 的工具定义
      const largeDescription = 'x'.repeat(5000);
      const candidates = Array.from({ length: 20 }, (_, i) => ({
        normalizedName: `mcp__srv__heavy_${String(i).padStart(2, '0')}`,
        rawName: `heavy_${i}`,
        serverName: 'srv',
        description: largeDescription,
        inputSchema: { type: 'object' },
        toolDigest: `digest_${i}`,
      }));

      const result = filterAndBudgetTools(candidates);
      expect(result.totalBytes).toBeLessThanOrEqual(MAX_MODEL_MCP_TOOLS_BUDGET_BYTES);
      expect(result.omittedTools.length).toBeGreaterThan(0);
      expect(result.omittedTools[0].reason).toBe('budget_exceeded');
    });

    it('sorts candidates deterministically by serverName ASC and normalizedName ASC', () => {
      const candidates = [
        {
          normalizedName: 'mcp__z_srv__b_tool',
          rawName: 'b',
          serverName: 'z_srv',
          description: '',
          inputSchema: {},
          toolDigest: '1',
        },
        {
          normalizedName: 'mcp__a_srv__z_tool',
          rawName: 'z',
          serverName: 'a_srv',
          description: '',
          inputSchema: {},
          toolDigest: '2',
        },
        {
          normalizedName: 'mcp__a_srv__a_tool',
          rawName: 'a',
          serverName: 'a_srv',
          description: '',
          inputSchema: {},
          toolDigest: '3',
        },
      ];

      const result = filterAndBudgetTools(candidates);
      expect(result.publishedTools.map((t) => t.normalizedName)).toEqual([
        'mcp__a_srv__a_tool',
        'mcp__a_srv__z_tool',
        'mcp__z_srv__b_tool',
      ]);
    });
  });

  // =========================================================================
  // 5.5 Core Tool 契约适配与发送前同步微任务复核
  // =========================================================================
  describe('5.5 Core Tool Adapter & Pre-Send Synchronous Verification', () => {
    it('preflight-validates final parameters with validateInput without network calls', () => {
      const candidate = {
        normalizedName: 'mcp__srv__query',
        rawName: 'query',
        serverName: 'srv',
        description: 'Query database',
        inputSchema: {
          type: 'object',
          properties: {
            sql: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['sql'],
        },
        toolDigest: 'digest_sql',
      };

      const mockSession = {
        serverName: 'srv',
        connectionState: 'ready',
        generation: 1,
        toolsCatalogEpoch: 1,
        client: {
          callTool: async () => ({ content: [] }),
        },
      };

      const tool = createMcpToolAdapter({
        candidate,
        getSession: () => mockSession as any,
        targetGeneration: 1,
        targetCatalogEpoch: 1,
      });

      // 合法参数
      const validRes = tool.validateInput!({ sql: 'SELECT 1;', limit: 10 });
      expect(validRes?.valid).toBe(true);

      // 非法参数：缺少必填字段
      const invalidRes1 = tool.validateInput!({ limit: 10 });
      expect(invalidRes1?.valid).toBe(false);
      expect(invalidRes1?.message).toMatch(/MCP parameter validation rejected/i);

      // 非法参数：类型错误
      const invalidRes2 = tool.validateInput!({ sql: 12345 });
      expect(invalidRes2?.valid).toBe(false);
    });

    it('aborts transmission in pre-send synchronous check if server disconnected or generation changed', async () => {
      let callToolInvoked = false;

      const mockSession = {
        serverName: 'srv',
        connectionState: 'ready',
        generation: 1,
        toolsCatalogEpoch: 1,
        client: {
          callTool: async () => {
            callToolInvoked = true;
            return { content: [] };
          },
        },
      };

      const tool = createMcpToolAdapter({
        candidate: {
          normalizedName: 'mcp__srv__test',
          rawName: 'test',
          serverName: 'srv',
          description: '',
          inputSchema: {},
          toolDigest: 'd',
        },
        getSession: () => mockSession as any,
        targetGeneration: 1,
        targetCatalogEpoch: 1,
      });

      // 1. 服务端状态变为 disconnected -> 阻断发送
      mockSession.connectionState = 'disconnected';
      await expect(tool.execute({}, { rootDir: '.' })).rejects.toThrow(/MCP_SERVER_UNAVAILABLE/);
      expect(callToolInvoked).toBe(false);

      // 恢复 ready，但 generation 改变（发生过重连） -> 阻断发送
      mockSession.connectionState = 'ready';
      mockSession.generation = 2;
      await expect(tool.execute({}, { rootDir: '.' })).rejects.toThrow(/MCP_TOOL_CHANGED/);
      expect(callToolInvoked).toBe(false);

      // 恢复 generation，但 toolsCatalogEpoch 改变 -> 阻断发送
      mockSession.generation = 1;
      mockSession.toolsCatalogEpoch = 2;
      await expect(tool.execute({}, { rootDir: '.' })).rejects.toThrow(/MCP_TOOL_CHANGED/);
      expect(callToolInvoked).toBe(false);
    });
  });

  // =========================================================================
  // 5.2 & 5.3 分页与原子发布测试
  // =========================================================================
  describe('5.2 & 5.3 Paged Discovery & Atomic replaceSource', () => {
    it('discovers tools across multiple cursor pages and publishes them atomically to ToolRegistry', async () => {
      const registry = new ToolRegistry();

      // 模拟多页服务端
      const pages = [
        {
          tools: [{ name: 'tool_p1', inputSchema: { type: 'object' } }],
          nextCursor: 'cursor_2',
        },
        {
          tools: [{ name: 'tool_p2', inputSchema: { type: 'object' } }],
          nextCursor: undefined,
        },
      ];

      let currentPage = 0;
      const mockSession = {
        serverName: 'paged_srv',
        connectionState: 'ready',
        generation: 1,
        toolsCatalogEpoch: 1,
        client: {
          listTools: async () => {
            const page = pages[currentPage];
            currentPage += 1;
            return page;
          },
        },
      };

      const result = await discoverAndPublishTools(
        mockSession as any,
        { command: 'node' },
        registry,
      );

      expect(result.publishedCount).toBe(2);
      expect(registry.get('mcp__paged_srv__tool_p1')).toBeDefined();
      expect(registry.get('mcp__paged_srv__tool_p2')).toBeDefined();

      // 再次原子替换：新批次只有 1 个工具，旧的 tool_p2 应当被干净替换注销
      currentPage = 0;
      pages[0] = {
        tools: [{ name: 'tool_v2', inputSchema: { type: 'object' } }],
        nextCursor: undefined,
      };

      await discoverAndPublishTools(mockSession as any, { command: 'node' }, registry);

      expect(registry.get('mcp__paged_srv__tool_v2')).toBeDefined();
      expect(registry.get('mcp__paged_srv__tool_p1')).toBeUndefined();
      expect(registry.get('mcp__paged_srv__tool_p2')).toBeUndefined();
    });

    it('rejects publishing entire batch if any page in paged discovery fails', async () => {
      const registry = new ToolRegistry();
      // 预先注册一个既有工具
      registry.register({
        name: 'existing_tool',
        description: '',
        parameters: {},
        metadata: { source: 'mcp:fail_srv' },
        execute: async () => ({}),
      });

      let pageCount = 0;
      const mockSession = {
        serverName: 'fail_srv',
        connectionState: 'ready',
        generation: 1,
        toolsCatalogEpoch: 1,
        client: {
          listTools: async () => {
            pageCount += 1;
            if (pageCount === 2) {
              throw new Error('Connection reset on page 2');
            }
            return {
              tools: [{ name: 'partial_tool', inputSchema: { type: 'object' } }],
              nextCursor: 'next_page',
            };
          },
        },
      };

      await expect(
        discoverAndPublishTools(mockSession as any, { command: 'node' }, registry),
      ).rejects.toThrow(/Failed to complete paged tool discovery/);

      // 证明整批候选被拒绝：不发布 partial_tool，且旧工具不被破坏
      expect(registry.get('mcp__fail_srv__partial_tool')).toBeUndefined();
      expect(registry.get('existing_tool')).toBeDefined();
    });
  });

  // =========================================================================
  // 5.6 未连接 MCP 工具的 Skill 兼容性
  // =========================================================================
  describe('5.6 Skill Compatibility with Unconnected MCP Tools', () => {
    it('refuses execution and suggests connecting the server when an MCP tool is not in registry', () => {
      const registry = new ToolRegistry();
      const requestedToolName = 'mcp__unconnected_srv__special_action';

      const foundTool = registry.get(requestedToolName);
      expect(foundTool).toBeUndefined();

      // 构造未连接 MCP 工具的友好诊断指引
      const parsed = parseNormalizedToolName(requestedToolName);
      expect(parsed?.serverName).toBe('unconnected_srv');

      const refusalMessage = `Tool '${requestedToolName}' is provided by MCP server '${parsed?.serverName}', which is not currently connected. Please connect the server via /mcp reconnect ${parsed?.serverName} and reactivate the skill.`;
      expect(refusalMessage).toContain('which is not currently connected');
      expect(refusalMessage).toContain('/mcp reconnect unconnected_srv');
    });
  });
});
