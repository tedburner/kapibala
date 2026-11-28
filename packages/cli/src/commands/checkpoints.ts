/**
 * @fileoverview `/checkpoints` 命令：列举、对比与定向回滚当前会话的 Shadow Git 工作区检查点。
 *
 * 设计约束与安全边界：
 * 1. 只读操作（`list` / `diff`）随时可执行；变更操作（`restore`）由 `COMMAND_CATALOG.mutates` 在运行期自动拦截；
 * 2. 回滚严格委托 `CheckpointService.restore` 按轮次归因路径还原，绝不执行全目录 `git reset --hard` 或删除会话外未跟踪文件；
 * 3. 支持 `targetOrdinal = -1` 还原至本会话第 0 轮开始前的基线状态；检测到用户事后手动修改冲突时默认拒绝并提示 `--force`。
 */

import {
  isProjectTrusted,
  loadSettings,
  redactCommonSecrets,
} from '@kiturone/kapibala-host/internal';
import { resolveCommandOutput } from '../command-output.js';
import type { CommandContext, CommandHandler } from './dispatcher.js';

const CHECKPOINTS_USAGE = '/checkpoints [list | diff [ordinal] | restore <ordinal> [--force]]';

/**
 * 校验 `/checkpoints` 命令参数合法性。
 *
 * 前置约束：`args` 已由分发器按空白分词；`restore` 允许 `-1`（首轮前基线）或非负整数轮次序号。
 */
export function validateCheckpointsCommandArgs(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  const sub = args[0]?.toLowerCase();
  if (sub === 'list') {
    return args.length === 1 ? undefined : `用法: ${CHECKPOINTS_USAGE}`;
  }
  if (sub === 'diff') {
    if (args.length === 1) return undefined;
    if (args.length === 2 && /^(0|[1-9]\d*)$/.test(args[1]!)) {
      const val = Number(args[1]);
      return Number.isSafeInteger(val) ? undefined : '轮次序号超出安全整数范围';
    }
    return `用法: ${CHECKPOINTS_USAGE}`;
  }
  if (sub === 'restore') {
    const rest = args.slice(1);
    const nonFlags = rest.filter((token) => token !== '--force');
    const flagCount = rest.length - nonFlags.length;
    if (nonFlags.length !== 1 || flagCount > 1) {
      return `用法: ${CHECKPOINTS_USAGE}`;
    }
    if (!/^(-1|0|[1-9]\d*)$/.test(nonFlags[0]!)) {
      return '目标轮次序号必须为 -1 或非负整数';
    }
    const val = Number(nonFlags[0]);
    return Number.isSafeInteger(val) ? undefined : '轮次序号超出安全整数范围';
  }
  return `用法: ${CHECKPOINTS_USAGE}`;
}

function resolveSessionRoots(ctx: CommandContext): {
  readonly projectRoot: string;
  readonly executionRoot: string;
} {
  const executionRoot = ctx.executionRoot ?? ctx.session.workspaceRoot;
  const projectRoot =
    ctx.projectRoot ?? ctx.controller?.manager.project.projectRoot ?? executionRoot;
  return { projectRoot, executionRoot };
}

function ensureTrustedForRestore(ctx: CommandContext, projectRoot: string): boolean {
  const globalSettings = loadSettings({
    cwd: projectRoot,
    homeDir: ctx.homeDir,
    includeProject: false,
  }).settings;
  return (
    isProjectTrusted(ctx.settings, projectRoot) || isProjectTrusted(globalSettings, projectRoot)
  );
}

/**
 * `/checkpoints` 命令处理器：CLI REPL 与桌面斜杠命令面共享同一检查点查询与回滚逻辑。
 */
export const checkpointsCommand: CommandHandler = async (args, ctx) => {
  const output = resolveCommandOutput(ctx);
  const service = ctx.checkpoints;
  if (!service) {
    output.log('当前宿主未启用工作区检查点服务。');
    return;
  }

  const { projectRoot, executionRoot } = resolveSessionRoots(ctx);
  const sessionId = ctx.session.conversationId;
  const sub = (args[0] ?? 'list').toLowerCase();

  if (sub === 'list') {
    const availability = await service.checkAvailability({ projectRoot, executionRoot });
    if (!availability.available) {
      const reasonText =
        availability.reason === 'unsafe_root'
          ? '当前目录属于系统保护根路径，已禁用自动检查点'
          : '未检测到可用 Git，无法读取工作区检查点';
      output.log(reasonText);
      return;
    }
    const items = await service.listCheckpoints({ projectRoot, executionRoot, sessionId });
    if (items.length === 0) {
      output.log('当前会话暂无检查点记录（发送对话产生轮次后将自动记录快照）。');
      return;
    }
    output.log(`当前会话检查点列表（共 ${items.length} 个轮次快照）:`);
    for (const item of items) {
      const timeText = new Date(item.createdAt).toISOString();
      const labelSuffix = item.label ? ` · ${item.label}` : '';
      output.log(
        `• #${item.ordinal} | +${item.additions} -${item.deletions} (${item.changedFiles.length} 个文件) | ${timeText}${labelSuffix}`,
      );
    }
    output.log(
      '提示: 使用 /checkpoints diff [ordinal] 查看详情，或 /checkpoints restore <ordinal> 回滚文件（传 -1 还原到首轮前）。',
    );
    return;
  }

  if (sub === 'diff') {
    const ordinal = args[1] !== undefined ? Number(args[1]) : undefined;
    const diff = await service.diff({
      projectRoot,
      executionRoot,
      sessionId,
      ...(ordinal !== undefined ? { ordinal } : {}),
    });
    if (!diff.available) {
      output.log('当前工作区检查点不可用。');
      return;
    }
    if (diff.files.length === 0) {
      output.log(
        ordinal !== undefined
          ? `轮次 #${ordinal} 未记录到文件变更。`
          : '当前会话尚未记录到文件变更。',
      );
      return;
    }
    const scopeLabel = ordinal !== undefined ? `轮次 #${ordinal}` : '当前会话累计';
    output.log(
      `${scopeLabel}变更明细（共 ${diff.files.length} 个文件，+${diff.additions} -${diff.deletions}${diff.truncated ? '，部分大补丁已截断' : ''}）:`,
    );
    for (const file of diff.files) {
      const statBadge = file.binary ? 'binary' : `+${file.additions} -${file.deletions}`;
      output.log(`• [${file.status}] ${redactCommonSecrets(file.path)} (${statBadge})`);
      if (file.patch) {
        output.log(redactCommonSecrets(file.patch).trimEnd());
      }
    }
    return;
  }

  if (sub === 'restore') {
    if (!ensureTrustedForRestore(ctx, projectRoot)) {
      output.error(`当前工作区 (${projectRoot}) 尚未被信任，拒绝执行文件回滚。`);
      return;
    }
    const force = args.includes('--force');
    const ordinalToken = args.slice(1).find((token) => token !== '--force')!;
    const targetOrdinal = Number(ordinalToken);
    const outcome = await service.restore({
      projectRoot,
      executionRoot,
      sessionId,
      targetOrdinal,
      force,
    });

    if (outcome.status === 'conflict') {
      output.error(
        `检测到 ${outcome.conflicts.length} 个文件在检查点之后被手动修改，已中止回滚以保护本地改动:`,
      );
      for (const file of outcome.conflicts) {
        output.error(`  - ${file}`);
      }
      output.error(
        `若确认覆盖这些手动改动，请使用 /checkpoints restore ${targetOrdinal} --force（回滚前仍会自动保存 pre-restore 备份快照）。`,
      );
      return;
    }

    if (outcome.status === 'noop') {
      output.log('当前磁盘文件已处于目标检查点水位，无需还原。');
      return;
    }

    await ctx.onCheckpointRestored?.();
    const targetDesc = targetOrdinal < 0 ? '会话开始前基线 (#-1)' : `轮次 #${targetOrdinal} 结束态`;
    output.log(
      `已将归因文件还原至${targetDesc}（恢复 ${outcome.restoredFiles.length} 个文件，清理新增 ${outcome.deletedFiles.length} 个文件）。`,
    );
  }
};
