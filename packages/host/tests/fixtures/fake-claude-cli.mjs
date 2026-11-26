import readline from 'node:readline';

const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('2.1.325 (Claude Code)\n');
  process.exit(0);
}

if (args.includes('auth') && args.includes('status')) {
  const loggedIn = !args.includes('--auth-fail');
  process.stdout.write(`${JSON.stringify({ loggedIn })}\n`);
  process.exit(loggedIn ? 0 : 1);
}

const resumeIdx = args.indexOf('--resume');
const resumedSessionId =
  resumeIdx >= 0 && typeof args[resumeIdx + 1] === 'string' ? args[resumeIdx + 1] : undefined;
const sessionId = resumedSessionId ?? `claude-sess-${process.pid}`;

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

let pendingApproval = null;
let slowTimer = null;
let turnCount = 0;

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);

  if (msg.type === 'control_request') {
    const subtype = msg.request?.subtype;
    if (subtype === 'initialize') {
      emit({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: msg.request_id,
          response: {
            commands: [],
            agents: [],
            output_style: 'default',
            available_output_styles: ['default'],
            models: [{ value: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' }],
            account: {},
          },
        },
      });
      return;
    }
    if (subtype === 'interrupt') {
      if (slowTimer) {
        clearTimeout(slowTimer);
        slowTimer = null;
      }
      emit({
        type: 'result',
        subtype: 'error_interrupted',
        is_error: false,
        session_id: sessionId,
        result: '',
        usage: { input_tokens: 10, output_tokens: 4 },
      });
      return;
    }
    return;
  }

  if (msg.type === 'control_response' && pendingApproval) {
    const resp = msg.response;
    if (resp?.request_id === pendingApproval.requestId) {
      const fn = pendingApproval.resolve;
      pendingApproval = null;
      fn(resp.response);
    }
    return;
  }

  if (msg.type === 'user') {
    turnCount += 1;
    const contentArr = Array.isArray(msg.message?.content) ? msg.message.content : [];
    const text = contentArr.map((c) => c.text ?? '').join('\n');

    emit({
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      model: 'claude-sonnet-4-6',
      permissionMode: 'default',
    });

    if (text.includes('crash')) {
      process.stderr.write('simulated claude fatal error\n');
      process.exit(1);
    }

    if (text.includes('slow')) {
      emit({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Working slowly...' },
        },
      });
      slowTimer = setTimeout(() => {
        emit({
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: sessionId,
          result: 'finished slow',
          usage: { input_tokens: 20, output_tokens: 10 },
        });
      }, 30_000);
      return;
    }

    if (text.includes('multistep')) {
      emit({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Step1 streamed. ' },
        },
      });
      emit({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Step1 streamed. ' },
            {
              type: 'tool_use',
              id: `toolu_step_${turnCount}`,
              name: 'Read',
              input: { file_path: 'package.json' },
            },
          ],
        },
      });
      emit({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: `toolu_step_${turnCount}`,
              content: '{"name":"demo"}',
              is_error: false,
            },
          ],
        },
      });
      emit({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Step2 non-streamed!' }],
        },
      });
      emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: sessionId,
        result: 'Step1 streamed. Step2 non-streamed!',
        usage: { input_tokens: 15, output_tokens: 10 },
      });
      return;
    }

    if (text.includes('plan')) {
      emit({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: `toolu_plan_${turnCount}`,
              name: 'TodoWrite',
              input: {
                todos: [
                  { id: 't1', content: 'Inspect repository', status: 'completed' },
                  { id: 't2', content: 'Verify Claude driver', status: 'in_progress' },
                ],
              },
            },
          ],
        },
      });
      emit({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: `toolu_plan_${turnCount}`,
              content: 'Todos updated',
              is_error: false,
            },
          ],
        },
      });
    }

    if (text.includes('cancel-approval')) {
      const reqId = `perm_cancel_${turnCount}`;
      const toolUseId = `toolu_cancel_${turnCount}`;
      emit({
        type: 'control_request',
        request_id: reqId,
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'echo transient' },
          tool_use_id: toolUseId,
        },
      });
      setTimeout(() => {
        emit({
          type: 'control_cancel_request',
          request_id: reqId,
        });
        emit({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Approval withdrawn cleanly.' },
          },
        });
        emit({
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: sessionId,
          result: 'Approval withdrawn cleanly.',
          usage: { input_tokens: 12, output_tokens: 6 },
        });
      }, 60);
      return;
    }

    if (text.includes('approval')) {
      const reqId = `perm_req_${turnCount}`;
      const toolUseId = `toolu_bash_${turnCount}`;
      pendingApproval = {
        requestId: reqId,
        resolve: (decision) => {
          if (decision?.behavior === 'allow' && decision?.updatedInput?.command === 'npm test') {
            emit({
              type: 'assistant',
              message: {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: toolUseId,
                    name: 'Bash',
                    input: decision.updatedInput,
                  },
                ],
              },
            });
            emit({
              type: 'user',
              message: {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    content: 'All tests passed',
                    is_error: false,
                  },
                ],
              },
            });
            emit({
              type: 'stream_event',
              event: {
                type: 'content_block_delta',
                delta: { type: 'text_delta', text: 'Approved and executed!' },
              },
            });
            emit({
              type: 'result',
              subtype: 'success',
              is_error: false,
              session_id: sessionId,
              result: 'Approved and executed!',
              usage: { input_tokens: 30, output_tokens: 15 },
            });
          } else {
            emit({
              type: 'user',
              message: {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    content: decision?.message ?? 'Denied',
                    is_error: true,
                  },
                ],
              },
            });
            emit({
              type: 'stream_event',
              event: {
                type: 'content_block_delta',
                delta: { type: 'text_delta', text: 'Tool execution denied.' },
              },
            });
            emit({
              type: 'result',
              subtype: 'success',
              is_error: false,
              session_id: sessionId,
              result: 'Tool execution denied.',
              usage: { input_tokens: 25, output_tokens: 12 },
            });
          }
        },
      };
      emit({
        type: 'control_request',
        request_id: reqId,
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'npm test' },
          tool_use_id: toolUseId,
          decision_reason: 'Run test suite in workspace',
        },
      });
      return;
    }

    emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'Analyzing request...' },
      },
    });
    const replyText = resumedSessionId
      ? `[resumed:${resumedSessionId}] Claude reply: ${text}`
      : `Claude reply: ${text}`;
    emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: replyText },
      },
    });
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: sessionId,
      result: replyText,
      usage: {
        input_tokens: 40,
        cache_read_input_tokens: 10,
        output_tokens: 20,
      },
    });
  }
});

rl.on('close', () => {
  if (slowTimer) clearTimeout(slowTimer);
  process.exit(0);
});
