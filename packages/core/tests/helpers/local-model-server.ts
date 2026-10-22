import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 测试专用的本地模型端点，按脚本回放三种 wire 协议的 SSE。
 * 只监听 loopback，不校验真实凭据；脚本必须被完全消费，否则 {@link LocalModelServer.assertConsumed}
 * 会失败，避免「少跑一步仍然通过」。这里替代外部模型服务，但请求解析、流状态机和工具事务仍走真实实现。
 */
export type LocalProtocol = 'anthropic' | 'chat' | 'responses';

/** 一条待回放的模型输出；`hold` 用于取消/提前返回场景，连接保持到客户端主动断开。 */
export type LocalTurn =
  | { kind: 'text'; text: string; chunks?: string[] }
  | { kind: 'tools'; calls: LocalToolCall[]; text?: string }
  | { kind: 'hold'; text?: string };

/** 一次工具调用；参数按协议编码，不在这里执行工具。 */
export interface LocalToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** 捕获到的模型请求；headers 保留原样用于凭据断言，body 为解析后的 JSON。 */
export interface LocalModelRequest {
  protocol: LocalProtocol;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/** 可复用的确定性模型服务；脚本按协议队列独立消费。 */
export interface LocalModelServer {
  readonly baseURL: string;
  readonly requests: LocalModelRequest[];
  /** 为指定协议追加脚本；同一协议的脚本严格按入队顺序回放。 */
  script(protocol: LocalProtocol, ...turns: LocalTurn[]): void;
  /** 返回指定协议或全部协议尚未消费的脚本数。 */
  pending(protocol?: LocalProtocol): number;
  /** 等待所有保持连接被客户端关闭；取消测试用它确认清理完成。 */
  waitForClosedHolds(timeoutMs?: number): Promise<void>;
  /** 脚本未消费、出现多余请求或内部失败时抛错。 */
  assertConsumed(): void;
  close(): Promise<void>;
}

const routeProtocol = (pathname: string): LocalProtocol | undefined => {
  if (pathname === '/v1/chat/completions') return 'chat';
  if (pathname === '/v1/messages') return 'anthropic';
  if (pathname === '/v1/responses') return 'responses';
  return undefined;
};

const sse = (type: string, payload: unknown): string =>
  `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;

const chunkedText = (turn: Extract<LocalTurn, { kind: 'text' }>): string[] =>
  turn.chunks && turn.chunks.length > 0 ? turn.chunks : [turn.text];

const write = (res: http.ServerResponse, value: string): boolean => {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(value);
    return true;
  } catch {
    return false;
  }
};

const messageItem = (id: string, text: string, phase?: 'commentary' | 'final_answer') => ({
  type: 'message',
  id,
  role: 'assistant',
  status: 'completed',
  ...(phase ? { phase } : {}),
  content: [{ type: 'output_text', text, annotations: [] }],
});

/**
 * 启动 loopback 模型服务。端口由系统分配，测试之间互不共享状态。
 * 请求体必须是 JSON 对象；多余请求或脚本耗尽会记录失败并返回 500，不会被静默忽略。
 */
export async function startLocalModelServer(): Promise<LocalModelServer> {
  const queues: Record<LocalProtocol, LocalTurn[]> = {
    chat: [],
    anthropic: [],
    responses: [],
  };
  const requests: LocalModelRequest[] = [];
  const failures: string[] = [];
  const holds = new Set<http.ServerResponse>();
  const holdWaiters = new Set<() => void>();
  const sockets = new Set<import('node:net').Socket>();

  const notifyHoldsClosed = (): void => {
    if (holds.size > 0) return;
    for (const resolve of holdWaiters) resolve();
    holdWaiters.clear();
  };

  const finish = (res: http.ServerResponse): void => {
    if (!res.writableEnded && !res.destroyed) res.end();
  };

  const fail = (res: http.ServerResponse, message: string): void => {
    failures.push(message);
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message } }));
  };

  const writeChat = (res: http.ServerResponse, turn: LocalTurn): void => {
    if (turn.kind === 'hold') {
      if (turn.text) {
        write(
          res,
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: { content: turn.text }, finish_reason: null }],
          })}\n\n`,
        );
      }
      return;
    }
    const finishChunk = (reason: 'stop' | 'tool_calls') => {
      write(
        res,
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: reason }],
        })}\n\n`,
      );
      write(
        res,
        `data: ${JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
        })}\n\n`,
      );
      write(res, 'data: [DONE]\n\n');
      finish(res);
    };
    if (turn.kind === 'text') {
      for (const text of chunkedText(turn)) {
        if (
          !write(
            res,
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
            })}\n\n`,
          )
        )
          return;
      }
      finishChunk('stop');
      return;
    }
    if (turn.text) {
      write(
        res,
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: { content: turn.text }, finish_reason: null }],
        })}\n\n`,
      );
    }
    write(
      res,
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: turn.calls.map((call, index) => ({
                index,
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              })),
            },
            finish_reason: null,
          },
        ],
      })}\n\n`,
    );
    finishChunk('tool_calls');
  };

  const writeAnthropic = (res: http.ServerResponse, turn: LocalTurn): void => {
    write(
      res,
      sse('message_start', {
        type: 'message_start',
        message: {
          id: `msg-${requests.length}`,
          type: 'message',
          role: 'assistant',
          content: [],
          usage: { input_tokens: 20 },
        },
      }),
    );
    if (turn.kind === 'hold') {
      write(
        res,
        sse('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      );
      if (turn.text) {
        write(
          res,
          sse('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: turn.text },
          }),
        );
      }
      return;
    }
    let index = 0;
    if (turn.kind === 'text') {
      write(
        res,
        sse('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        }),
      );
      for (const text of chunkedText(turn)) {
        if (
          !write(
            res,
            sse('content_block_delta', {
              type: 'content_block_delta',
              index,
              delta: { type: 'text_delta', text },
            }),
          )
        )
          return;
      }
      write(res, sse('content_block_stop', { type: 'content_block_stop', index }));
      index += 1;
    } else {
      for (const call of turn.calls) {
        write(
          res,
          sse('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: {
              type: 'tool_use',
              id: call.id,
              name: call.name,
              input: call.input,
            },
          }),
        );
        write(res, sse('content_block_stop', { type: 'content_block_stop', index }));
        index += 1;
      }
    }
    write(
      res,
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: turn.kind === 'tools' ? 'tool_use' : 'end_turn' },
        usage: { output_tokens: 4 },
      }),
    );
    write(res, sse('message_stop', { type: 'message_stop' }));
    finish(res);
  };

  const writeResponses = (res: http.ServerResponse, turn: LocalTurn): void => {
    if (turn.kind === 'hold') {
      write(
        res,
        sse('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'message',
            id: `msg-${requests.length}`,
            role: 'assistant',
            status: 'in_progress',
            content: [],
          },
        }),
      );
      if (turn.text) {
        write(
          res,
          sse('response.output_text.delta', {
            type: 'response.output_text.delta',
            output_index: 0,
            item_id: `msg-${requests.length}`,
            content_index: 0,
            delta: turn.text,
          }),
        );
      }
      return;
    }
    const output: unknown[] = [];
    const itemId = `msg-${requests.length}`;
    if (turn.kind === 'text') {
      if (turn.chunks && turn.chunks.length > 0) {
        const full = turn.chunks.join('');
        write(
          res,
          sse('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              type: 'message',
              id: itemId,
              role: 'assistant',
              status: 'in_progress',
              content: [],
            },
          }),
        );
        for (const chunk of turn.chunks) {
          write(
            res,
            sse('response.output_text.delta', {
              type: 'response.output_text.delta',
              output_index: 0,
              item_id: itemId,
              content_index: 0,
              delta: chunk,
            }),
          );
        }
        write(
          res,
          sse('response.output_text.done', {
            type: 'response.output_text.done',
            output_index: 0,
            item_id: itemId,
            content_index: 0,
            text: full,
          }),
        );
        const item = messageItem(itemId, full, 'final_answer');
        write(
          res,
          sse('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: 0,
            item,
          }),
        );
        output.push(item);
      } else {
        output.push(messageItem(itemId, turn.text, 'final_answer'));
      }
    } else {
      if (turn.text) output.push(messageItem(itemId, turn.text, 'commentary'));
      turn.calls.forEach((call, index) => {
        output.push({
          type: 'function_call',
          id: `fc-${requests.length}-${index}`,
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input),
          status: 'completed',
        });
      });
    }
    write(
      res,
      sse('response.completed', {
        type: 'response.completed',
        response: {
          id: `resp-${requests.length}`,
          status: 'completed',
          output,
          usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
        },
      }),
    );
    finish(res);
  };

  const server = http.createServer((req, res) => {
    res.on('error', () => {});
    sockets.add(req.socket);
    req.socket.on('close', () => sockets.delete(req.socket));
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const protocol = routeProtocol(url.pathname);
    if (req.method !== 'POST' || !protocol) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: Record<string, unknown>;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        body = parsed as Record<string, unknown>;
      } catch {
        fail(res, `invalid ${protocol} request body`);
        return;
      }
      requests.push({ protocol, path: url.pathname, headers: req.headers, body });
      const turn = queues[protocol].shift();
      if (!turn) {
        fail(res, `unexpected ${protocol} model request`);
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.flushHeaders();
      if (turn.kind === 'hold') {
        holds.add(res);
        res.on('close', () => {
          holds.delete(res);
          notifyHoldsClosed();
        });
      }
      if (protocol === 'chat') writeChat(res, turn);
      else if (protocol === 'anthropic') writeAnthropic(res, turn);
      else writeResponses(res, turn);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    script(protocol, ...turns) {
      queues[protocol].push(...turns);
    },
    pending(protocol) {
      if (protocol) return queues[protocol].length;
      return queues.chat.length + queues.anthropic.length + queues.responses.length;
    },
    async waitForClosedHolds(timeoutMs = 2_000) {
      if (holds.size === 0) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('held model response was not closed')),
          timeoutMs,
        );
        holdWaiters.add(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    assertConsumed() {
      if (failures.length > 0) throw new Error(failures.join('; '));
      const remaining = queues.chat.length + queues.anthropic.length + queues.responses.length;
      if (remaining > 0)
        throw new Error(
          `unconsumed model scripts: chat=${queues.chat.length}, anthropic=${queues.anthropic.length}, responses=${queues.responses.length}`,
        );
    },
    async close() {
      for (const res of holds) res.destroy();
      holds.clear();
      notifyHoldsClosed();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
