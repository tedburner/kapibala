/**
 * @fileoverview MCP 工具结果转换、净化、20 KiB 预算与 execution v1 错误分类集成测试 (Task Group 6)
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESULT_BUDGET_BYTES,
  MAX_WIRE_TRANSPORT_BYTES,
  convertMcpToolResponse,
  createMcpToolAdapter,
  sanitizeMcpContentBlock,
  sanitizeStructuredContent,
  truncateTextSafely,
} from '../src/index.js';

describe('MCP Results, Sanitization & Execution v1 (Task Group 6)', () => {
  // =========================================================================
  // 6.1 execution v1 错误分类与远端事实保留
  // =========================================================================
  describe('6.1 execution v1 Classification & Result Conversion', () => {
    it('classifies remote business failure as failed with MCP_TOOL_ERROR and preserves feedback', () => {
      const rawResponse = {
        isError: true,
        content: [{ type: 'text', text: 'Error: invalid argument --port 99999' }],
      };

      const result = convertMcpToolResponse(rawResponse);
      expect(result.isError).toBe(true);
      expect(result.errorCode).toBe('MCP_TOOL_ERROR');
      expect(result.content).toBe('Error: invalid argument --port 99999');
      expect(result.retryPolicy).toBe('never');
      expect(result.execution).toEqual({
        version: 1,
        dispatchOutcome: 'failed',
      });
    });

    it('classifies valid remote execution as succeeded', () => {
      const rawResponse = {
        content: [{ type: 'text', text: 'Operation completed successfully' }],
      };

      const result = convertMcpToolResponse(rawResponse);
      expect(result.isError).toBe(false);
      expect(result.content).toBe('Operation completed successfully');
      expect(result.execution).toEqual({
        version: 1,
        dispatchOutcome: 'succeeded',
      });
    });

    it('classifies pre-send precheck rejection as not_sent', () => {
      const err = new Error('MCP_TOOL_CHANGED: Server definition changed before dispatch');
      const result = convertMcpToolResponse(err);

      expect(result.isError).toBe(true);
      expect(result.errorCode).toBe('MCP_PRECHECK_REJECTED');
      expect(result.retryPolicy).toBe('never');
      expect(result.execution?.version).toBe(1);
      expect(result.execution?.dispatchOutcome).toBe('not_sent');
      expect(result.execution?.hostError?.phase).toBe('validation');
    });

    it('classifies undetermined outcome as unknown with OUTCOME_UNKNOWN and after_user_action', () => {
      const err = new Error('Socket closed without response (ECONNRESET)');
      const result = convertMcpToolResponse(err);

      expect(result.isError).toBe(true);
      expect(result.errorCode).toBe('OUTCOME_UNKNOWN');
      expect(result.retryPolicy).toBe('after_user_action');
      expect(result.execution?.version).toBe(1);
      expect(result.execution?.dispatchOutcome).toBe('unknown');
    });

    it('retains succeeded dispatchOutcome even if host projection encounters error', () => {
      // 构造在访问 content 时抛出异常的畸形响应
      const brokenResponse = {
        get content() {
          throw new Error('Host memory projection failure');
        },
      };

      const result = convertMcpToolResponse(brokenResponse);
      expect(result.isError).toBe(true);
      expect(result.errorCode).toBe('MCP_RESULT_INVALID');
      expect(result.retryPolicy).toBe('after_user_action');
      // 关键保证：远端成功事实必须保留，绝不改写为 unknown！
      expect(result.execution?.dispatchOutcome).toBe('succeeded');
      expect(result.execution?.hostError).toEqual({
        phase: 'projection',
        code: 'MCP_RESULT_INVALID',
      });
    });
  });

  // =========================================================================
  // 6.2 20 KiB 预算截断、4 MiB 硬界与多媒体脱敏
  // =========================================================================
  describe('6.2 Budget Truncation & Media Redaction', () => {
    it('truncates oversized text to 20 KiB while retaining head and tail with omitted marker', () => {
      const hugeText = `HEAD_START ${'M'.repeat(30000)} TAIL_END`;
      const truncated = truncateTextSafely(hugeText);

      expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(
        DEFAULT_RESULT_BUDGET_BYTES + 50,
      );
      expect(truncated).toContain('HEAD_START');
      expect(truncated).toContain('TAIL_END');
      expect(truncated).toMatch(/\.\.\. \[omitted \d+ bytes\] \.\.\./);
    });

    it('redacts image content blocks and forbids raw Base64 retention', () => {
      const fakeBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk';
      const block = {
        type: 'image',
        mimeType: 'image/png',
        data: fakeBase64,
      };

      const sanitized = sanitizeMcpContentBlock(block);
      expect(sanitized).toBe('[Embedded Image: image/png, ~45 bytes not retained]');
      expect(sanitized).not.toContain(fakeBase64);
    });

    it('redacts resource blocks and strips private _meta', () => {
      const block = {
        type: 'resource',
        resource: {
          uri: 'file:///project/data.bin',
          mimeType: 'application/octet-stream',
        },
        _meta: { secretToken: 'should_not_leak' },
      };

      const sanitized = sanitizeMcpContentBlock(block);
      expect(sanitized).toBe(
        '[Embedded Resource: file:///project/data.bin, application/octet-stream]',
      );
      expect(sanitized).not.toContain('should_not_leak');
    });

    it('strips private _meta from structuredContent', () => {
      const structured = {
        users: [{ id: 1, name: 'Alice' }],
        _meta: { hostAuthHeader: 'Bearer secret_key_abc' },
      };

      const sanitized = sanitizeStructuredContent(structured);
      expect(sanitized).toContain('Alice');
      expect(sanitized).not.toContain('secret_key_abc');
      expect(sanitized).not.toContain('_meta');
    });

    it('enforces 4 MiB transport wire hard limit', () => {
      // 模拟超过 4 MiB 的超大结构化响应
      const hugeObject: Record<string, string> = {};
      const chunk = 'x'.repeat(1024 * 1024); // 1 MiB
      hugeObject.k1 = chunk;
      hugeObject.k2 = chunk;
      hugeObject.k3 = chunk;
      hugeObject.k4 = chunk;
      hugeObject.k5 = chunk; // 5 MiB

      expect(() => sanitizeStructuredContent(hugeObject)).toThrow(
        /exceeds transport hard limit of 4194304 bytes \(4 MiB\)/,
      );
    });
  });

  // =========================================================================
  // 6.3 & 6.5 适配器超时管理、取消等待与结果转换接入
  // =========================================================================
  describe('6.3 & 6.5 Tool Adapter Integration with Execution Results', () => {
    it('declares managesTimeout: true and converts raw response via toExecutionResult', async () => {
      const mockSession = {
        serverName: 'srv',
        connectionState: 'ready',
        generation: 1,
        toolsCatalogEpoch: 1,
        client: {
          callTool: async () => ({
            content: [{ type: 'text', text: 'Adapted output text' }],
          }),
        },
      };

      const tool = createMcpToolAdapter({
        candidate: {
          normalizedName: 'mcp__srv__op',
          rawName: 'op',
          serverName: 'srv',
          description: 'Sample operation',
          inputSchema: {},
          toolDigest: 'd',
        },
        getSession: () => mockSession as any,
        targetGeneration: 1,
        targetCatalogEpoch: 1,
      });

      // 验证 metadata 契约
      expect(tool.metadata?.managesTimeout).toBe(true);
      expect(tool.metadata?.dangerous).toBe(true);
      expect(tool.metadata?.permissions).toContain('external:call');

      // 执行并经由 toExecutionResult 转换
      const rawOutput = await tool.execute({}, { rootDir: '.' });
      expect(tool.toExecutionResult).toBeDefined();

      const execResult = tool.toExecutionResult!(rawOutput);
      expect(execResult.content).toBe('Adapted output text');
      expect(execResult.isError).toBe(false);
      expect(execResult.execution?.dispatchOutcome).toBe('succeeded');
    });

    it('ensures message-level closure: every outcome maps to valid content string', () => {
      // 各种边界情况下的输出必须是非空字符串，以保证能正确闭合 tool_result
      expect(convertMcpToolResponse({}).content).toBe('Success');
      expect(convertMcpToolResponse({ isError: true }).content).toBe('Tool execution failed');
      expect(convertMcpToolResponse(new Error('Unknown crash')).content).toContain('Unknown crash');
    });
  });
});
