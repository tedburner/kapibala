#!/usr/bin/env node
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('1.6.0\n');
  process.exit(0);
}

const unauthenticated = args.includes('--unauthenticated');
const sessIdx = args.indexOf('--session-id');
const resumedId =
  sessIdx >= 0 && typeof args[sessIdx + 1] === 'string' ? args[sessIdx + 1] : undefined;
const sessionId = resumedId ?? '11111111-2222-4333-8444-555555555555';

const extIdx = args.indexOf('--extension');
const extPath = extIdx >= 0 && typeof args[extIdx + 1] === 'string' ? args[extIdx + 1] : undefined;

const toolCallHandlers = [];
if (extPath) {
  const mod = await import(pathToFileURL(extPath).href);
  if (typeof mod.default === 'function') {
    mod.default({
      on(eventName, handler) {
        if (eventName === 'tool_call' && typeof handler === 'function') {
          toolCallHandlers.push(handler);
        }
      },
    });
  }
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

let uiReqSeq = 0;
const pendingUiReqs = new Map();
let activeWaitTimer = null;
let waitingAbort = false;

function requestUiSelect(title, options) {
  const id = `ui_req_${++uiReqSeq}`;
  return new Promise((resolve) => {
    pendingUiReqs.set(id, resolve);
    send({
      type: 'extension_ui_request',
      id,
      method: 'select',
      title,
      options,
    });
  });
}

async function runToolCallHooks(toolName, toolCallId, input) {
  const ctx = {
    hasUI: true,
    ui: {
      select: (title, options) => requestUiSelect(title, options),
    },
  };
  for (const handler of toolCallHandlers) {
    const res = await handler({ toolName, toolCallId, input }, ctx);
    if (res?.block) {
      return res;
    }
  }
  return undefined;
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let frame;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (frame.type === 'extension_ui_response') {
    const resolver = pendingUiReqs.get(frame.id);
    if (resolver) {
      pendingUiReqs.delete(frame.id);
      resolver(frame.cancelled ? undefined : frame.value);
    }
    return;
  }

  if (frame.type === 'get_state') {
    send({
      id: frame.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: {
        sessionId,
        model: unauthenticated
          ? null
          : {
              provider: 'anthropic',
              id: 'claude-sonnet-4-6',
              name: 'Claude Sonnet 4.6',
            },
        thinkingLevel: 'medium',
        isStreaming: false,
      },
    });
    return;
  }

  if (frame.type === 'get_available_models') {
    send({
      id: frame.id,
      type: 'response',
      command: 'get_available_models',
      success: true,
      data: {
        models: unauthenticated
          ? []
          : [{ provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }],
      },
    });
    return;
  }

  if (frame.type === 'abort') {
    send({
      id: frame.id,
      type: 'response',
      command: 'abort',
      success: true,
    });
    if (waitingAbort) {
      waitingAbort = false;
      if (activeWaitTimer) {
        clearTimeout(activeWaitTimer);
        activeWaitTimer = null;
      }
      send({ type: 'agent_settled', aborted: true });
    }
    return;
  }

  if (frame.type === 'prompt') {
    const text = typeof frame.message === 'string' ? frame.message : '';
    send({
      id: frame.id,
      type: 'response',
      command: 'prompt',
      success: true,
      data: { disposition: 'started' },
    });

    if (text === 'WAIT_ABORT') {
      waitingAbort = true;
      send({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'Pi working...' },
      });
      activeWaitTimer = setTimeout(() => {
        waitingAbort = false;
        send({ type: 'agent_settled', aborted: false });
      }, 30_000);
      return;
    }

    if (text === 'READ_ONLY_TOOL') {
      const blocked = await runToolCallHooks('read', 'pi_read_1', { path: 'README.md' });
      if (blocked?.block) {
        send({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            delta: `Unexpected block: ${blocked.reason}`,
          },
        });
      } else {
        send({
          type: 'tool_execution_start',
          toolCallId: 'pi_read_1',
          toolName: 'read',
          args: { path: 'README.md' },
        });
        send({
          type: 'tool_execution_end',
          toolCallId: 'pi_read_1',
          toolName: 'read',
          result: { content: [{ type: 'text', text: '# Kapibala' }] },
          isError: false,
        });
        send({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Read README without approval.' },
        });
      }
      send({
        type: 'message_end',
        message: {
          role: 'assistant',
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
        },
      });
      send({ type: 'agent_settled', aborted: false });
      return;
    }

    if (text.startsWith('WRITE_APPROVAL')) {
      const callId = `pi_bash_${Date.now()}`;
      const blocked = await runToolCallHooks('bash', callId, { command: 'npm run build' });
      if (blocked?.block) {
        send({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            delta: `Pi tool blocked: ${blocked.reason}`,
          },
        });
      } else {
        send({
          type: 'tool_execution_start',
          toolCallId: callId,
          toolName: 'bash',
          args: { command: 'npm run build' },
        });
        send({
          type: 'tool_execution_end',
          toolCallId: callId,
          toolName: 'bash',
          result: { content: [{ type: 'text', text: 'Build succeeded' }] },
          isError: false,
        });
        send({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Pi bash executed!' },
        });
      }
      send({
        type: 'message_end',
        message: {
          role: 'assistant',
          usage: { input: 18, output: 12, cacheRead: 2, cacheWrite: 0, totalTokens: 32 },
        },
      });
      send({ type: 'agent_settled', aborted: false });
      return;
    }

    send({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'Pi thinking...' },
    });
    const prefix = resumedId ? `[pi-resumed:${resumedId}] ` : '';
    send({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: `${prefix}Pi reply: ${text}` },
    });
    send({
      type: 'message_end',
      message: {
        role: 'assistant',
        usage: { input: 20, output: 10, cacheRead: 5, cacheWrite: 0, totalTokens: 35 },
      },
    });
    send({ type: 'agent_settled', aborted: false });
  }
});

rl.on('close', () => {
  if (activeWaitTimer) clearTimeout(activeWaitTimer);
  process.exit(0);
});
