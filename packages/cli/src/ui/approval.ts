import type readline from 'node:readline';
import type { ApprovalChannel, ApprovalChoice, ApprovalRequest } from '@kiturone/kapibala';

/** 将控制字符和双向文本控制符显示为转义文本，保留完整审批内容且禁止终端重绘。 */
function escapeApprovalText(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0)!;
      const control =
        code < 0x20 ||
        (code >= 0x7f && code <= 0x9f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069);
      if (!control) return character;
      if (character === '\n') return '\\n';
      if (character === '\r') return '\\r';
      if (character === '\t') return '\\t';
      return `\\u${code.toString(16).padStart(4, '0')}`;
    })
    .join('');
}

/** 将会话审批委托给当前 CLI 输入协调器。 */
export class CliApprovalChannel implements ApprovalChannel {
  private handler?: (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalChoice>;

  bind(handler: (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalChoice>): void {
    this.handler = handler;
  }

  async requestApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalChoice> {
    return this.handler?.(request, signal) ?? 'deny_once';
  }
}

/** 复用 REPL 的 readline，审批输入不会被下一轮聊天消费。 */
export async function askWithReadline(
  rl: readline.Interface,
  request: ApprovalRequest,
  signal?: AbortSignal,
  interactive = Boolean(process.stdin.isTTY),
): Promise<ApprovalChoice> {
  if (!interactive) return 'deny_once';
  if (signal?.aborted) return 'cancel';
  const target = request.shell
    ? `\n解释器: ${escapeApprovalText(request.shell.executablePath ?? request.shell.interpreter)}\n工作目录: ${escapeApprovalText(request.shell.cwd)}\n完整命令: ${escapeApprovalText(request.shell.command)}`
    : `\n工具: ${escapeApprovalText(request.toolName)}\n参数: ${escapeApprovalText(JSON.stringify(request.input))}`;
  const choices = request.sessionAllowed
    ? '[1] 仅本次允许  [2] 本会话允许  [3] 拒绝  [4] 本会话拒绝'
    : '[1] 仅本次允许  [3] 拒绝  [4] 本会话拒绝';
  const answer = await new Promise<string>((resolve) => {
    const onAbort = () => finish('cancel');
    const finish = (value: string) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    rl.question(`\n工具审批 ${target}\n${choices}\n选择: `, { signal }, finish);
  });
  if (signal?.aborted || answer === 'cancel') return 'cancel';
  if (answer.trim() === '1') return 'allow_once';
  if (answer.trim() === '2' && request.sessionAllowed) return 'allow_session';
  if (answer.trim() === '4') return 'deny_session';
  return 'deny_once';
}

export async function confirmWithReadline(
  rl: readline.Interface,
  prompt: string,
): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const answer = await new Promise<string>((resolve) =>
    rl.question(`${prompt} 输入 yes 确认: `, resolve),
  );
  return answer.trim().toLowerCase() === 'yes';
}
