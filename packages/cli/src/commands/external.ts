import {
  type ExternalSessionService,
  isProjectTrusted,
  loadSettings,
  trustProject,
} from '@kiturone/kapibala-host/internal';
import type {
  ViewExternalApproval,
  ViewExternalSession,
  ViewExternalSnapshot,
} from '@kiturone/kapibala-host/view-model';
import { type CommandOutput, resolveCommandOutput } from '../command-output.js';
import type { CommandContext, CommandHandler } from './dispatcher.js';

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
  'pi-rpc': 'Pi 直连',
};

const EXTERNAL_USAGE =
  '/external [list | harnesses | harness test [id] | harness add <id> <cmd> [args...] | harness enable|disable|remove|reset <id> | start <harnessId> <任务> | show <sessionId> | prompt <sessionId> <文本> | approve <sessionId> [approvalId] <选项序号|ID|cancel> | cancel|close|delete <sessionId>]';

function scanQuotedTokens(raw: string): { tokens: string[]; unclosedQuote: boolean } {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let sawQuoteInToken = false;

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
      sawQuoteInToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0 || sawQuoteInToken) {
        tokens.push(current);
        current = '';
        sawQuoteInToken = false;
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0 || sawQuoteInToken) {
    tokens.push(current);
  }
  return { tokens, unclosedQuote: quote !== null };
}

/**
 * 纯词法引号分词器（零 shell 求值，不展开任何环境变量或反引号）：
 * 支持用户在 Windows 下为含空格路径加双引号或单引号（如 `"C:\Program Files\nodejs\node.exe"`）。
 */
export function tokenizeExternalCliArgs(raw: string): string[] {
  return scanQuotedTokens(raw).tokens;
}

/** 校验 `/external` 原始尾部参数合法性（`rawTail: true` 模式下 `args` 为至多 1 项整串）。 */
export function validateExternalCommandArgs(args: string[]): string | undefined {
  const raw = (args[0] ?? '').trim();
  if (!raw) return undefined;

  const { tokens, unclosedQuote } = scanQuotedTokens(raw);
  if (unclosedQuote) {
    return '参数引号未闭合';
  }
  const sub = tokens[0]?.toLowerCase();
  if (!sub) return undefined;

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
        return tokens.length === 3 && tokens[2]?.trim()
          ? undefined
          : `用法: /external harness ${action} <id>`;
      }
      if (action === 'add') {
        return tokens.length >= 4 && tokens[2]?.trim() && tokens[3]?.trim()
          ? undefined
          : '用法: /external harness add <id> <command> [args...]';
      }
      return '用法: /external harness <test|add|enable|disable|remove|reset> ...';
    }
    case 'start':
      return tokens.length >= 3 && tokens[1]?.trim()
        ? undefined
        : '用法: /external start <harnessId> <任务文本>';
    case 'prompt':
      return tokens.length >= 3 && tokens[1]?.trim()
        ? undefined
        : '用法: /external prompt <sessionId> <文本>';
    case 'show':
    case 'cancel':
    case 'close':
    case 'delete':
      return tokens.length === 2 && tokens[1]?.trim()
        ? undefined
        : `用法: /external ${sub} <sessionId>`;
    case 'approve':
      return (tokens.length === 3 || tokens.length === 4) && tokens[1]?.trim()
        ? undefined
        : '用法: /external approve <sessionId> [approvalId] <选项序号|ID|cancel>';
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
      lines.push(`  使用 /external approve ${s.id} ${apr.approvalId} <序号或选项ID> 回复`);
    }
  }

  for (const notice of snap.notices) {
    lines.push(`[${notice.level}] ${notice.text}`);
  }
  return lines;
}

/** 按引号感知剥离前 `count` 个词法参数，并保留后续任务正文原样尾部。 */
function splitFirstNTokens(raw: string, count: number): { head: string[]; tail: string } {
  const head: string[] = [];
  let i = 0;
  const n = raw.length;

  while (i < n && head.length < count) {
    while (i < n && /\s/.test(raw[i]!)) i++;
    if (i >= n) break;

    let token = '';
    let quote: '"' | "'" | null = null;
    while (i < n) {
      const ch = raw[i]!;
      if (quote) {
        if (ch === quote) {
          quote = null;
        } else {
          token += ch;
        }
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        i++;
        continue;
      }
      if (/\s/.test(ch)) break;
      token += ch;
      i++;
    }
    head.push(token);
  }

  return { head, tail: raw.slice(i).trim() };
}

/**
 * 普通仓库（未建 `.kapibala` 目录）启动 CLI 时不会在入口弹信任确认；
 * 当用户首次调用需要受信任工作区的 `/external` 子命令时，按需引导交互信任并持久化到全局 `trustedProjects`。
 */
async function ensureCliWorkspaceTrusted(
  workspaceRoot: string,
  ctx: CommandContext,
  output: CommandOutput,
): Promise<boolean> {
  const latestGlobal = loadSettings({
    cwd: workspaceRoot,
    homeDir: ctx.homeDir,
    includeProject: false,
  }).settings;
  if (
    isProjectTrusted(ctx.settings, workspaceRoot) ||
    isProjectTrusted(latestGlobal, workspaceRoot)
  ) {
    return true;
  }

  if (ctx.confirm) {
    const confirmed = await ctx.confirm(
      `当前工作区 (${workspaceRoot}) 尚未被信任。是否信任该目录以允许运行外部代理？`,
    );
    if (!confirmed) {
      output.log('已取消：当前工作区未授权信任，未执行外部代理操作。');
      return false;
    }
    trustProject(ctx.settings, workspaceRoot, { homeDir: ctx.homeDir });
    output.log(`已信任工作区: ${workspaceRoot}`);
    return true;
  }

  if (ctx.select) {
    const picked = await ctx.select({
      message: `信任当前工作区 (${workspaceRoot}) 以允许运行外部代理？`,
      options: [
        { label: '信任并继续', description: '将当前目录物理路径登记到已信任项目列表', value: true },
        { label: '取消', description: '不授权运行外部代理', value: false },
      ],
    });
    if (picked !== true) {
      output.log('已取消：当前工作区未授权信任，未执行外部代理操作。');
      return false;
    }
    trustProject(ctx.settings, workspaceRoot, { homeDir: ctx.homeDir });
    output.log(`已信任工作区: ${workspaceRoot}`);
    return true;
  }

  return true;
}

/**
 * 在 CLI 等待外部轮次结算期间订阅实时审批事件：
 * - 若终端支持 `ctx.select` / `ctx.confirm`，立即弹出内联人工审批选择并回传给宿主；
 * - 非交互模式下实时打印挂起审批详情与命令回复指引，避免静默卡等 120s。
 */
async function runPromptWithLiveCliApprovals(params: {
  readonly service: ExternalSessionService;
  readonly sessionId: string;
  readonly text: string;
  readonly workspaceRoot?: string;
  readonly ctx: CommandContext;
  readonly output: CommandOutput;
}): Promise<ViewExternalSnapshot> {
  const { service, sessionId, text, workspaceRoot, ctx, output } = params;
  const seenApprovals = new Set<string>();
  let approvalChain = Promise.resolve();

  const handleApproval = async (apr: ViewExternalApproval): Promise<void> => {
    const targetSuffix = apr.target ? ` (${apr.target})` : '';
    output.log(`待审批 [${apr.approvalId}] ${apr.toolTitle}${targetSuffix}`);
    if (apr.warning) {
      output.log(`  风险提示: ${apr.warning}`);
    }

    if (ctx.select) {
      const selected = await ctx.select<string>({
        message: `外部代理请求执行: ${apr.toolTitle}${targetSuffix}`,
        options: [
          ...apr.options.map((opt) => ({
            label: opt.label,
            description: `${opt.optionId} (${opt.kind})`,
            value: opt.optionId,
          })),
          {
            label: '取消本次审批',
            description: '中止或拒绝本次调用',
            value: '__cancel__',
          },
        ],
      });
      if (!selected || selected === '__cancel__') {
        await service.approveSession({
          sessionId,
          approvalId: apr.approvalId,
          cancel: true,
          ...(workspaceRoot ? { expectedWorkspaceRoot: workspaceRoot } : {}),
        });
      } else {
        await service.approveSession({
          sessionId,
          approvalId: apr.approvalId,
          optionId: selected,
          ...(workspaceRoot ? { expectedWorkspaceRoot: workspaceRoot } : {}),
        });
      }
      return;
    }

    if (ctx.confirm) {
      const allowOpt = apr.options.find((o) => o.kind.startsWith('allow')) ?? apr.options[0];
      const rejectOpt = apr.options.find((o) => o.kind.startsWith('reject'));
      const ok = await ctx.confirm(`是否允许外部代理执行「${apr.toolTitle}」${targetSuffix}？`);
      if (ok && allowOpt) {
        await service.approveSession({
          sessionId,
          approvalId: apr.approvalId,
          optionId: allowOpt.optionId,
          ...(workspaceRoot ? { expectedWorkspaceRoot: workspaceRoot } : {}),
        });
      } else if (rejectOpt) {
        await service.approveSession({
          sessionId,
          approvalId: apr.approvalId,
          optionId: rejectOpt.optionId,
          ...(workspaceRoot ? { expectedWorkspaceRoot: workspaceRoot } : {}),
        });
      } else {
        await service.approveSession({
          sessionId,
          approvalId: apr.approvalId,
          cancel: true,
          ...(workspaceRoot ? { expectedWorkspaceRoot: workspaceRoot } : {}),
        });
      }
      return;
    }

    apr.options.forEach((opt, idx) => {
      output.log(`    ${idx + 1}. ${opt.label} (${opt.optionId} / ${opt.kind})`);
    });
    output.log(`  使用 /external approve ${sessionId} ${apr.approvalId} <序号或选项ID> 回复`);
  };

  const unsubscribe = service.subscribeSession(sessionId, (snap) => {
    for (const apr of snap.approvals) {
      if (seenApprovals.has(apr.approvalId)) continue;
      seenApprovals.add(apr.approvalId);
      approvalChain = approvalChain
        .then(() => handleApproval(apr))
        .catch(() => {
          /* 审批单若已被并发取消或超时关闭则静默忽略 */
        });
    }
  });

  try {
    return await service.promptSession({
      sessionId,
      text,
      ...(workspaceRoot ? { expectedWorkspaceRoot: workspaceRoot } : {}),
    });
  } finally {
    unsubscribe();
    await approvalChain;
  }
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

  const validationError = validateExternalCommandArgs(args);
  if (validationError) {
    output.error(`${validationError}。用法: ${EXTERNAL_USAGE}`);
    return;
  }

  const raw = (args[0] ?? '').trim();
  const workspaceRoot = ctx.projectRoot;

  if (!raw || raw.toLowerCase() === 'list') {
    if (!workspaceRoot) {
      output.log('当前会话缺少明确的工作区根目录，无法列出项目外部会话。');
      return;
    }
    if (!(await ensureCliWorkspaceTrusted(workspaceRoot, ctx, output))) {
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
  const sub = tokens[0]?.toLowerCase() ?? '';

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
    const action = tokens[1]?.toLowerCase();
    if (action === 'test') {
      if (workspaceRoot && !(await ensureCliWorkspaceTrusted(workspaceRoot, ctx, output))) {
        return;
      }
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
      const id = tokens[2];
      if (!id) return;
      const enable = action === 'enable';
      service.toggleHarness(id, enable);
      output.log(`已${enable ? '启用' : '停用'}外部代理: ${id}`);
      return;
    }

    if (action === 'reset') {
      const id = tokens[2];
      if (!id) return;
      service.resetBuiltinOverride(id);
      output.log(`已恢复内置外部代理默认配置: ${id}`);
      return;
    }

    if (action === 'remove') {
      const id = tokens[2];
      if (!id) return;
      service.deleteCustomHarness(id);
      output.log(`已删除自定义外部代理: ${id}`);
      return;
    }

    if (action === 'add') {
      const id = tokens[2];
      const command = tokens[3];
      if (!id || !command) return;
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
    output.log(`用法: ${EXTERNAL_USAGE}`);
    return;
  }

  if (sub === 'start') {
    if (!workspaceRoot) {
      output.error('缺少工作区根目录，无法启动外部代理会话。');
      return;
    }
    if (!(await ensureCliWorkspaceTrusted(workspaceRoot, ctx, output))) {
      return;
    }
    const { head, tail } = splitFirstNTokens(raw, 2);
    const harnessId = head[1];
    if (!harnessId || !tail) {
      output.error('用法: /external start <harnessId> <任务文本>');
      return;
    }
    const opened = await service.openSession({
      workspaceRoot,
      harnessId,
      title: tail,
      customTitle: false,
      requireIdleWorkspace: true,
    });
    let snap: ViewExternalSnapshot;
    try {
      snap = await runPromptWithLiveCliApprovals({
        service,
        sessionId: opened.session.id,
        text: tail,
        workspaceRoot,
        ctx,
        output,
      });
    } catch (err) {
      const latest = service.getSnapshot(opened.session.id, workspaceRoot);
      if (latest.session.status === 'idle' && latest.messages.length === 0) {
        await service.closeSession(opened.session.id, workspaceRoot).catch(() => {});
      }
      throw err;
    }
    for (const line of formatSnapshotSummary(snap)) output.log(line);
    return;
  }

  if (sub === 'prompt') {
    if (workspaceRoot && !(await ensureCliWorkspaceTrusted(workspaceRoot, ctx, output))) {
      return;
    }
    const { head, tail } = splitFirstNTokens(raw, 2);
    const sessionId = head[1];
    if (!sessionId || !tail) {
      output.error('用法: /external prompt <sessionId> <文本>');
      return;
    }
    const resolvedId = service.resolveSessionId(sessionId, workspaceRoot);
    const snap = await runPromptWithLiveCliApprovals({
      service,
      sessionId: resolvedId,
      text: tail,
      workspaceRoot,
      ctx,
      output,
    });
    for (const line of formatSnapshotSummary(snap)) output.log(line);
    return;
  }

  if (sub === 'show') {
    if (workspaceRoot && !(await ensureCliWorkspaceTrusted(workspaceRoot, ctx, output))) {
      return;
    }
    const sessionId = tokens[1];
    if (!sessionId) return;
    const snap = service.getSnapshot(sessionId, workspaceRoot);
    for (const line of formatSnapshotSummary(snap)) output.log(line);
    return;
  }

  if (sub === 'approve') {
    if (workspaceRoot && !(await ensureCliWorkspaceTrusted(workspaceRoot, ctx, output))) {
      return;
    }
    const sessionId = tokens[1];
    if (!sessionId) return;
    const explicitApprovalId = tokens.length === 4 ? tokens[2] : undefined;
    const choiceToken = tokens.length === 4 ? tokens[3] : tokens[2];
    if (!choiceToken) return;

    const snap = service.getSnapshot(sessionId, workspaceRoot);
    const pending = explicitApprovalId
      ? snap.approvals.find((a) => a.approvalId === explicitApprovalId)
      : snap.approvals[0];
    if (!pending) {
      output.error(
        explicitApprovalId
          ? `未找到挂起的审批单 '${explicitApprovalId}'。`
          : '当前外部会话没有挂起的审批请求。',
      );
      return;
    }
    if (choiceToken.toLowerCase() === 'cancel') {
      await service.approveSession({
        sessionId: snap.session.id,
        approvalId: pending.approvalId,
        cancel: true,
        ...(workspaceRoot ? { expectedWorkspaceRoot: workspaceRoot } : {}),
      });
      output.log(`已取消外部审批: ${pending.approvalId}`);
      return;
    }

    let optionId = choiceToken;
    if (/^\d+$/.test(choiceToken)) {
      const numericIndex = Number(choiceToken) - 1;
      if (numericIndex < 0 || numericIndex >= pending.options.length) {
        output.error(
          `审批选项序号 '${choiceToken}' 超出范围（可选 1-${pending.options.length}）。`,
        );
        return;
      }
      optionId = pending.options[numericIndex]!.optionId;
    }

    await service.approveSession({
      sessionId: snap.session.id,
      approvalId: pending.approvalId,
      optionId,
      ...(workspaceRoot ? { expectedWorkspaceRoot: workspaceRoot } : {}),
    });
    output.log(`已提交外部审批选择: ${optionId}`);
    return;
  }

  if (sub === 'cancel') {
    if (workspaceRoot && !(await ensureCliWorkspaceTrusted(workspaceRoot, ctx, output))) {
      return;
    }
    const sessionId = tokens[1];
    if (!sessionId) return;
    await service.cancelSession(sessionId, workspaceRoot);
    output.log(`已请求取消外部会话当前轮次: ${sessionId}`);
    return;
  }

  if (sub === 'close') {
    if (workspaceRoot && !(await ensureCliWorkspaceTrusted(workspaceRoot, ctx, output))) {
      return;
    }
    const sessionId = tokens[1];
    if (!sessionId) return;
    await service.closeSession(sessionId, workspaceRoot);
    output.log(`已关闭外部会话进程（历史只读归档已保留）: ${sessionId}`);
    return;
  }

  if (sub === 'delete') {
    if (workspaceRoot && !(await ensureCliWorkspaceTrusted(workspaceRoot, ctx, output))) {
      return;
    }
    const sessionId = tokens[1];
    if (!sessionId) return;
    await service.deleteSession(sessionId, workspaceRoot);
    output.log(`已删除外部会话及其归档: ${sessionId}`);
    return;
  }

  output.log(`用法: ${EXTERNAL_USAGE}`);
};
