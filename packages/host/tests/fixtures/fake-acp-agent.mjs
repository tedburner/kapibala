#!/usr/bin/env node
/**
 * 测试专用假 ACP 子进程：通过启动参数模拟真实 CLI（OpenCode / DSH / Antigravity）的协议行为与边界怪癖。
 *
 * 支持模式（首个参数或 --mode=<mode>）：
 * - normal: 标准握手、session/new（校验 mcpServers 数组）、流式思考/文本/计划、审批先于 tool_call、反向 fs 请求探针、取消支持
 * - opencode-load: 模拟 OpenCode 1.19.3 session/load 在返回结果前先推送重放通知，且响应不含 sessionId 字段
 * - dsh-resume: 模拟 DSH 0.2.0-rc.2 仅声明 sessionCapabilities.resume: {} 而不声明 loadSession: true
 * - agy-auth-ok: 模拟 Antigravity 声明 oauth-personal 且必须先调 authenticate 才允许建会话
 * - agy-auth-fail: 模拟 Antigravity 未登录（authenticate 返回 -32000 Authentication required）
 * - tui-flood: 模拟误配交互式 TUI 命令持续刷非 JSON 文本
 */
import readline from 'node:readline';

const modeArg = process.argv.find((arg) => arg.startsWith('--mode='));
const mode = modeArg ? modeArg.slice('--mode='.length) : 'normal';

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

if (mode === 'tui-flood') {
  for (let i = 0; i < 120; i++) {
    process.stdout.write(`\x1b[32mInteractive TUI frame ${i}\x1b[0m\n`);
  }
  setTimeout(() => process.exit(0), 200);
} else {
  // 打印一行非 JSON 启动横幅验证宿主容错
  process.stdout.write('Fake ACP Agent Banner v1.0.0\n');

  let authenticated = mode !== 'agy-auth-ok' && mode !== 'agy-auth-fail';
  let activePromptId = null;
  let fsProbeErrorCode = null;

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  rl.on('close', () => {
    process.exit(0);
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }

    // 客户端对服务端请求的响应（如审批结果或 fs/read_text_file 的 -32601 拒绝）
    if (msg.id !== undefined && msg.method === undefined) {
      if (msg.id === 'probe-fs-1' && msg.error) {
        fsProbeErrorCode = msg.error.code;
        return;
      }
      if (msg.id === 'perm-1' && activePromptId !== null) {
        const outcome = msg.result?.outcome;
        const selectedOption = outcome?.outcome === 'selected' ? outcome.optionId : 'cancelled';
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'ses_demo_1',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'call_bash_1',
              status: selectedOption.startsWith('allow') ? 'completed' : 'failed',
              rawOutput: {
                combinedOutput: `approved=${selectedOption};fsProbe=${fsProbeErrorCode}`,
              },
            },
          },
        });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'ses_demo_1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `执行完毕（${selectedOption}）` },
            },
          },
        });
        const promptId = activePromptId;
        activePromptId = null;
        send({
          jsonrpc: '2.0',
          id: promptId,
          result: {
            stopReason: 'end_turn',
            usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
          },
        });
      }
      return;
    }

    if (msg.method === 'initialize') {
      if (mode === 'agy-auth-ok' || mode === 'agy-auth-fail') {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'antigravity', version: '1.5.2' },
            authMethods: [null, { id: 'oauth-personal', name: 'Google Account' }],
            agentCapabilities: { loadSession: true },
          },
        });
        return;
      }
      if (mode === 'dsh-resume') {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'deepseek-harness', version: '0.2.0-rc.2' },
            agentCapabilities: {
              loadSession: false,
              sessionCapabilities: { resume: {} },
            },
          },
        });
        return;
      }
      if (mode === 'generic') {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'custom-generic-agent', version: '1.0.0' },
            agentCapabilities: { loadSession: false },
          },
        });
        return;
      }
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'opencode', version: '1.19.3' },
          agentCapabilities: { loadSession: true },
        },
      });
      return;
    }

    if (msg.method === 'authenticate') {
      if (mode === 'agy-auth-fail') {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: 'Authentication required: please run agy acp --login' },
        });
        return;
      }
      authenticated = true;
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    }

    if (msg.method === 'session/new') {
      if (!authenticated) {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: 'Authentication required before session/new' },
        });
        return;
      }
      if (!Array.isArray(msg.params?.mcpServers)) {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32602, message: 'mcpServers array is required' },
        });
        return;
      }
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          sessionId: 'ses_demo_1',
          configOptions: [
            { broken: true },
            {
              id: 'model',
              category: 'model',
              currentValue: 'deepseek-chat',
              options: [{ value: 'deepseek-chat', name: 'DeepSeek Chat' }],
            },
            {
              id: 'mode',
              category: 'mode',
              currentValue: 'code',
              options: [{ value: 'code', name: 'Code' }],
            },
          ],
        },
      });
      return;
    }

    if (msg.method === 'session/load' || msg.method === 'session/resume') {
      const targetId = msg.params?.sessionId;
      // 模拟 OpenCode 1.19.3：在返回响应前先把历史更新推到 stdout，且响应体省略 sessionId 字段
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: targetId,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: '历史问题：1+1等于几？' },
          },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: targetId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '历史回答：等于 2。' },
          },
        },
      });
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          configOptions: [
            {
              id: 'model',
              category: 'model',
              currentValue: 'opencode-pro',
              options: [{ value: 'opencode-pro', name: 'OpenCode Pro' }],
            },
          ],
        },
      });
      return;
    }

    if (msg.method === 'session/cancel') {
      if (activePromptId !== null) {
        const promptId = activePromptId;
        activePromptId = null;
        send({
          jsonrpc: '2.0',
          id: promptId,
          result: { stopReason: 'cancelled' },
        });
      }
      return;
    }

    if (msg.method === 'session/prompt') {
      const text = msg.params?.prompt?.[0]?.text ?? '';
      const sessionId = msg.params?.sessionId ?? 'ses_demo_1';

      if (text === 'WAIT_CANCEL') {
        activePromptId = msg.id;
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: '正在执行长耗时分析...' },
            },
          },
        });
        return;
      }

      if (text === 'NEED_APPROVAL') {
        activePromptId = msg.id;
        // 1. 先回显 user_message_chunk（测试宿主去重）
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'NEED_APPROVAL' },
            },
          },
        });
        // 2. 推送思考与计划（entries 字段）
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: '准备运行受控命令' },
            },
          },
        });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'plan',
              entries: [
                { content: '检查工作区状态', status: 'in_progress' },
                { content: '汇总结果', status: 'pending' },
              ],
            },
          },
        });
        // 3. 发起反向 fs/read_text_file 请求，验证宿主严格返回 -32601
        send({
          jsonrpc: '2.0',
          id: 'probe-fs-1',
          method: 'fs/read_text_file',
          params: { sessionId, path: '/etc/hosts' },
        });
        // 4. 在未提前发 tool_call 通知的情况下直接发 session/request_permission（测试 noteToolCall 预补卡与 allow_session 保留）
        send({
          jsonrpc: '2.0',
          id: 'perm-1',
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: {
              toolCallId: 'call_bash_1',
              title: 'Run Command',
              kind: 'execute',
              rawInput: { CommandLine: 'git status --short' },
            },
            options: [
              { optionId: 'allow-once', name: '允许本次', kind: 'allow_once' },
              { optionId: 'allow-session', name: '本会话允许', kind: 'allow_session' },
              { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' },
            ],
          },
        });
        return;
      }

      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `收到:${text}` },
          },
        },
      });
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { stopReason: 'end_turn' },
      });
    }
  });
}
