import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CliInputCoordinator } from '../input-coordinator.js';
import type { JsonValue, SessionControl, WireEvent } from '../protocol/index.js';
import { escapeApprovalText } from '../ui/approval.js';
import { sanitizeUntrustedOutput } from '../ui/text-safety.js';
import { type DaemonOptions, connectDaemon } from './daemon.js';
import { ConnectedPresentation } from './presentation.js';

/** 连接模式只接受受支持的会话/运行参数，不读取或写入新的模型配置。 */
export interface ConnectOptions extends DaemonOptions {
  workspace?: string;
  resume?: string;
  prompt?: string;
}

function object(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid host response');
  return value;
}

/** 有限文本连接宿主；使用一个输入协调器，审批与聊天不争抢 stdin。 */
export async function runConnectedClient(options: ConnectOptions): Promise<void> {
  const root = fs.realpathSync.native(path.resolve(options.workspace ?? process.cwd()));
  const input = new CliInputCoordinator();
  let runId: string | undefined;
  let control: SessionControl | undefined;
  let presentation: ConnectedPresentation | undefined;
  let wantCancel = false;
  let eof = false;
  let failed = false;
  const outcomes = new Map<string, string>();
  let settle: (() => void) | undefined;
  const client = await connectDaemon(options, {
    approval: async (request, signal) => {
      if (!input.interactive) return 'cancel';
      try {
        const answer = await input.question(
          `\n审批 ${escapeApprovalText(request.toolName)}\n${escapeApprovalText(request.target)}\n1 本次允许${request.sessionAllowed ? ' / 2 本会话允许' : ''} / 3 拒绝 / 4 本会话拒绝: `,
          { signal },
        );
        if (answer.trim() === '1') return 'allow_once';
        if (answer.trim() === '2' && request.sessionAllowed) return 'allow_session';
        if (answer.trim() === '4') return 'deny_session';
        return 'deny_once';
      } catch {
        cancel();
        return 'cancel';
      }
    },
  });
  const cancel = () => {
    wantCancel = true;
    if (runId && control) void client.call('run/cancel', { ...control, runId }).catch(() => {});
  };
  const interrupt = input.onInterrupt(() => {
    if (runId) cancel();
    else input.close();
  });
  void input.whenClosed.then(() => {
    eof = true;
    cancel();
  });
  // attach 响应返回前先缓存事件；展示状态建立并恢复历史后再按序应用，避免正文抢在历史前打印。
  const pendingEvents: WireEvent[] = [];
  const consume = (event: WireEvent) => {
    if (!presentation) {
      pendingEvents.push(event);
      return;
    }
    presentation.consume(event);
    if (event.type === 'text_delta')
      process.stdout.write(sanitizeUntrustedOutput(event.payload.text));
    if (event.type === 'run_settled' && event.runId) {
      outcomes.set(event.runId, event.payload.outcome);
      settle?.();
    }
  };
  const unsubscribe = client.subscribe(consume);
  try {
    const opened = object(
      await client.call(
        options.resume ? 'session/open' : 'session/create',
        options.resume
          ? { workspaceRoot: root, conversationId: options.resume }
          : { workspaceRoot: root },
      ),
    );
    if (typeof opened.sessionId !== 'string') throw new Error('Invalid session response');
    const attached = object(
      await client.call('session/attach', { sessionId: opened.sessionId, mode: 'control' }),
    );
    if (typeof attached.streamEpoch !== 'string' || typeof attached.controlEpoch !== 'string')
      throw new Error('Invalid control response');
    control = {
      sessionId: opened.sessionId,
      streamEpoch: attached.streamEpoch,
      controlEpoch: attached.controlEpoch,
    };
    if (typeof attached.serverInstanceId !== 'string') throw new Error('Invalid host identity');
    presentation = new ConnectedPresentation(
      control.sessionId,
      attached.serverInstanceId,
      control.streamEpoch,
    );
    if (Array.isArray(attached.history)) presentation.restore(attached.history);
    // 与建立展示状态同一同步段内排空，期间不会有新事件插入历史恢复之前。
    for (const event of pendingEvents.splice(0)) consume(event);
    const execute = async (text: string) => {
      const result = object(
        await client.call('run/start', {
          ...control!,
          clientOperationId: randomUUID(),
          input: text,
        }),
      );
      if (typeof result.runId !== 'string') throw new Error('Invalid run response');
      runId = result.runId;
      if (wantCancel) cancel();
      await Promise.race([
        new Promise<void>((resolve) => {
          if (outcomes.has(runId!)) resolve();
          else settle = resolve;
        }),
        client.whenClosed.then(() => {
          throw new Error('Local host connection closed');
        }),
      ]);
      const canonical = object(
        await client.call('session/snapshot', { sessionId: control!.sessionId }),
      );
      if (Array.isArray(canonical.history)) presentation?.restore(canonical.history);
      process.stdout.write('\n');
      const outcome = outcomes.get(runId);
      outcomes.delete(runId);
      settle = undefined;
      runId = undefined;
      wantCancel = false;
      if (outcome === 'failed') process.exitCode = 1;
    };
    if (options.prompt !== undefined) {
      await execute(options.prompt);
      return;
    }
    if (!input.interactive) throw new Error('非 TTY 连接模式需要 --prompt；审批默认拒绝。');
    process.stdout.write(
      '已连接本地宿主。支持 /status、/history、/close、/exit；Ctrl+C 取消运行。\n',
    );
    while (!eof) {
      let text: string;
      try {
        text = (await input.question('kpbl> ')).trim();
      } catch {
        break;
      }
      if (!text) continue;
      if (text === '/exit') break;
      if (text === '/close') {
        await client.call('session/close', control);
        process.stdout.write('已关闭当前会话，配额已释放。\n');
        break;
      }
      if (text === '/status') {
        const status = object(
          await client.call('session/snapshot', { sessionId: control.sessionId }),
        );
        const running = typeof status.runId === 'string' ? status.runId : '空闲';
        process.stdout.write(
          `会话: ${control.sessionId}\n运行: ${running}\n已打开会话: ${String(status.openSessions)}/${String(status.maxOpenSessions)}\n`,
        );
        continue;
      }
      if (text === '/history') {
        process.stdout.write(
          `${JSON.stringify(await client.call('session/list', { workspaceRoot: root }))}\n`,
        );
        continue;
      }
      if (text.startsWith('/')) {
        process.stdout.write('连接模式暂不支持此命令，请使用直接 CLI。\n');
        continue;
      }
      await execute(text);
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    interrupt();
    unsubscribe();
    input.close();
    // 一次性运行退出即回收句柄；交互模式保留会话供重连，由 /close 显式释放。
    if (options.prompt !== undefined && control) {
      try {
        await client.call('session/close', control);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`关闭会话失败：${sanitizeUntrustedOutput(message)}\n`);
        if (!failed) process.exitCode = 1;
      }
    }
    await client.close();
  }
}
