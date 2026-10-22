import http from 'node:http';

/**
 * 四组合兼容脚本共用的确定性 Chat Completions 模型服务。
 * 只替代外部网络：按最后一次用户输入选择工具、长文本或挂起脚本，
 * 工具续轮只在最后一条消息是 tool 时结束，避免复用会话时误判为工具结果轮。
 */
export async function startCompatModelServer() {
  const held = new Set();
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body || '{}');
    const messages = parsed.messages ?? [];
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    const input =
      typeof lastUser?.content === 'string'
        ? lastUser.content
        : JSON.stringify(lastUser?.content ?? '');
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'close',
    });
    const send = (choice) =>
      response.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-compat',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'compat-fixture',
          choices: [choice],
        })}\n\n`,
      );
    const text = (value, finish = null) =>
      send({ index: 0, delta: value === null ? {} : { content: value }, finish_reason: finish });

    if (messages.at(-1)?.role === 'tool') {
      text('tool-done');
      text(null, 'stop');
      response.write('data: [DONE]\n\n');
      response.end();
      return;
    }
    if (input.includes('compat-cancel')) {
      held.add(response);
      text('partial');
      response.on('close', () => held.delete(response));
      return;
    }
    if (input.includes('compat-smoke')) {
      text('local-smoke-ok');
      text(null, 'stop');
      response.write('data: [DONE]\n\n');
      response.end();
      return;
    }
    if (input.includes('compat-long')) {
      const block = '长文本兼容分页样本'.repeat(1024);
      for (let index = 0; index < 8; index++) text(block);
      text(null, 'stop');
      response.write('data: [DONE]\n\n');
      response.end();
      return;
    }
    if (input.includes('compat-tree')) {
      // 进程树验收脚本由探针写入工作区；这里只决定要执行的命令，不内置平台分支。
      send({
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call-tree',
              type: 'function',
              function: {
                name: 'run_command',
                arguments: JSON.stringify({
                  command: `"${process.execPath}" compat-tree.cjs`,
                  timeout_ms: 600000,
                }),
              },
            },
          ],
        },
        finish_reason: null,
      });
      text(null, 'tool_calls');
      response.write('data: [DONE]\n\n');
      response.end();
      return;
    }
    const approval = input.includes('compat-approval');
    const file = approval ? 'compat/approved.txt' : 'compat/proof.txt';
    send({
      index: 0,
      delta: {
        tool_calls: [
          {
            index: 0,
            id: approval ? 'call-approval' : 'call-tool',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: file, content: approval ? 'approved' : 'compat' }),
            },
          },
        ],
      },
      finish_reason: null,
    });
    text(null, 'tool_calls');
    response.write('data: [DONE]\n\n');
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    close() {
      for (const response of held) response.destroy();
      held.clear();
      server.close();
    },
  };
}
