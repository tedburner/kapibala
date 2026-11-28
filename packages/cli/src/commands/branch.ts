import { resolveCommandOutput } from '../command-output.js';
/**
 * @fileoverview 分支创建、切换与查看命令（/branch）。
 *
 * 约束、边界与为什么：
 * 1. 事务闭合保护：
 *    历史若处于未闭合的工具事务（半事务），调用 createBranch 或 selectBranch
 *    将被 Core 拦截并抛出 UNCLOSED_TOOL_TRANSACTION_FORK，命令层友好提示用户，
 *    绝对拒绝半事务分叉破坏历史闭合不变量。
 * 2. 状态原子切换：
 *    分支切换持久化写入 branch_selected 事件确认后，才重载当前活动投影，
 *    失败时不移动游标、不损坏当前投影。
 */

import {
  KapibalaError,
  type SessionRecord,
  assertClosedToolTransaction,
  sanitizeSessionTitle,
} from '@kiturone/kapibala';
import { isProjectTrusted, loadSettings } from '@kiturone/kapibala-host/internal';
import type { CommandContext, CommandHandler } from './dispatcher.js';

const KNOWN_BRANCH_FLAGS = new Set(['--restore-files', '--force', '--summary', '--with-summary']);

const BRANCH_USAGE =
  '用法: /branch [recordId [name]] [--summary|--with-summary] [--restore-files [--force]] | /branch switch <branchId> [--restore-files [--force]]';

/**
 * 校验 `/branch` 命令参数：
 * 拦截未知 `--*` 标志（防止拼写错误被当成分支名）、支持 `--summary` 与 `--with-summary` 同义词，
 * 并允许在当前活动叶子省略 `recordId` 直接执行 `/branch --restore-files`。
 */
export function validateBranchCommandArgs(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  for (const arg of args) {
    if (arg.startsWith('--') && !KNOWN_BRANCH_FLAGS.has(arg)) {
      return `未知选项 '${arg}'`;
    }
  }
  const hasForce = args.includes('--force');
  const hasRestore = args.includes('--restore-files');
  if (hasForce && !hasRestore) {
    return '选项 --force 必须配合 --restore-files 使用';
  }
  const effective = args.filter((item) => item !== '--restore-files' && item !== '--force');
  if (effective.length === 0) {
    return hasRestore ? undefined : BRANCH_USAGE;
  }
  const hasSummary = effective.includes('--summary') || effective.includes('--with-summary');
  if (hasSummary) {
    const rest = effective.filter((item) => item !== '--summary' && item !== '--with-summary');
    if (rest[0] === 'switch') {
      return '用法: /branch switch <branchId> [--restore-files [--force]]';
    }
    if (rest[0] === 'create') {
      return rest.length >= 1 && rest.length <= 3 && (rest.length === 1 || rest[1]?.trim())
        ? undefined
        : '用法: /branch create [recordId [branchName]] [--summary|--with-summary] [--restore-files [--force]]';
    }
    return rest.length <= 2 ? undefined : BRANCH_USAGE;
  }
  if (effective[0] === 'switch') {
    return effective.length === 2 && effective[1]?.trim()
      ? undefined
      : '用法: /branch switch <branchId> [--restore-files [--force]]';
  }
  if (effective[0] === 'create') {
    if (effective.length === 1 && hasRestore) return undefined;
    return effective.length >= 2 && effective.length <= 3 && effective[1]?.trim()
      ? undefined
      : '用法: /branch create <recordId> [branchName] [--restore-files [--force]]';
  }
  if (effective.length <= 2) return undefined;
  return '用法: /branch [recordId [name]] | /branch switch <branchId>';
}

function getController(ctx: CommandContext) {
  if (!ctx.controller) throw new Error('当前宿主未提供受管历史会话');
  return ctx.controller;
}

function extractMessageRole(rec: { type: string; payload: Record<string, unknown> }):
  | string
  | undefined {
  if (rec.type !== 'message') return undefined;
  return typeof rec.payload.role === 'string'
    ? rec.payload.role
    : (rec.payload.message as { role?: string } | undefined)?.role;
}

async function resolveActiveLeafRecordId(store: {
  getBranches?: () => Promise<readonly { branchId: string; leafRecordId: string }[]>;
  getActiveBranchId?: () => string;
  readRecords?: () => Promise<readonly { recordId: string; type: string }[]>;
}): Promise<string | null> {
  if (typeof store.getBranches === 'function') {
    const branches = await store.getBranches();
    const activeBranchId = store.getActiveBranchId?.() ?? 'main';
    const activeMeta = branches.find((b) => b.branchId === activeBranchId) ?? branches[0];
    if (activeMeta?.leafRecordId) return activeMeta.leafRecordId;
  }
  if (typeof store.readRecords === 'function') {
    const records = await store.readRecords();
    for (let i = records.length - 1; i >= 0; i--) {
      const rec = records[i]!;
      if (rec.type === 'message' || rec.type === 'summary' || rec.type === 'branch_summary') {
        return rec.recordId;
      }
    }
  }
  return null;
}

/**
 * 统计指定记录在因果链上已完成的用户轮次水位，并对齐已落盘检查点序号：
 * - 若目标记录本身是 `user` 消息（其后的模型与工具轮次在该切点尚未执行），已完成轮次下标为 `userTurns - 2`；
 * - 若目标记录是 `assistant`/`tool`/摘要记录（该用户轮次已执行），已完成轮次下标为 `userTurns - 1`；
 * - 对齐实际存在的检查点列表（升序 `ordinal`）取 `<= completedTurnIndex` 的最大已记录 `ordinal`，无匹配时返回 `-1`（还原至首轮前基线）。
 */
export async function resolveTargetOrdinalAtRecord(
  store: {
    readRecords?: () => Promise<
      readonly {
        recordId: string;
        parentId: string | null;
        type: string;
        payload: Record<string, unknown>;
      }[]
    >;
  },
  leafOrBaseRecordId?: string | null,
  existingCheckpoints?: readonly { ordinal: number }[],
): Promise<number> {
  if (!leafOrBaseRecordId || typeof store.readRecords !== 'function') {
    return -1;
  }
  const records = await store.readRecords();
  const byId = new Map(records.map((rec) => [rec.recordId, rec]));
  const targetRecord = byId.get(leafOrBaseRecordId);
  if (!targetRecord) {
    return -1;
  }
  let cursor: string | null | undefined = leafOrBaseRecordId;
  let userTurns = 0;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const rec = byId.get(cursor);
    if (!rec) break;
    if (extractMessageRole(rec) === 'user') {
      userTurns += 1;
    }
    cursor = rec.parentId;
  }
  const targetIsUserMessage = extractMessageRole(targetRecord) === 'user';
  const completedTurnIndex = targetIsUserMessage ? userTurns - 2 : userTurns - 1;
  if (completedTurnIndex < 0) {
    return -1;
  }
  if (existingCheckpoints && existingCheckpoints.length > 0) {
    const matched = existingCheckpoints.filter((item) => item.ordinal <= completedTurnIndex);
    return matched.length > 0 ? matched[matched.length - 1]!.ordinal : -1;
  }
  return completedTurnIndex;
}

function ensureTrustedForBranchRestore(ctx: CommandContext, projectRoot: string): boolean {
  const globalSettings = loadSettings({
    cwd: projectRoot,
    homeDir: ctx.homeDir,
    includeProject: false,
  }).settings;
  return (
    isProjectTrusted(ctx.settings, projectRoot) || isProjectTrusted(globalSettings, projectRoot)
  );
}

interface PreparedBranchRestore {
  readonly execute: () => Promise<boolean>;
}

/**
 * 在任何磁盘回滚或分支写入前校验新建分支目标：
 * 拦截只读存储、重名分支、缺失的显式切点记录、全局控制记录切点与未闭合工具事务。
 */
async function validateBranchCreateTarget(
  store: {
    isReadOnly?: () => boolean;
    getBranches?: () => Promise<readonly { branchId: string; leafRecordId: string }[]>;
    readRecords?: () => Promise<readonly SessionRecord[]>;
  },
  targetBranchId: string,
  baseRecordId?: string | null,
): Promise<void> {
  if (store.isReadOnly?.()) {
    throw new KapibalaError('Cannot create branch on a read-only session store', {
      code: 'LEGACY_SESSION_READ_ONLY',
      safeMessage: '当前只读历史会话不支持创建分支',
    });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(targetBranchId)) {
    throw new Error(
      'Branch ID must be a non-empty string containing only alphanumeric, hyphen or underscore characters',
    );
  }
  if (typeof store.getBranches === 'function') {
    const branches = await store.getBranches();
    if (branches.some((b) => b.branchId === targetBranchId)) {
      throw new Error(`Branch already exists: ${targetBranchId}`);
    }
  }
  if (baseRecordId && typeof store.readRecords === 'function') {
    const records = await store.readRecords();
    if (!records.some((r) => r.recordId === baseRecordId)) {
      throw new Error(`Base record not found: ${baseRecordId}`);
    }
    assertClosedToolTransaction([...records], baseRecordId);
  }
}

function reportBranchRestoreConflicts(ctx: CommandContext, conflicts: readonly string[]): void {
  const out = resolveCommandOutput(ctx);
  out.error(
    `❌ 检测到 ${conflicts.length} 个文件在检查点后被手动修改，已中止分支切换/创建以防覆盖本地改动:`,
  );
  for (const file of conflicts) {
    out.error(`  - ${file}`);
  }
  out.error(
    '若确认覆盖这些手动修改，请附加 --force 重试（或去掉 --restore-files 仅切换对话分支）。',
  );
}

/**
 * 写盘前预检工作区信任与三路手动改动冲突，返回延迟执行的真实回滚闭包：
 * - 任一前置条件不满足或预检命中冲突时立即返回 `null`（零分支变更、零模型摘要调用、零磁盘改动）；
 * - 实际回滚仅在分支创建/切换/摘要全部完成后由调用方触发，确保分支失败绝不会提前改盘。
 */
async function prepareBranchFileRestore(
  ctx: CommandContext,
  store: Parameters<typeof resolveTargetOrdinalAtRecord>[0],
  leafOrBaseRecordId: string | null | undefined,
  force: boolean,
): Promise<PreparedBranchRestore | null> {
  if (!ctx.checkpoints) {
    resolveCommandOutput(ctx).log('当前宿主未启用工作区检查点服务，跳过文件还原。');
    return { execute: async () => true };
  }
  const executionRoot = ctx.executionRoot ?? ctx.session.workspaceRoot;
  const projectRoot =
    ctx.projectRoot ?? ctx.controller?.manager.project.projectRoot ?? executionRoot;
  if (!ensureTrustedForBranchRestore(ctx, projectRoot)) {
    resolveCommandOutput(ctx).error(`当前工作区 (${projectRoot}) 尚未被信任，拒绝执行文件回滚。`);
    return null;
  }
  const sessionId = ctx.session.conversationId;
  const existing = await ctx.checkpoints.listCheckpoints({ projectRoot, executionRoot, sessionId });
  if (existing.length === 0) {
    return { execute: async () => true };
  }
  const targetOrdinal = await resolveTargetOrdinalAtRecord(store, leafOrBaseRecordId, existing);
  if (!force) {
    const dryOutcome = await ctx.checkpoints.restore({
      projectRoot,
      executionRoot,
      sessionId,
      targetOrdinal,
      force: false,
      dryRun: true,
    });
    if (dryOutcome.status === 'conflict') {
      reportBranchRestoreConflicts(ctx, dryOutcome.conflicts);
      return null;
    }
  }
  return {
    execute: async () => {
      const outcome = await ctx.checkpoints!.restore({
        projectRoot,
        executionRoot,
        sessionId,
        targetOrdinal,
        force,
      });
      if (outcome.status === 'conflict') {
        reportBranchRestoreConflicts(ctx, outcome.conflicts);
        return false;
      }
      if (outcome.status === 'restored') {
        await ctx.onCheckpointRestored?.();
        resolveCommandOutput(ctx).log(
          `已联动还原工作区文件至检查点水位 #${targetOrdinal}（恢复 ${outcome.restoredFiles.length} 项，清理 ${outcome.deletedFiles.length} 项）。`,
        );
      }
      return true;
    },
  };
}

/** 回滚因并发文件冲突或还原异常中断的分支切换，恢复原活动分支与内存投影。 */
async function revertBranchSelection(
  store: { selectBranch?: (branchId: string) => Promise<unknown> },
  active: ReturnType<typeof getController>,
  previousBranchId: string | undefined,
): Promise<void> {
  if (!previousBranchId || typeof store.selectBranch !== 'function') return;
  try {
    await store.selectBranch(previousBranchId);
    await active.reloadCurrent();
  } catch {
    /* 尽力切回原分支，不掩盖原始冲突或错误。 */
  }
}

/**
 * 分支管理命令处理器。
 * 支持：
 * - `/branch`：查看所有分支与当前活动分支；
 * - `/branch switch <branchId> [--restore-files [--force]]`：切换至已有分支（可选联动回滚磁盘文件）；
 * - `/branch [create] [recordId [name]] [--summary|--with-summary] [--restore-files [--force]]`：在指定记录或当前活动叶子处创建并切换新分支。
 */
export const branchCommand: CommandHandler = async (args, ctx) => {
  const validationError = validateBranchCommandArgs(args);
  if (validationError) {
    resolveCommandOutput(ctx).error(validationError);
    return;
  }

  const active = getController(ctx);
  const store = active.handle.store;
  const restoreFiles = args.includes('--restore-files');
  const forceRestore = args.includes('--force');
  const effectiveArgs = args.filter((item) => item !== '--restore-files' && item !== '--force');

  // 1. 无参：列出当前会话的所有分支
  if (args.length === 0) {
    if (typeof store.getBranches !== 'function') {
      resolveCommandOutput(ctx).log('当前会话存储格式不支持持久分支操作。');
      return;
    }
    const branches = await store.getBranches();
    const activeBranchId = store.getActiveBranchId?.() ?? 'main';
    resolveCommandOutput(ctx).log(`会话分支列表（共 ${branches.length} 个分支）:`);
    for (const b of branches) {
      const isCurrent = b.branchId === activeBranchId;
      const marker = isCurrent ? '*' : ' ';
      const created = new Date(b.createdAt).toISOString();
      resolveCommandOutput(ctx).log(
        `${marker} ${b.branchId} | 消息数: ${b.messageCount} | 叶子记录: ${b.leafRecordId} | 创建时间: ${created}`,
      );
    }
    return;
  }

  // 2. 切换分支: /branch switch <branchId> [--restore-files [--force]]
  if (effectiveArgs[0] === 'switch') {
    const targetBranchId = effectiveArgs[1]?.trim();
    if (!targetBranchId) {
      resolveCommandOutput(ctx).log('用法: /branch switch <branchId> [--restore-files [--force]]');
      return;
    }
    try {
      if (typeof store.selectBranch !== 'function') {
        throw new Error('当前存储不支持分支切换');
      }
      const previousBranchId = store.getActiveBranchId?.();
      let preparedRestore: PreparedBranchRestore | null = null;
      if (restoreFiles && typeof store.getBranches === 'function') {
        const branches = await store.getBranches();
        const targetMeta = branches.find((b) => b.branchId === targetBranchId);
        if (!targetMeta) {
          throw new Error(`Branch not found: ${targetBranchId}`);
        }
        preparedRestore = await prepareBranchFileRestore(
          ctx,
          store,
          targetMeta.leafRecordId,
          forceRestore,
        );
        if (!preparedRestore) return;
      }
      await store.selectBranch(targetBranchId);
      if (preparedRestore) {
        let restoredOk = false;
        try {
          restoredOk = await preparedRestore.execute();
        } catch (restoreErr) {
          await revertBranchSelection(store, active, previousBranchId);
          throw restoreErr;
        }
        if (!restoredOk) {
          await revertBranchSelection(store, active, previousBranchId);
          return;
        }
      }
      // 切换成功后通过 reloadCurrent 重新加载内存因果投影
      await active.reloadCurrent();
      resolveCommandOutput(ctx).log(`已成功切换至分支: ${targetBranchId}`);
    } catch (error) {
      if (error instanceof KapibalaError && error.code === 'UNCLOSED_TOOL_TRANSACTION_FORK') {
        resolveCommandOutput(ctx).error(
          '❌ 当前历史存在未闭合的工具事务（半事务），禁止切换分支。请等待工具调用完成。',
        );
        return;
      }
      throw error;
    }
    return;
  }

  // 3. 创建附带背景摘要的新分支（同义支持 `--summary` / `--with-summary` 与 `--restore-files [--force]`）
  if (effectiveArgs.includes('--summary') || effectiveArgs.includes('--with-summary')) {
    const rest = effectiveArgs.filter((item) => item !== '--summary' && item !== '--with-summary');
    const explicitCreate = rest[0] === 'create';
    const positional = explicitCreate ? rest.slice(1) : rest;
    let baseRecordId: string | undefined;
    let branchName: string | undefined;

    if (explicitCreate) {
      baseRecordId = positional[0]?.trim();
      branchName = positional[1]?.trim();
    } else if (positional.length === 2) {
      baseRecordId = positional[0]?.trim();
      branchName = positional[1]?.trim();
    } else if (positional.length === 1) {
      const candidate = positional[0]!.trim();
      if (effectiveArgs[0] === '--summary' || effectiveArgs[0] === '--with-summary') {
        branchName = candidate;
      } else {
        const records =
          typeof store.readRecords === 'function' ? await store.readRecords() : undefined;
        if (records?.some((rec) => rec.recordId === candidate)) {
          baseRecordId = candidate;
        } else {
          branchName = candidate;
        }
      }
    }

    const targetBranchId =
      branchName && /^[a-zA-Z0-9_-]+$/.test(branchName)
        ? branchName
        : `branch-${Date.now().toString(36)}`;
    try {
      const previousBranchId = store.getActiveBranchId?.();
      const effectiveBaseRecordId = baseRecordId ?? (await resolveActiveLeafRecordId(store));
      await validateBranchCreateTarget(store, targetBranchId, effectiveBaseRecordId);
      let preparedRestore: PreparedBranchRestore | null = null;
      if (restoreFiles) {
        preparedRestore = await prepareBranchFileRestore(
          ctx,
          store,
          effectiveBaseRecordId,
          forceRestore,
        );
        if (!preparedRestore) return;
      }
      const created = await ctx.session.createBranchWithSummary(targetBranchId, {
        ...(baseRecordId ? { baseRecordId } : {}),
      });
      if (preparedRestore) {
        let restoredOk = false;
        try {
          restoredOk = await preparedRestore.execute();
        } catch (restoreErr) {
          await revertBranchSelection(store, active, previousBranchId);
          throw restoreErr;
        }
        if (!restoredOk) {
          await revertBranchSelection(store, active, previousBranchId);
          return;
        }
      }
      await active.reloadCurrent();
      const baseDesc = baseRecordId ? `在记录 ${baseRecordId} 处` : '从当前分支叶子';
      resolveCommandOutput(ctx).log(
        `已成功${baseDesc}创建附带背景摘要的新分支: ${created.branchId}`,
      );
    } catch (error) {
      if (error instanceof KapibalaError && error.code === 'UNCLOSED_TOOL_TRANSACTION_FORK') {
        resolveCommandOutput(ctx).error(
          '❌ 当前历史存在未闭合的工具事务（半事务），禁止创建分支。请等待工具调用完成。',
        );
        return;
      }
      throw error;
    }
    return;
  }

  // 4. 创建分支: /branch create <recordId> [name]、/branch <recordId> [name] 或活动叶子 /branch --restore-files
  const isExplicitCreate = effectiveArgs[0] === 'create';
  let recordId = (isExplicitCreate ? effectiveArgs[1] : effectiveArgs[0])?.trim();
  const branchName = (isExplicitCreate ? effectiveArgs[2] : effectiveArgs[1])?.trim();

  if (!recordId && restoreFiles) {
    const activeLeaf = await resolveActiveLeafRecordId(store);
    if (!activeLeaf) {
      const prepared = await prepareBranchFileRestore(ctx, store, activeLeaf, forceRestore);
      if (!prepared) return;
      await prepared.execute();
      resolveCommandOutput(ctx).log('当前会话尚无历史记录可分叉，已完成工作区检查点还原检查。');
      return;
    }
    recordId = activeLeaf;
  }

  if (!recordId) {
    resolveCommandOutput(ctx).log(BRANCH_USAGE);
    return;
  }

  try {
    if (typeof store.createBranch !== 'function') {
      throw new Error('当前存储不支持创建分支');
    }
    const previousBranchId = store.getActiveBranchId?.();
    const targetBranchId =
      branchName && /^[a-zA-Z0-9_-]+$/.test(branchName)
        ? branchName
        : `branch-${Date.now().toString(36)}`;
    // 写盘前先校验切点记录存在性、分支唯一性与工具事务闭合性，再执行只读冲突预检。
    await validateBranchCreateTarget(store, targetBranchId, recordId);
    let preparedRestore: PreparedBranchRestore | null = null;
    if (restoreFiles) {
      preparedRestore = await prepareBranchFileRestore(ctx, store, recordId, forceRestore);
      if (!preparedRestore) return;
    }
    await store.createBranch(targetBranchId, recordId);
    // 自动切换到新创建的分支
    if (typeof store.selectBranch === 'function') {
      await store.selectBranch(targetBranchId);
    }
    if (preparedRestore) {
      let restoredOk = false;
      try {
        restoredOk = await preparedRestore.execute();
      } catch (restoreErr) {
        await revertBranchSelection(store, active, previousBranchId);
        throw restoreErr;
      }
      if (!restoredOk) {
        await revertBranchSelection(store, active, previousBranchId);
        return;
      }
    }
    await active.reloadCurrent();
    const nameDesc = branchName ? ` (${sanitizeSessionTitle(branchName)})` : '';
    resolveCommandOutput(ctx).log(
      `已成功在记录 ${recordId} 处创建并切换至新分支: ${targetBranchId}${nameDesc}`,
    );
  } catch (error) {
    if (error instanceof KapibalaError && error.code === 'UNCLOSED_TOOL_TRANSACTION_FORK') {
      resolveCommandOutput(ctx).error(
        '❌ 当前历史存在未闭合的工具事务（半事务），禁止创建分支。请等待工具调用完成。',
      );
      return;
    }
    throw error;
  }
};
