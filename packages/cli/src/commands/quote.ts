import {
  CrossProjectSessionCatalog,
  DEFAULT_REFERENCE_RECORD_LIMIT,
  type SearchHit,
  SessionReferenceReader,
  isSamePath,
  sanitizeSessionTitle,
} from '@kiturone/kapibala';
import { resolveCommandOutput } from '../command-output.js';
import { describeReferences } from '../quote-draft.js';
import type { CommandHandler } from './dispatcher.js';

/** 菜单里最多列出多少个源会话；超出部分不隐藏，只是不做分页。 */
const CANDIDATE_LIMIT = 20;

/**
 * 解析 `/quote` 的单个身份参数：`<sessionId>` 或 `<sessionId>#<recordId>`。
 *
 * 返回 null 表示语法不合法（缺 ID、空记录 ID 或出现多余分隔符）。
 */
function parseQuoteTarget(raw: string): { sessionId: string; recordId?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('#');
  if (parts.length > 2) return null;
  const [sessionId, recordId] = parts;
  if (!sessionId.trim()) return null;
  if (parts.length === 2 && !recordId.trim()) return null;
  return { sessionId: sessionId.trim(), ...(recordId ? { recordId: recordId.trim() } : {}) };
}

/** 交互式终端才提供菜单；其它环境只打印结果与用法，不等待输入。 */
function canSelect(ctx: Parameters<CommandHandler>[1]): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && ctx.select);
}

/**
 * `/quote`：把同项目桶内其它会话的历史作为待发送引用挂进草稿。
 *
 * 边界：
 * - 只接受身份参数；正文由宿主在运行锁内读取，命令层不拼接、不上传正文；
 * - 挂载时做一次只读试读，找不到、跨桶或已归档会直接拒绝，不把必然失败留到发送；
 * - 非 TTY 不交互：只列出候选、命中或当前草稿，并打印用法；
 * - 选中后不立即发送，下一条用户输入发送时注入并清空草稿。
 */
export const quoteCommand: CommandHandler = async (args, ctx) => {
  const out = resolveCommandOutput(ctx);
  const draft = ctx.references;
  if (!draft) {
    out.log('当前宿主不支持跨会话引用。');
    return;
  }
  const projectRoot = ctx.session.workspaceRoot;
  const homeDirectory = ctx.homeDir;
  const host = { projectRoot, ...(homeDirectory ? { homeDirectory } : {}) };

  // --list [--remove <序号>]：查看或删除本轮已挂载的引用。
  if (args[0] === '--list') {
    if (args[1] === '--remove') {
      const index = Number(args[2]);
      if (!draft.remove(index)) {
        out.log(`没有第 ${args[2]} 条引用。`);
        return;
      }
      out.log(`已移除第 ${args[2]} 条引用，剩余 ${draft.size} 条。`);
    }
    if (!draft.size) {
      out.log('本轮还没有挂载引用。使用 /quote 选择会话，或 /quote <id> 直接引用。');
      return;
    }
    for (const [index, entry] of draft.list().entries())
      out.log(
        `${index + 1}. ${entry.sessionId}${entry.recordIds?.length ? `#${entry.recordIds.join(',')}` : ''}`,
      );
    out.log(await describeReferences(draft.list(), host));
    return;
  }

  let selection: { sessionId: string; recordIds?: readonly string[]; limit?: number } | undefined;

  // --search <query>：复用跨项目检索，只保留当前项目桶的命中。
  if (args[0] === '--search') {
    const query = args.slice(1).join(' ').trim();
    const catalog = new CrossProjectSessionCatalog({
      ...(homeDirectory ? { homeDirectory } : {}),
    });
    const response = await catalog.search(query, { limit: 30 });
    const hits = response.hits.filter((hit) => isSamePath(hit.projectRoot, projectRoot));
    if (!hits.length) {
      out.log(`没有在当前项目内命中“${query}”。`);
      return;
    }
    if (!canSelect(ctx)) {
      for (const hit of hits.slice(0, CANDIDATE_LIMIT))
        out.log(
          `${hit.conversationId}#${hit.recordId} | ${hit.role} | ${sanitizeSessionTitle(hit.snippet, 80)}`,
        );
      out.log('使用 /quote <sessionId>#<recordId> 引用命中消息。');
      return;
    }
    const choice = await ctx.select!(hitOptions(hits));
    if (!choice) return;
    selection = { sessionId: choice.conversationId, recordIds: [choice.recordId] };
  } else if (args[0]) {
    const target = parseQuoteTarget(args[0]);
    if (!target) {
      out.log('用法: /quote [<sessionId>[#<recordId>]] | /quote --search <query> | /quote --list');
      return;
    }
    selection = target.recordId
      ? { sessionId: target.sessionId, recordIds: [target.recordId] }
      : { sessionId: target.sessionId, limit: DEFAULT_REFERENCE_RECORD_LIMIT };
  } else {
    // 无参：打开当前项目桶的会话菜单。
    const reader = new SessionReferenceReader({ ...(homeDirectory ? { homeDirectory } : {}) });
    const candidates = await reader.listCandidates({ projectRoot, limit: CANDIDATE_LIMIT });
    if (!candidates.length) {
      out.log('当前项目还没有可引用的其它会话。');
      return;
    }
    if (!canSelect(ctx)) {
      for (const candidate of candidates)
        out.log(
          `${candidate.sessionId} | ${candidate.messageCount} 条 | ${sanitizeSessionTitle(candidate.title, 80)}`,
        );
      out.log('使用 /quote <sessionId> 引用该会话最近消息。');
      return;
    }
    const choice = await ctx.select!({
      message: '选择要引用的会话',
      options: candidates.map((candidate) => ({
        label: sanitizeSessionTitle(candidate.title, 80),
        value: candidate.sessionId,
        description: `${candidate.sessionId} | ${candidate.messageCount} 条 | ${new Date(candidate.lastActivityAt).toISOString()}`,
        badge:
          candidate.sessionId === ctx.session.conversationId
            ? '当前'
            : candidate.delegation
              ? '委派'
              : undefined,
      })),
    });
    if (!choice) return;
    selection = { sessionId: choice, limit: DEFAULT_REFERENCE_RECORD_LIMIT };
  }

  // 挂载前试读：读取失败与单轮合计预算在这里一次性暴露，用户不会在发送时才发现引用无效。
  // 只读一次：摘要直接复用这次试读的结果，避免每次挂载把桶内会话读两遍。
  const summary = await describeReferences([...draft.list(), selection], host);
  draft.add(selection);
  out.log(summary);
  out.log('已挂载，下一条输入发送时一并注入；/quote --list 可查看或删除。');
};

/** 检索命中转成选择菜单项；同一消息可能多处命中，按 recordId 去重。 */
function hitOptions(hits: readonly SearchHit[]) {
  const seen = new Set<string>();
  return {
    message: `引用检索命中（${hits.length}）`,
    options: hits
      .filter((hit) => {
        const key = `${hit.conversationId}#${hit.recordId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((hit) => ({
        label: sanitizeSessionTitle(hit.snippet, 60),
        value: hit,
        description: `${hit.conversationId}#${hit.recordId} | ${hit.role}`,
      })),
  };
}
