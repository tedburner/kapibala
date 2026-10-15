import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionApprovalCache } from '../src/capabilities/security/approval.js';
import type { ApprovalRequest } from '../src/capabilities/security/approval.js';
import { defineTool } from '../src/capabilities/tools/index.js';
import type { ToolExecutionIdentity } from '../src/capabilities/tools/index.js';
import { ToolRegistry } from '../src/capabilities/tools/registry.js';
import { AgentSession } from '../src/context/session/index.js';
import { JSONLMessageStore } from '../src/context/store/jsonl.js';
import { HookRegistry } from '../src/extensibility/hooks/registry.js';
import {
  type LogEvent,
  type LogSink,
  StructuredLogger,
} from '../src/extensibility/logging/index.js';
import type { ModelProfile } from '../src/models/index.js';
import { validateProtocolContent } from '../src/models/protocol-state.js';
import { ToolExecutor } from '../src/runtime/executor/index.js';
import { AgentLoop } from '../src/runtime/loop/index.js';
import type { ToolResultBlock } from '../src/types/index.js';
import { ScriptedProvider } from './helpers/mock.js';

class MemorySink implements LogSink {
  readonly events: LogEvent[] = [];
  failAt?: string;

  async write(event: LogEvent): Promise<void> {
    if (event.event === this.failAt) {
      throw new Error(`Audit sink failure at ${this.failAt}`);
    }
    this.events.push(event);
  }
}

const TEST_PROFILE: ModelProfile = {
  id: 'test-model',
  provider: 'openai-compatible',
  name: 'Test Model',
  baseURL: 'https://api.openai.com/v1',
  apiKeyEnv: 'NONE',
  modelName: 'gpt-4o',
};

describe('Core Execution Contracts (v0.0.6 Task 2.1 - 2.8)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-contracts-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Task 2.4: external:call 权限矩阵
  // =========================================================================
  describe('Task 2.4: external:call permission matrix', () => {
    it('blocks execution in Plan mode with not_sent outcome', async () => {
      const executeFn = vi.fn(async () => 'ok');
      const tools = new ToolRegistry();
      tools.register(
        defineTool({
          name: 'mcp__test_call',
          description: 'MCP external tool',
          parameters: { type: 'object' },
          metadata: { permissions: ['external:call'] },
          execute: executeFn,
        }),
      );

      const executor = new ToolExecutor({
        tools,
        hooks: new HookRegistry(),
        rootDir: process.cwd(),
        mode: 'Plan',
      });

      const result = await executor.executeOne({
        type: 'tool_use',
        id: 'call_1',
        name: 'mcp__test_call',
        input: {},
      });

      expect(executeFn).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.execution).toEqual({
        version: 1,
        dispatchOutcome: 'not_sent',
      });
      expect(result.content).toMatch(/Tool permission denied/i);
    });

    it('requires approval in Auto and Approval mode, allowing execution when approved', async () => {
      const executeFn = vi.fn(async () => 'executed_auto');
      const tools = new ToolRegistry();
      tools.register(
        defineTool({
          name: 'mcp__test_call',
          description: 'MCP external tool',
          parameters: { type: 'object' },
          metadata: { permissions: ['external:call'] },
          execute: executeFn,
        }),
      );

      const askFn = vi.fn(async (_req: ApprovalRequest) => 'allow_once' as const);
      const executor = new ToolExecutor({
        tools,
        hooks: new HookRegistry(),
        rootDir: process.cwd(),
        mode: 'Auto',
        approvalChannel: { requestApproval: askFn },
      });

      const result = await executor.executeOne({
        type: 'tool_use',
        id: 'call_auto',
        name: 'mcp__test_call',
        input: {},
      });

      expect(askFn).toHaveBeenCalledTimes(1);
      expect(executeFn).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(false);
      expect(result.content).toBe('executed_auto');
      expect(result.execution).toEqual({
        version: 1,
        dispatchOutcome: 'succeeded',
      });
    });

    it('allows execution directly without approval in FullAccess mode', async () => {
      const executeFn = vi.fn(async () => 'executed_full');
      const tools = new ToolRegistry();
      tools.register(
        defineTool({
          name: 'mcp__test_call',
          description: 'MCP external tool',
          parameters: { type: 'object' },
          metadata: { permissions: ['external:call'] },
          execute: executeFn,
        }),
      );

      const askFn = vi.fn(async () => 'allow_once' as const);
      const executor = new ToolExecutor({
        tools,
        hooks: new HookRegistry(),
        rootDir: process.cwd(),
        mode: 'FullAccess',
        approvalChannel: { requestApproval: askFn },
      });

      const result = await executor.executeOne({
        type: 'tool_use',
        id: 'call_full',
        name: 'mcp__test_call',
        input: {},
      });

      expect(askFn).not.toHaveBeenCalled();
      expect(executeFn).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(false);
      expect(result.execution?.dispatchOutcome).toBe('succeeded');
    });

    it('denies execution when explicit deny rule matches', async () => {
      const executeFn = vi.fn(async () => 'ok');
      const tools = new ToolRegistry();
      tools.register(
        defineTool({
          name: 'mcp__forbidden',
          description: 'Forbidden MCP tool',
          parameters: { type: 'object' },
          metadata: { permissions: ['external:call'] },
          execute: executeFn,
        }),
      );

      const executor = new ToolExecutor({
        tools,
        hooks: new HookRegistry(),
        rootDir: process.cwd(),
        mode: 'FullAccess',
        permissionRules: [{ action: 'deny', tool: 'mcp__forbidden' }],
      });

      const result = await executor.executeOne({
        type: 'tool_use',
        id: 'call_denied',
        name: 'mcp__forbidden',
        input: {},
      });

      expect(executeFn).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.execution?.dispatchOutcome).toBe('not_sent');
      expect(result.content).toMatch(/Tool permission denied/i);
    });

    it('denies execution under Skill hard restriction even in FullAccess mode', async () => {
      const executeFn = vi.fn(async () => 'ok');
      const tools = new ToolRegistry();
      tools.register(
        defineTool({
          name: 'mcp__unlisted',
          description: 'MCP tool not allowed by active skill',
          parameters: { type: 'object' },
          metadata: { permissions: ['external:call'] },
          execute: executeFn,
        }),
      );

      const executor = new ToolExecutor({
        tools,
        hooks: new HookRegistry(),
        rootDir: process.cwd(),
        mode: 'FullAccess',
        hardDenial: (tool) => {
          if (tool.name !== 'read_file') {
            return {
              code: 'SKILL_TOOL_NOT_ALLOWED',
              message: `Tool '${tool.name}' is not permitted by active skill`,
              retryPolicy: 'never',
            };
          }
        },
      });

      const result = await executor.executeOne({
        type: 'tool_use',
        id: 'call_skill_denied',
        name: 'mcp__unlisted',
        input: {},
      });

      expect(executeFn).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.execution?.dispatchOutcome).toBe('not_sent');
      expect(result.content).toMatch(/Tool 'mcp__unlisted' is not permitted by active skill/i);
    });

    it('rejects execution when non-interactive without approval channel in Auto mode', async () => {
      const executeFn = vi.fn(async () => 'ok');
      const tools = new ToolRegistry();
      tools.register(
        defineTool({
          name: 'mcp__test_call',
          description: 'MCP tool',
          parameters: { type: 'object' },
          metadata: { permissions: ['external:call'] },
          execute: executeFn,
        }),
      );

      const executor = new ToolExecutor({
        tools,
        hooks: new HookRegistry(),
        rootDir: process.cwd(),
        mode: 'Auto',
      });

      const result = await executor.executeOne({
        type: 'tool_use',
        id: 'call_no_channel',
        name: 'mcp__test_call',
        input: {},
      });

      expect(executeFn).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.execution?.dispatchOutcome).toBe('not_sent');
      expect(result.content).toMatch(/Tool permission denied/i);
    });
  });

  // =========================================================================
  // Task 2.5: opt-in 结果转换与普通对象 isError 防误判
  // =========================================================================
  describe('Task 2.5: opt-in toExecutionResult and error discrimination', () => {
    it('does NOT treat plain object with isError: true as error when tool does not opt in', async () => {
      const tools = new ToolRegistry();
      tools.register(
        defineTool({
          name: 'plain_tool',
          description: 'Returns plain object with isError',
          parameters: { type: 'object' },
          metadata: { permissions: ['external:call'] },
          async execute() {
            return { isError: true, status: 'mocked' };
          },
        }),
      );

      const executor = new ToolExecutor({
        tools,
        hooks: new HookRegistry(),
        rootDir: process.cwd(),
        mode: 'FullAccess',
      });

      const result = await executor.executeOne({
        type: 'tool_use',
        id: 'call_plain',
        name: 'plain_tool',
        input: {},
      });

      // 关键断言：未 opt-in toExecutionResult 的普通工具，返回普通对象即使带有 isError 字段，也不被解释为错误
      expect(result.isError).toBe(false);
      expect(result.execution?.dispatchOutcome).toBe('succeeded');
      expect(result.content).toBe(JSON.stringify({ isError: true, status: 'mocked' }, null, 2));
    });

    it('correctly projects business failure via opt-in toExecutionResult with failed outcome', async () => {
      const tools = new ToolRegistry();
      tools.register(
        defineTool({
          name: 'mcp_tool_fail',
          description: 'MCP tool reporting domain failure',
          parameters: { type: 'object' },
          metadata: { permissions: ['external:call'] },
          async execute() {
            return { rawError: 'Remote endpoint timed out', code: 504 };
          },
          toExecutionResult(raw: unknown) {
            const data = raw as { rawError: string; code: number };
            return {
              content: `Domain failure: ${data.rawError} (${data.code})`,
              isError: true,
            };
          },
        }),
      );

      const executor = new ToolExecutor({
        tools,
        hooks: new HookRegistry(),
        rootDir: process.cwd(),
        mode: 'FullAccess',
      });

      const result = await executor.executeOne({
        type: 'tool_use',
        id: 'call_domain_fail',
        name: 'mcp_tool_fail',
        input: {},
      });

      expect(result.isError).toBe(true);
      expect(result.content).toBe('Domain failure: Remote endpoint timed out (504)');
      expect(result.execution).toEqual({
        version: 1,
        dispatchOutcome: 'failed',
      });
    });

    it('preserves dispatchOutcome: succeeded and records projection hostError when toExecutionResult throws', async () => {
      const tools = new ToolRegistry();
      tools.register(
        defineTool({
          name: 'mcp_tool_bad_projection',
          description: 'MCP tool whose projection throws',
          parameters: { type: 'object' },
          metadata: { permissions: ['external:call'] },
          async execute() {
            return { something: 'valid from network' };
          },
          toExecutionResult() {
            throw new Error('Malformed projection schema');
          },
        }),
      );

      const executor = new ToolExecutor({
        tools,
        hooks: new HookRegistry(),
        rootDir: process.cwd(),
        mode: 'FullAccess',
      });

      const result = await executor.executeOne({
        type: 'tool_use',
        id: 'call_bad_proj',
        name: 'mcp_tool_bad_projection',
        input: {},
      });

      // 关键断言：底层已经成功执行（succeeded），不能因为宿主侧转换失败改写为 unknown 或 not_sent
      expect(result.isError).toBe(true);
      expect(result.execution?.dispatchOutcome).toBe('succeeded');
      expect(result.execution?.hostError).toEqual({
        phase: 'projection',
        code: 'MCP_RESULT_INVALID',
      });
      expect(result.content).toMatch(/Malformed projection schema/i);
    });
  });

  // =========================================================================
  // Task 2.7: Tool.validateInput 无副作用预检
  // =========================================================================
  describe('Task 2.7: Tool.validateInput side-effect free pre-check', () => {
    it('rejects invalid input before approval and execution with 0 approvals and 0 executions', async () => {
      const askFn = vi.fn(async () => 'allow_once' as const);
      const executeFn = vi.fn(async () => 'executed');
      const validateInputFn = vi.fn((input: unknown) => {
        const parsed = input as { count?: number };
        if (typeof parsed.count !== 'number' || parsed.count < 0) {
          return { valid: false, message: 'count must be a non-negative number' };
        }
        return { valid: true };
      });

      const tools = new ToolRegistry();
      tools.register(
        defineTool({
          name: 'validated_tool',
          description: 'Tool with input validation',
          parameters: { type: 'object' },
          metadata: { permissions: ['external:call'] },
          validateInput: validateInputFn,
          execute: executeFn,
        }),
      );

      const executor = new ToolExecutor({
        tools,
        hooks: new HookRegistry(),
        rootDir: process.cwd(),
        mode: 'Auto',
        approvalChannel: { requestApproval: askFn },
      });

      const result = await executor.executeOne({
        type: 'tool_use',
        id: 'call_invalid_input',
        name: 'validated_tool',
        input: { count: -5 },
      });

      expect(validateInputFn).toHaveBeenCalledTimes(1);
      expect(askFn).not.toHaveBeenCalled();
      expect(executeFn).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.execution).toEqual({
        version: 1,
        dispatchOutcome: 'not_sent',
        hostError: {
          phase: 'validation',
          code: 'INVALID_INPUT',
        },
      });
      expect(result.content).toMatch(/count must be a non-negative number/i);
    });

    it('handles thrown error inside validateInput as validation failure with not_sent outcome', async () => {
      const askFn = vi.fn(async () => 'allow_once' as const);
      const executeFn = vi.fn(async () => 'executed');
      const tools = new ToolRegistry();
      tools.register(
        defineTool({
          name: 'throwing_validator',
          description: 'Tool validator throws',
          parameters: { type: 'object' },
          metadata: { permissions: ['external:call'] },
          validateInput() {
            throw new Error('Zod crash in validator');
          },
          execute: executeFn,
        }),
      );

      const executor = new ToolExecutor({
        tools,
        hooks: new HookRegistry(),
        rootDir: process.cwd(),
        mode: 'FullAccess',
        approvalChannel: { requestApproval: askFn },
      });

      const result = await executor.executeOne({
        type: 'tool_use',
        id: 'call_thrown_val',
        name: 'throwing_validator',
        input: {},
      });

      expect(askFn).not.toHaveBeenCalled();
      expect(executeFn).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.execution).toEqual({
        version: 1,
        dispatchOutcome: 'not_sent',
        hostError: {
          phase: 'validation',
          code: 'INVALID_INPUT',
        },
      });
      expect(result.content).toMatch(/Zod crash in validator/i);
    });

    it('shares the modified final input snapshot between validateInput, approval, identity, and execute', async () => {
      const hooks = new HookRegistry();
      hooks.on('tool:before', async () => ({
        action: 'modify',
        input: { sanitized: true, port: 8080 },
      }));

      let receivedInValidation: unknown;
      let receivedInExecute: unknown;

      const tools = new ToolRegistry();
      tools.register(
        defineTool({
          name: 'sanitized_tool',
          description: 'Checks final input',
          parameters: { type: 'object' },
          metadata: { permissions: ['external:call'] },
          validateInput(input) {
            receivedInValidation = input;
            return { valid: true };
          },
          async execute(input) {
            receivedInExecute = input;
            return 'done';
          },
        }),
      );

      let receivedInApproval: unknown;
      const askFn = vi.fn(async (req: ApprovalRequest) => {
        receivedInApproval = req.input;
        return 'allow_once' as const;
      });

      const executor = new ToolExecutor({
        tools,
        hooks,
        rootDir: process.cwd(),
        mode: 'Auto',
        approvalChannel: { requestApproval: askFn },
      });

      const result = await executor.executeOne({
        type: 'tool_use',
        id: 'call_hook_modify',
        name: 'sanitized_tool',
        input: { sanitized: false, port: 'bad' },
      });

      expect(result.isError).toBe(false);
      expect(receivedInValidation).toEqual({ sanitized: true, port: 8080 });
      expect(receivedInApproval).toEqual({ sanitized: true, port: 8080 });
      expect(receivedInExecute).toEqual({ sanitized: true, port: 8080 });
    });
  });

  // =========================================================================
  // Task 2.8: execution v1 事实与宿主错误分离
  // =========================================================================
  describe('Task 2.8: execution v1 dispatchOutcome separation from hostError', () => {
    it('preserves known dispatchOutcome (failed) when tool:after hook throws', async () => {
      const hooks = new HookRegistry();
      hooks.on('tool:after', async () => {
        throw new Error('Plugin hook crashed after execution');
      });

      const tools = new ToolRegistry();
      tools.register(
        defineTool({
          name: 'failing_tool',
          description: 'Fails in domain',
          parameters: { type: 'object' },
          metadata: { permissions: ['external:call'] },
          async execute() {
            return { failure: 'network dropped' };
          },
          toExecutionResult(raw) {
            return { isError: true, content: JSON.stringify(raw) };
          },
        }),
      );

      const executor = new ToolExecutor({
        tools,
        hooks,
        rootDir: process.cwd(),
        mode: 'FullAccess',
      });

      const result = await executor.executeOne({
        type: 'tool_use',
        id: 'call_after_hook_fail',
        name: 'failing_tool',
        input: {},
      });

      // 关键断言：dispatchOutcome 必须保持已知的 'failed'，绝不能改写为 unknown！
      // 宿主错误作为 hostError 附加
      expect(result.isError).toBe(true);
      expect(result.execution?.dispatchOutcome).toBe('failed');
      expect(result.execution?.hostError).toEqual({
        phase: 'hook',
        code: 'HOOK_ERROR',
      });
      expect(result.content).toMatch(/Tool finished but result processing failed/i);
    });

    it('preserves dispatchOutcome: succeeded when audit.finished fails', async () => {
      const audit = new MemorySink();
      audit.failAt = 'tool.finished';

      const tools = new ToolRegistry();
      tools.register(
        defineTool({
          name: 'audited_tool',
          description: 'Audited tool',
          parameters: { type: 'object' },
          metadata: { permissions: ['external:call'] },
          async execute() {
            return 'actual real side effect completed';
          },
        }),
      );

      const executor = new ToolExecutor({
        tools,
        hooks: new HookRegistry(),
        rootDir: process.cwd(),
        mode: 'FullAccess',
        sessionId: 'test-session',
        runId: 'test-run',
        eventLogger: new StructuredLogger({ operationSink: new MemorySink(), auditSink: audit }),
      });

      const result = await executor.executeOne({
        type: 'tool_use',
        id: 'call_audit_fail',
        name: 'audited_tool',
        input: {},
      });

      // 关键断言：审计日志失败，底层已成功执行的事实（succeeded）绝不抹掉
      expect(result.isError).toBe(true);
      expect(result.execution?.dispatchOutcome).toBe('succeeded');
      expect(result.execution?.hostError).toEqual({
        phase: 'audit',
        code: 'AUDIT_UNAVAILABLE',
      });
    });

    it('backward compatibility: legacy tool result without execution block validates cleanly', () => {
      const legacyBlock: ToolResultBlock = {
        type: 'tool_result',
        toolUseId: 'legacy_call_1',
        content: 'legacy result output',
      };

      // 验证历史状态校验器兼容旧历史
      expect(() => validateProtocolContent([legacyBlock])).not.toThrow();
    });
  });

  // =========================================================================
  // Task 2.3: executionIdentity 深度哈希缓存键与审批后身份漂移
  // =========================================================================
  describe('Task 2.3: executionIdentity hashing and drift detection', () => {
    it('invalidates cached approval when executionIdentity changes (e.g. server reconnects with new epoch)', async () => {
      const cache = new SessionApprovalCache();
      const askFn = vi.fn(async () => 'allow_session' as const);

      let currentEpoch = 1;
      const getIdentity = (): ToolExecutionIdentity => ({
        serverIdentity: 'server-1',
        connectionGeneration: 1,
        catalogEpoch: currentEpoch,
        toolDigest: 'digest-abc',
      });

      const tools = new ToolRegistry();
      tools.register(
        defineTool({
          name: 'mcp__stateful_tool',
          description: 'Tool with dynamic epoch identity',
          parameters: { type: 'object' },
          metadata: { permissions: ['external:call'] },
          executionIdentity() {
            return getIdentity();
          },
          async execute() {
            return 'executed_ok';
          },
        }),
      );

      const executor = new ToolExecutor({
        tools,
        hooks: new HookRegistry(),
        rootDir: process.cwd(),
        mode: 'Auto',
        approvalChannel: { requestApproval: askFn },
        approvalCache: cache,
      });

      // 第一次调用：epoch 1 -> 触发审批并缓存 allow_session
      await executor.executeOne({
        type: 'tool_use',
        id: 'call_epoch_1',
        name: 'mcp__stateful_tool',
        input: { query: 'test' },
      });
      expect(askFn).toHaveBeenCalledTimes(1);

      // 第二次调用：epoch 仍是 1 -> 命中缓存，不再次审批
      await executor.executeOne({
        type: 'tool_use',
        id: 'call_epoch_1_again',
        name: 'mcp__stateful_tool',
        input: { query: 'test' },
      });
      expect(askFn).toHaveBeenCalledTimes(1);

      // 第三次调用：Server 重连，epoch 变为 2 -> 缓存键深度哈希失配，必须重新触发审批！
      currentEpoch = 2;
      await executor.executeOne({
        type: 'tool_use',
        id: 'call_epoch_2',
        name: 'mcp__stateful_tool',
        input: { query: 'test' },
      });
      expect(askFn).toHaveBeenCalledTimes(2);
    });

    it('blocks execution with MCP_TOOL_CHANGED and 0 dispatches if identity drifts after approval', async () => {
      const executeFn = vi.fn(async () => 'should_not_run');
      let currentEpoch = 1;

      const tools = new ToolRegistry();
      tools.register(
        defineTool({
          name: 'mcp__drifting_tool',
          description: 'Tool that drifts identity during approval',
          parameters: { type: 'object' },
          metadata: { permissions: ['external:call'] },
          executionIdentity() {
            return {
              serverIdentity: 'server-1',
              connectionGeneration: 1,
              catalogEpoch: currentEpoch,
              toolDigest: 'digest-1',
            };
          },
          execute: executeFn,
        }),
      );

      // 模拟审批等待期间发生重连导致 epoch 变化
      const askFn = vi.fn(async () => {
        currentEpoch = 2; // 漂移！
        return 'allow_once' as const;
      });

      const executor = new ToolExecutor({
        tools,
        hooks: new HookRegistry(),
        rootDir: process.cwd(),
        mode: 'Auto',
        approvalChannel: { requestApproval: askFn },
      });

      const result = await executor.executeOne({
        type: 'tool_use',
        id: 'call_drift',
        name: 'mcp__drifting_tool',
        input: {},
      });

      // 关键断言：身份漂移被阻断，底层 execute 严格 0 次发送，dispatchOutcome 为 not_sent
      expect(executeFn).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.execution).toEqual({
        version: 1,
        dispatchOutcome: 'not_sent',
        hostError: {
          phase: 'validation',
          code: 'MCP_TOOL_CHANGED',
        },
      });
      expect(result.content).toMatch(/execution identity changed after approval/i);
    });
  });

  // =========================================================================
  // Task 2.2: AgentLoop 不可变快照与防漂移
  // =========================================================================
  describe('Task 2.2: AgentLoop immutable snapshot & drift rejection', () => {
    it('rejects tool fabricated by model:before hook that is not declared in initial snapshot', async () => {
      const tools = new ToolRegistry();
      tools.register(
        defineTool({
          name: 'valid_tool',
          description: 'Declared tool',
          parameters: { type: 'object' },
          metadata: { permissions: ['external:call'] },
          async execute() {
            return 'valid_result';
          },
        }),
      );

      const provider = new ScriptedProvider([
        [
          { type: 'tool_call_finish', id: 'call_legit', name: 'valid_tool', input: {} },
          { type: 'message_stop' },
        ],
      ]);

      const hooks = new HookRegistry();
      // 外部 hook 尝试在 model:before 中篡改请求，注入一个快照中未声明的工具定义
      hooks.on('model:before', async (_ctx, req) => {
        return {
          ...req,
          tools: [
            ...(req.tools ?? []),
            { name: 'injected_rogue_tool', description: 'rogue', parameters: { type: 'object' } },
          ],
        };
      });

      const executor = new ToolExecutor({
        tools,
        hooks,
        rootDir: process.cwd(),
      });

      const loop = new AgentLoop({
        provider,
        executor,
        tools,
        hooks,
        systemPrompt: 'sys',
        maxSteps: 3,
      });

      const runLoop = async () => {
        for await (const _ of loop.run([
          { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: Date.now() },
        ])) {
          // consume
        }
      };

      // 关键断言：AgentLoop 检测到 hook 注入了快照中未声明的工具，立即抛出异常拒绝
      await expect(runLoop()).rejects.toThrow(
        /Hook injected tool 'injected_rogue_tool' not present in snapshot/i,
      );
    });
  });

  // =========================================================================
  // Task 2.6: AgentSession.runPreparedTask 受控任务准备
  // =========================================================================
  describe('Task 2.6: AgentSession.runPreparedTask controlled task preparation', () => {
    it('sets session isBusy during prepare, and performs 0 append if prepare fails or aborts', async () => {
      const storePath = path.join(tempDir, 'history-fail.jsonl');
      const store = new JSONLMessageStore(storePath);
      const session = new AgentSession({
        defaultProfile: TEST_PROFILE,
        defaultProvider: new ScriptedProvider([[{ type: 'message_stop' }]]),
        store,
        rootDir: tempDir,
      });
      await session.init();

      let wasBusyInsidePrepare = false;
      const prepareFailed = async () => {
        wasBusyInsidePrepare = session.isBusy();
        throw new Error('Preparation network timeout');
      };

      const consume = async () => {
        for await (const _ of session.runPreparedTask('fetch prompt', prepareFailed)) {
          // consume
        }
      };

      await expect(consume()).rejects.toThrow('Preparation network timeout');

      expect(wasBusyInsidePrepare).toBe(true);
      expect(session.isBusy()).toBe(false);

      // 关键断言：准备失败时，历史中绝对没有留下孤儿 user 消息（0 append）
      const messages = await store.load();
      expect(messages).toHaveLength(0);
    });

    it('performs 0 append if verifyIdentity fails before atomic commit', async () => {
      const storePath = path.join(tempDir, 'history-verify.jsonl');
      const store = new JSONLMessageStore(storePath);
      const session = new AgentSession({
        defaultProfile: TEST_PROFILE,
        defaultProvider: new ScriptedProvider([[{ type: 'message_stop' }]]),
        store,
        rootDir: tempDir,
      });
      await session.init();

      const prepareWithStaleIdentity = async () => {
        return {
          content: 'Expanded prompt content',
          verifyIdentity: () => false, // 目录发生变化，验证未通过
        };
      };

      const consume = async () => {
        for await (const _ of session.runPreparedTask('stale prompt', prepareWithStaleIdentity)) {
          // consume
        }
      };

      await expect(consume()).rejects.toThrow(/Task preparation identity changed before commit/i);

      expect(session.isBusy()).toBe(false);
      const messages = await store.load();
      expect(messages).toHaveLength(0);
    });

    it('commits single user message and drives model run on successful preparation', async () => {
      const storePath = path.join(tempDir, 'history-success.jsonl');
      const store = new JSONLMessageStore(storePath);
      const session = new AgentSession({
        defaultProfile: TEST_PROFILE,
        defaultProvider: new ScriptedProvider([
          [{ type: 'text_delta', text: 'Task completed successfully' }, { type: 'message_stop' }],
        ]),
        store,
        rootDir: tempDir,
      });
      await session.init();

      const events = [];
      for await (const event of session.runPreparedTask('run my template', async () => ({
        content: 'System instruction injected via prompt',
        promptSource: {
          version: 1,
          server: 'git-mcp',
          name: 'pr-review',
        },
      }))) {
        events.push(event);
      }

      // 关键断言：单条 user 消息（带 promptSource）成功原子写入历史，紧随其后的是 assistant 响应
      const messages = await store.load();
      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages[0].role).toBe('user');
      const userText = messages[0].content[1];
      expect(userText).toBeDefined();
      if (userText && userText.type === 'text') {
        expect(userText.text).toBe('System instruction injected via prompt');
        expect(userText.promptSource).toEqual({
          version: 1,
          server: 'git-mcp',
          name: 'pr-review',
        });
      }
    });
  });
});
