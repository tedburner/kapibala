import type { ExternalSessionService } from '@kiturone/kapibala-host/internal';
import type { ViewExternalSession, ViewExternalSnapshot } from '@kiturone/kapibala-host/view-model';
import { resolveCommandOutput } from '../command-output.js';
import type { CommandHandler } from './dispatcher.js';

const STATUS_LABELS: Record<ViewExternalSession['status'], string> = {
  starting: '启动中',
  idle: '空闲',
  running: '运行中',
  waiting_approval: '待审批',
  cancelling: '正在取消',
  ended: '已结束',
  failed: '失败',
};

const TRANSPORT_LABELS: Record<ViewExternalSession['transport'], string> = {
  acp: '原生 ACP',
  'claude-cli': 'Claude CLI 直连',
  'codex-app-server': 'Codex 直连',
};

const EXTERNAL_USAGE =
  '/external [list | harnesses | harness test [id] | harness add <id> <cmd> [args...] | harness enable|disable|remove|reset <id> | start <harnessId> <任务> | show <sessionId> | prompt <sessionId> <文本> | approve <sessionId> <选项序号或ID> | cancel|close|delete <sessionId>]';

/**
 * 纯词法引号分词器（零 shell 求值，不展开任何环境变量或反引号）：
 * 支持用户在 Windows 下为含空格路径加双引号或单引号（如 `"C:\Program Files\nodejs\node.exe"`）。
 */
export function tokenizeExternalCliArgs(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

/** 校验 `/external` 原始尾部参数合法性（`rawTail: true` 模式下 `args` 为至多 1 项整串）。 */
export function validateExternalCommandArgs(args: string[]): string | undefined {
  const raw = (args[0] ?? '').trim();
  if (!raw) return undefined;

  const tokens = tokenizeExternalCliArgs(raw);
  const sub = tokens[0]?.toLowerCase();
  switch (sub) {
    case 'list':
    case 'harnesses':
      return tokens.length === 1 ? undefined : `用法: /external ${sub}`;
    case 'harness': {
      const action = tokens[1]?.toLowerCase();
      if (action === 'test') {
        return tokens.length <= 3 ? undefined : '用法: /external harness test [id]';
      }
      if (
        action === 'enable' ||
        action === 'disable' ||
        action === 'remove' ||
        action === 'reset'
      ) {
        return tokens.length === 3 ? undefined : `用法: /external harness ${action} <id>`;
      }
      if (action === 'add') {
        return tokens.length >= 4
          ? undefined
          : '用法: /external harness add <id> <command> [args...]';
      }
      return '用法: /external harness <test|add|enable|disable|remove|reset> ...';
    }
    case 'start':
      return tokens.length >= 3 ? undefined : '用法: /external start <harnessId> <任务文本>';
    case 'prompt':
      return tokens.length >= 3 ? undefined : '用法: /external prompt <sessionId> <文本>';
    case 'show':
    case 'cancel':
    case 'close':
    case 'delete':
      return tokens.length === 2 ? undefined : `用法: /external ${sub} <sessionId>`;
    case 'approve':
      return tokens.length === 3 ? undefined : '用法: /external approve <sessionId> <选项序号或ID>';
    default:
      return `未知子命令 '${tokens[0]}'`;
  }
}

function formatSnapshotSummary(snap: ViewExternalSnapshot): string[] {
  const lines: string[] = [];
  const s = snap.session;
  const metaParts = [
    `[${s.id}]`,
    `${s.harnessName} (${TRANSPORT_LABELS[s.transport]})`,
    STATUS_LABELS[s.status],
    s.modelLabel ? `模型:${s.modelLabel}` : '',
    s.canContinue ? '可续聊' : '只读归档',
  ].filter(Boolean);
  lines.push(`${metaParts.join(' · ')} — ${s.title}`);

  if (snap.plan && snap.plan.items.length > 0) {
    lines.push('任务计划:');
    for (const item of snap.plan.items) {
      lines.push(`  [${item.status}] ${item.title}`);
    }
  }

  for (const msg of snap.messages) {
    const roleLabel = msg.role === 'user' ? '用户' : '外部代理';
    for (const block of msg.blocks) {
      if (block.kind === 'thinking') {
        lines.push(`  (${roleLabel}思考) ${block.text}`);
      } else if (block.kind === 'tool' && block.tool) {
        const resSuffix = block.tool.result ? ` -> ${block.tool.result}` : '';
        lines.push(`  [工具:${block.tool.status}] ${block.tool.invocation}${resSuffix}`);
      } else if (block.text) {
        lines.push(`${roleLabel}: ${block.text}`);
      }
    }
  }

  if (snap.approvals.length > 0) {
    lines.push('待处理人工审批:');
    for (const apr of snap.approvals) {
      lines.push(
        `  审批 [${apr.approvalId}] ${apr.toolTitle}${apr.target ? ` (${apr.target})` : ''}`,
      );
      apr.options.forEach((opt, idx) => {
        lines.push(`    ${idx + 1}. ${opt.label} (${opt.optionId} / ${opt.kind})`);
      });
      lines.push(`  使用 /external approve ${s.id} <序号或选项ID> 回复`);
    }
  }

  for (const notice of snap.notices) {
    lines.push(`[${notice.level}] ${notice.text}`);
  }
  return lines;
}

function splitFirstNTokens(raw: string, count: number): { head: string[]; tail: string } {
  const head: string[] = [];
  let rest = raw.trim();
  for (let i = 0; i < count; i++) {
    const match = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    if (!match) break;
    head.push(match[1]!);
    rest = match[2] ?? '';
  }
  return { head, tail: rest.trim() };
}

/**
 * `/external` 命令处理器：提供与桌面端设置页和会话视图 100% 同源的外部代理管理与任务交互。
 */
export const externalCommand: CommandHandler = async (args, ctx) => {
  const output = resolveCommandOutput(ctx);
  const service: ExternalSessionService | undefined = ctx.external;
  if (!service) {
    output.log('当前宿主未启用外部代理会话服务。');
    return;
  }

  const raw = (args[0] ?? '').trim();
  const workspaceRoot = ctx.projectRoot;

  if (!raw || raw.toLowerCase() === 'list') {
    if (!workspaceRoot) {
      output.log('当前会话缺少明确的工作区根目录，无法列出项目外部会话。');
      return;
    }
    const items = service.listSessions(workspaceRoot);
    if (items.length === 0) {
      output.log('当前工作区暂无外部代理会话。可用 /external start <harnessId> <任务> 启动。');
      return;
    }
    output.log(`外部代理会话列表（共 ${items.length} 个）:`);
    for (const item of items) {
      const aprBadge =
        item.pendingApprovalCount > 0 ? ` · 待审批 ${item.pendingApprovalCount}` : '';
      const modeBadge = item.canContinue ? '可恢复' : '只读归档';
      output.log(
        `• [${item.id}] [${item.harnessName}] ${item.title} · ${STATUS_LABELS[item.status]}${aprBadge} · ${modeBadge}`,
      );
    }
    return;
  }

  const tokens = tokenizeExternalCliArgs(raw);
  const sub = tokens[0]!.toLowerCase();

  if (sub === 'harnesses') {
    const { harnesses, templates } = service.listHarnesses();
    output.log('已配置的外部代理:');
    for (const h of harnesses) {
      const state = h.enabled ? '已启用' : '已停用';
      const kind = h.builtin ? (h.hasOverride ? '内置·已覆盖' : '内置') : '自定义';
      const cmdLine = [h.command, ...h.args].join(' ');
      output.log(
        `• ${h.id} (${h.name}) [${TRANSPORT_LABELS[h.transport]} · ${kind} · ${state}] -> ${cmdLine}`,
      );
    }
    output.log(
      `可用官方 ACP 模板: ${templates.map((t) => `${t.registryId}(${t.command})`).join(', ')}`,
    );
    return;
  }

  if (sub === 'harness') {
    const action = tokens[1]!.toLowerCase();
    if (action === 'test') {
      const targetId = tokens[2];
      const targets = targetId
        ? [targetId]
        : service
            .listHarnesses()
            .harnesses.filter((h) => h.enabled)
            .map((h) => h.id);
      for (const id of targets) {
        const probe = await service.testHarness(id, workspaceRoot);
        const ver = probe.version ? ` v${probe.version}` : '';
        const detail = probe.reason ? ` — ${probe.reason}` : '';
        const hint = probe.loginHint
          ? ` (登录: ${probe.loginHint})`
          : probe.installHint
            ? ` (安装: ${probe.installHint})`
            : '';
        output.log(`• ${id}: ${probe.status}${ver}${detail}${hint}`);
      }
      return;
    }

    if (action === 'enable' || action === 'disable') {
      const id = tokens[2]!;
      const enable = action === 'enable';
      service.toggleHarness(id, enable);
      output.log(`已${enable ? '启用' : '停用'}外部代理: ${id}`);
      return;
    }

    if (action === 'reset') {
      const id = tokens[2]!;
      service.resetBuiltinOverride(id);
      output.log(`已恢复内置外部代理默认配置: ${id}`);
      return;
    }

    if (action === 'remove') {
      const id = tokens[2]!;
      service.deleteCustomHarness(id);
      output.log(`已删除自定义外部代理: ${id}`);
      return;
    }

    if (action === 'add') {
      const id = tokens[2]!;
      const command = tokens[3]!;
      const cmdArgs = tokens.slice(4);
      service.saveCustomHarness({
        id,
        name: id,
        command,
        args: cmdArgs,
        enabled: true,
      });
      output.log(`已保存自定义外部代理: ${id}`);
      return;
    }
  }

  if (sub === 'start') {
    if (!workspaceRoot) {
      output.error('缺少工作区根目录，无法启动外部代理会话。');
      return;
    }
    const { head, tail } = splitFirstNTokens(raw, 2);
    const harnessId = head[1]!;
    const snap = await service.startSession({
      workspaceRoot,
      harnessId,
      prompt: tail,
    });
    for (const line of formatSnapshotSummary(snap)) output.log(line);
    return;
  }

  if (sub === 'prompt') {
    const { head, tail } = splitFirstNTokens(raw, 2);
    const sessionId = head[1]!;
    const snap = await service.promptSession({
      sessionId,
      text: tail,
    });
    for (const line of formatSnapshotSummary(snap)) output.log(line);
    return;
  }

  if (sub === 'show') {
    const snap = service.getSnapshot(tokens[1]!);
    for (const line of formatSnapshotSummary(snap)) output.log(line);
    return;
  }

  if (sub === 'approve') {
    const sessionId = tokens[1]!;
    const choiceToken = tokens[2]!;
    const snap = service.getSnapshot(sessionId);
    const pending = snap.approvals[0];
    if (!pending) {
      output.error('当前外部会话没有挂起的审批请求。');
      return;
    }
    if (choiceToken.toLowerCase() === 'cancel') {
      await service.approveSession({
        sessionId: snap.session.id,
        approvalId: pending.approvalId,
        cancel: true,
      });
      output.log(`已取消外部审批: ${pending.approvalId}`);
      return;
    }
    const numericIndex = /^[1-9]\d*$/.test(choiceToken) ? Number(choiceToken) - 1 : -1;
    const optionId =
      numericIndex >= 0 && numericIndex < pending.options.length
        ? pending.options[numericIndex]!.optionId
        : choiceToken;
    await service.approveSession({
      sessionId: snap.session.id,
      approvalId: pending.approvalId,
      optionId,
    });
    output.log(`已提交外部审批选择: ${optionId}`);
    return;
  }

  if (sub === 'cancel') {
    await service.cancelSession(tokens[1]!);
    output.log(`已请求取消外部会话当前轮次: ${tokens[1]}`);
    return;
  }

  if (sub === 'close') {
    await service.closeSession(tokens[1]!);
    output.log(`已关闭外部会话进程（历史只读归档已保留）: ${tokens[1]}`);
    return;
  }

  if (sub === 'delete') {
    await service.deleteSession(tokens[1]!);
    output.log(`已删除外部会话及其归档: ${tokens[1]}`);
    return;
  }

  output.log(`用法: ${EXTERNAL_USAGE}`);
};
