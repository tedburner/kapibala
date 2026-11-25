import readline from 'node:readline';

const args = process.argv.slice(2);
const unauthenticated = args.includes('--unauthenticated');

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

let nextServerReqId = 1000;
const pendingServerReqs = new Map();
let slowTimer = null;
let activeTurnId = null;
let threadCounter = 0;

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const frame = JSON.parse(trimmed);

  // Codex jsonrpc_lite 严禁要求客户端携带 jsonrpc: "2.0"
  if ('jsonrpc' in frame) {
    send({
      id: frame.id ?? 0,
      error: { code: -32600, message: 'Unexpected jsonrpc field in codex jsonrpc_lite' },
    });
    return;
  }

  // 客户端对服务端审批请求的回复
  if (frame.id !== undefined && !frame.method && ('result' in frame || 'error' in frame)) {
    const resolver = pendingServerReqs.get(frame.id);
    if (resolver) {
      pendingServerReqs.delete(frame.id);
      resolver(frame.result);
    }
    return;
  }

  if (frame.method === 'initialize') {
    send({
      id: frame.id,
      result: {
        userAgent: 'codex_cli_rs/0.171.0 (windows; x86_64)',
      },
    });
    return;
  }

  if (frame.method === 'initialized') {
    return;
  }

  if (frame.method === 'account/read') {
    send({
      id: frame.id,
      result: {
        account: unauthenticated ? null : { type: 'chatgpt', email: 'dev@example.com' },
        requiresOpenaiAuth: true,
      },
    });
    return;
  }

  if (frame.method === 'thread/start') {
    threadCounter += 1;
    const threadId = `codex-thread-${process.pid}-${threadCounter}`;
    send({
      id: frame.id,
      result: {
        thread: { id: threadId, model: 'gpt-5.2-codex' },
        model: 'gpt-5.2-codex',
        approvalPolicy: 'on-request',
        sandbox: { type: 'workspaceWrite' },
      },
    });
    send({
      method: 'thread/started',
      params: { thread: { id: threadId } },
    });
    return;
  }

  if (frame.method === 'thread/resume') {
    const threadId = frame.params?.threadId ?? 'resumed-thread';
    send({
      id: frame.id,
      result: {
        thread: { id: threadId, model: 'gpt-5.2-codex' },
        model: 'gpt-5.2-codex',
        approvalPolicy: 'on-request',
        sandbox: { type: 'workspaceWrite' },
      },
    });
    return;
  }

  if (frame.method === 'turn/interrupt') {
    if (slowTimer) {
      clearTimeout(slowTimer);
      slowTimer = null;
    }
    send({ id: frame.id, result: {} });
    if (activeTurnId) {
      const tid = activeTurnId;
      activeTurnId = null;
      send({
        method: 'turn/completed',
        params: {
          threadId: frame.params?.threadId,
          turn: { id: tid, status: 'interrupted' },
        },
      });
    }
    return;
  }

  if (frame.method === 'turn/start') {
    const threadId = frame.params?.threadId ?? 'thread-1';
    const inputItems = Array.isArray(frame.params?.input) ? frame.params.input : [];
    const text = inputItems.map((i) => i.text ?? '').join('\n');
    const turnId = `turn-${Date.now()}`;
    activeTurnId = turnId;

    if (text.includes('delayed-start')) {
      setTimeout(() => {
        send({
          id: frame.id,
          result: {
            turn: { id: turnId, status: 'inProgress', items: [] },
          },
        });
      }, 90);
      slowTimer = setTimeout(() => {
        activeTurnId = null;
        send({
          method: 'turn/completed',
          params: { threadId, turn: { id: turnId, status: 'completed' } },
        });
      }, 30_000);
      return;
    }

    send({
      id: frame.id,
      result: {
        turn: { id: turnId, status: 'inProgress', items: [] },
      },
    });

    if (text.includes('crash')) {
      process.stderr.write('simulated codex crash\n');
      process.exit(2);
    }

    if (text.includes('slow')) {
      send({
        method: 'item/agentMessage/delta',
        params: { threadId, turnId, itemId: 'msg-slow', delta: 'Codex working slowly...' },
      });
      slowTimer = setTimeout(() => {
        activeTurnId = null;
        send({
          method: 'turn/completed',
          params: { threadId, turn: { id: turnId, status: 'completed' } },
        });
      }, 30_000);
      return;
    }

    if (text.includes('approval')) {
      const itemId = `cmd-${turnId}`;
      send({
        method: 'item/started',
        params: {
          threadId,
          turnId,
          item: {
            id: itemId,
            type: 'commandExecution',
            command: 'pnpm lint',
            status: 'inProgress',
          },
        },
      });
      const srvReqId = nextServerReqId++;
      pendingServerReqs.set(srvReqId, (res) => {
        const decision = res?.decision;
        if (decision === 'accept' || decision === 'acceptForSession') {
          send({
            method: 'item/commandExecution/outputDelta',
            params: { threadId, turnId, itemId, delta: 'Lint clean\n' },
          });
          send({
            method: 'item/completed',
            params: {
              threadId,
              turnId,
              item: {
                id: itemId,
                type: 'commandExecution',
                command: 'pnpm lint',
                status: 'completed',
                exitCode: 0,
                aggregatedOutput: 'Lint clean\n',
              },
            },
          });
          send({
            method: 'item/agentMessage/delta',
            params: {
              threadId,
              turnId,
              itemId: 'msg-apr',
              delta: `Codex approved (${decision})`,
            },
          });
        } else {
          send({
            method: 'item/completed',
            params: {
              threadId,
              turnId,
              item: {
                id: itemId,
                type: 'commandExecution',
                command: 'pnpm lint',
                status: 'declined',
                exitCode: 1,
              },
            },
          });
          send({
            method: 'item/agentMessage/delta',
            params: {
              threadId,
              turnId,
              itemId: 'msg-apr',
              delta: `Codex declined (${decision})`,
            },
          });
        }
        activeTurnId = null;
        send({
          method: 'turn/completed',
          params: { threadId, turn: { id: turnId, status: 'completed' } },
        });
      });
      send({
        id: srvReqId,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId,
          turnId,
          itemId,
          command: 'pnpm lint',
          reason: 'Verify repository lint rules',
        },
      });
      return;
    }

    send({
      method: 'turn/plan/updated',
      params: {
        threadId,
        turnId,
        plan: [
          { step: 'Start app-server', status: 'completed' },
          { step: 'Reply via jsonrpc_lite', status: 'inProgress' },
        ],
      },
    });
    send({
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId, turnId, itemId: 'rsn-1', delta: 'Thinking in Codex...' },
    });
    const fullReply = `Codex [${threadId}] reply: ${text}`;
    send({
      method: 'item/agentMessage/delta',
      params: { threadId, turnId, itemId: 'msg-1', delta: fullReply.slice(0, 10) },
    });
    send({
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        item: { id: 'msg-1', type: 'agentMessage', text: fullReply },
      },
    });
    send({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId,
        turnId,
        tokenUsage: {
          last: { inputTokens: 50, cachedInputTokens: 15, outputTokens: 25, totalTokens: 90 },
        },
      },
    });
    activeTurnId = null;
    send({
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status: 'completed' } },
    });
  }
});

rl.on('close', () => {
  if (slowTimer) clearTimeout(slowTimer);
  process.exit(0);
});
