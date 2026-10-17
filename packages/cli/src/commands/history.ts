import { CrossProjectSessionCatalog, sanitizeSessionTitle } from '@kiturone/kapibala';
import { resolveCommandOutput } from '../host/command-output.js';
import type { CommandContext, CommandHandler } from './dispatcher.js';

function controller(ctx: CommandContext) {
  if (!ctx.controller) throw new Error('当前宿主未提供受管历史会话');
  return ctx.controller;
}

/**
 * 分页或高级检索列出会话历史。
 * 支持：
 * - `/history [page]`：按当前项目分页查看历史；
 * - `/history --all [page]`：跨项目列出所有全局会话历史；
 * - `/history --search <query>` 或 `/history -s <query>`：有界全文检索会话内容并展示匹配片段与可续答边界；
 * - `/history --tree`：展示当前会话的分支因果拓扑；
 * - `/history --agents`：展示当前会话相关的子代理历史任务。
 */
export const historyCommand: CommandHandler = async (args, ctx) => {
  const active = controller(ctx);

  // 1. 因果树视图: /history --tree
  if (args.includes('--tree')) {
    const store = active.handle.store;
    if (typeof store.getBranches !== 'function') {
      resolveCommandOutput(ctx).log('当前会话存储格式不支持因果分支树查看。');
      return;
    }
    const branches = await store.getBranches();
    const activeBranchId = store.getActiveBranchId?.() ?? 'main';
    resolveCommandOutput(ctx).log(`会话因果分支拓扑树 [${active.session.conversationId}]:`);
    for (const b of branches) {
      const isCurrent = b.branchId === activeBranchId;
      const marker = isCurrent ? '*' : ' ';
      resolveCommandOutput(ctx).log(`${marker} 分支 [${b.branchId}] | 消息数: ${b.messageCount}`);
      resolveCommandOutput(ctx).log(
        `    └─ 叶子: ${b.leafRecordId} | 创建时间: ${new Date(b.createdAt).toISOString()}`,
      );
    }
    return;
  }

  // 2. 子代理历史任务: /history --agents
  if (args.includes('--agents')) {
    const runtime = ctx.runtime;
    if (!runtime) {
      resolveCommandOutput(ctx).log('当前运行时未启用子代理后台调度器。');
      return;
    }
    const tasks = runtime.listTasks();
    resolveCommandOutput(ctx).log(`当前会话关联的子代理历史任务（共 ${tasks.length} 项）:`);
    for (const t of tasks) {
      resolveCommandOutput(ctx).log(
        `• [${t.agentId}] (${t.role}) 状态: ${t.status} | 深度: ${t.origin.depth} | 描述: ${sanitizeSessionTitle(t.description, 60)}`,
      );
    }
    if (tasks.length === 0) {
      resolveCommandOutput(ctx).log('暂无子代理历史任务。');
    }
    return;
  }

  // 3. 全文检索: /history --search <query> 或 /history -s <query>
  const searchIndex = args.findIndex((arg) => arg === '--search' || arg === '-s');
  if (searchIndex !== -1) {
    const queryParts = args.slice(searchIndex + 1).filter((arg) => arg !== '--all');
    const query = queryParts.join(' ').trim();
    if (!query) {
      resolveCommandOutput(ctx).log('用法: /history --search <关键词>');
      return;
    }
    const isAll = args.includes('--all');
    const catalog = new CrossProjectSessionCatalog({
      onDiagnostic: (msg) => resolveCommandOutput(ctx).error(`[kapibala catalog] ${msg}`),
    });

    const projectFilter = isAll ? undefined : active.manager.project.projectRoot;
    const response = await catalog.search(query, {
      project: projectFilter,
    });

    const scopeDesc = isAll ? '全局跨项目' : `当前项目 (${active.manager.project.projectRoot})`;
    resolveCommandOutput(ctx).log(
      `全文检索 "${query}" [${scopeDesc}] 命中 ${response.hits.length} 项（扫描 ${response.totalSessionsScanned} 个会话，${response.totalRecordsScanned} 条记录）:`,
    );
    for (const hit of response.hits) {
      const resumeBadge = hit.canResume ? '✓ 可续答' : '✗ 只读边界';
      const timeStr = new Date(hit.timestamp).toISOString();
      resolveCommandOutput(ctx).log(
        `\n• 会话: ${hit.conversationId} | 分支: ${hit.branchId} | 角色: ${hit.role} | ${timeStr} [${resumeBadge}]`,
      );
      resolveCommandOutput(ctx).log(`  匹配内容: ${sanitizeSessionTitle(hit.snippet, 120)}`);
    }
    if (response.hits.length === 0) {
      resolveCommandOutput(ctx).log('未找到包含该关键词的会话内容。');
    }
    if (response.isPartial) {
      resolveCommandOutput(ctx).log(
        `\n[提示: 检索受保护机制截断: ${response.partialReasons?.join('; ')}]`,
      );
    }
    return;
  }

  // 4. 全局跨项目列表: /history --all [page]
  if (args.includes('--all')) {
    const pageArg = args.find((arg) => arg !== '--all');
    const pageNum = pageArg ? Number(pageArg) : 1;
    const catalog = new CrossProjectSessionCatalog();
    const allEntries = await catalog.scanSessions();
    allEntries.sort((a, b) => b.lastActivityAt - a.lastActivityAt);

    const pageSize = 20;
    const total = allEntries.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(Math.max(1, pageNum), totalPages);
    const startIdx = (currentPage - 1) * pageSize;
    const pagedEntries = allEntries.slice(startIdx, startIdx + pageSize);

    resolveCommandOutput(ctx).log(
      `全局跨项目历史会话 ${currentPage}/${totalPages}（共 ${total} 项，每页 20 项）:`,
    );
    for (const item of pagedEntries) {
      const isCurrent = item.conversationId === active.session.conversationId;
      const marker = isCurrent ? '*' : ' ';
      const proj = sanitizeSessionTitle(item.projectRoot, 35);
      resolveCommandOutput(ctx).log(
        `${marker} ${item.conversationId} | ${proj} | ${new Date(item.lastActivityAt).toISOString()} | ${item.messageCount} 条 | ${sanitizeSessionTitle(item.title)}`,
      );
    }
    if (pagedEntries.length === 0) {
      resolveCommandOutput(ctx).log('本页没有历史会话。');
    }
    return;
  }

  // 5. 默认按当前项目分页查看历史
  const page = await active.manager.list(args[0] ? Number(args[0]) : 1);
  resolveCommandOutput(ctx).log(
    `历史会话 ${page.page}/${page.pages}（${page.total} 项，每页 20 项）`,
  );
  for (const item of page.items)
    resolveCommandOutput(ctx).log(
      `${item.conversationId === active.session.conversationId ? '*' : ' '} ${item.conversationId} | ${new Date(item.lastActivityAt).toISOString()} | ${item.messageCount} 条 | ${sanitizeSessionTitle(item.title)}`,
    );
  if (!page.items.length) resolveCommandOutput(ctx).log('本页没有历史会话。');
};

/** 新建会话保留旧文件；/clear 在受管 CLI 使用同一实现，SDK reset 独立保留清空语义。 */
export const newCommand: CommandHandler = async (_args, ctx) => {
  await controller(ctx).newSession();
  resolveCommandOutput(ctx).log(`已新建会话: ${ctx.session.conversationId}`);
};

/** 标题完整尾部交由 Core 转义与有界保存，不把命令文本送入模型。 */
export const renameCommand: CommandHandler = async (args, ctx) => {
  const active = controller(ctx);
  await active.manager.rename(active.session.conversationId, args[0]);
  resolveCommandOutput(ctx).log(`会话标题已更新: ${sanitizeSessionTitle(args[0])}`);
};

/** 指定 ID 恢复或共享输入选择；非 TTY 只展示列表与用法，不等待菜单。 */
export const resumeCommand: CommandHandler = async (args, ctx) => {
  const active = controller(ctx);
  let id = args[0];
  if (!id) {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !ctx.select) {
      await historyCommand([], ctx);
      resolveCommandOutput(ctx).log('使用 /resume <id> 续答，支持唯一 ID 前缀。');
      return;
    }
    let pageNumber = 1;
    while (!id) {
      const page = await active.manager.list(pageNumber);
      const options = page.items.map((item) => ({
        label: sanitizeSessionTitle(item.title, 80),
        value: item.conversationId,
        description: `${item.conversationId} | ${item.messageCount} 条 | ${new Date(item.lastActivityAt).toISOString()}`,
        badge: item.conversationId === active.session.conversationId ? '当前' : undefined,
      }));
      if (pageNumber > 1)
        options.push({ label: '上一页', value: '__previous', description: '', badge: undefined });
      if (pageNumber < page.pages)
        options.push({ label: '下一页', value: '__next', description: '', badge: undefined });
      const choice = await ctx.select({
        message: `恢复历史会话 ${pageNumber}/${page.pages}`,
        options,
      });
      if (!choice) return;
      if (choice === '__previous') pageNumber--;
      else if (choice === '__next') pageNumber++;
      else id = choice;
    }
  }
  await active.resume(id);
  const drift = active.handle.branchDrift;
  if (drift)
    resolveCommandOutput(ctx).log(
      `环境分支提示: 创建于 ${sanitizeSessionTitle(drift.createdBranch ?? '非分支状态')}，当前 ${sanitizeSessionTitle(drift.currentBranch ?? '非分支状态')}；工作目录保持本次启动目录。`,
    );
  const preview = ctx.session
    .getHistory()
    .filter((m) => m.role === 'user')
    .at(-1)
    ?.content.filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ');
  resolveCommandOutput(ctx).log(
    `已恢复会话: ${ctx.session.conversationId}（${ctx.session.getHistory().length} 条消息）`,
  );
  if (preview) resolveCommandOutput(ctx).log(`最近输入: ${sanitizeSessionTitle(preview, 120)}`);
};
