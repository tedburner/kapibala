/**
 * @fileoverview `/todos`：当前会话的任务清单与完成进度。
 *
 * 约束、边界与为什么：
 * 1. 只读：清单由模型经 `todo_write` 声明，宿主从 canonical 历史「最近一次成功调用」重算；
 *    本命令不写控制记录、不改历史，与桌面 pill / 浮层同一口径。
 * 2. 失败、中断或从未调用时没有清单，明确提示而不是伪造空进度。
 * 3. TTY 与非 TTY 共用一套纯文本输出，经 resolveCommandOutput 统一落屏。
 */

import { buildTodoState } from '@kiturone/kapibala-host/internal';
import type { ViewTodoStatus } from '@kiturone/kapibala-host/view-model';
import { resolveCommandOutput } from '../command-output.js';
import { redactCommonSecrets } from '../local-host/redaction.js';
import type { CommandHandler } from './dispatcher.js';

/** 四态标记；纯 ASCII 括号，保证非 TTY 与等宽终端都可读。 */
const STATUS_MARK: Record<ViewTodoStatus, string> = {
  completed: '[x]',
  in_progress: '[>]',
  pending: '[ ]',
  cancelled: '[-]',
};

/** `/todos`：输出进度头行与逐项状态；不接收子命令参数。 */
export const todosCommand: CommandHandler = async (_args, ctx) => {
  const out = resolveCommandOutput(ctx);
  // REPL 进程内没有宿主凭证闭包，标题按公共模式脱敏兜底（与批准描述同口径）。
  const state = buildTodoState(ctx.session.getHistory(), redactCommonSecrets);
  if (!state || state.items.length === 0) {
    out.log('当前会话没有任务清单。');
    return;
  }
  const completed = state.items.filter((item) => item.status === 'completed').length;
  out.log(`任务 ${completed}/${state.items.length}`);
  for (const item of state.items) out.log(`${STATUS_MARK[item.status]} ${item.title}`);
};
