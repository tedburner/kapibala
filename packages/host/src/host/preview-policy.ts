import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ViewArtifact } from '../view-model/index.js';

/**
 * 可预览图片扩展名（小写、不含点）。
 *
 * 与桌面端 `IMAGE_MIME_BY_EXTENSION` 保持同一口径：位图与 SVG 都投影，避免出现
 * 「预览白名单有、右侧面板却没有」的分裂。SVG 经 `<img>` 的 data URL 渲染，
 * 脚本不执行、外链不加载，SMIL/CSS 动画可正常播放。
 */
export const PREVIEWABLE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
]);

/**
 * 产物被拒绝的原因。
 *
 * `path_not_allowed` 与 `file_not_found` 必须分开：前者说明路径越出固定允许根
 * （安全边界问题），后者说明路径合法但文件不存在（时序/误写问题），两者合并
 * 会让排障时无法区分「被安全策略拦下」和「文件确实没写出来」。
 */
export type ArtifactRejection = 'path_not_allowed' | 'file_not_found' | 'not_image' | 'not_file';

/** 一次产物解析的结果；成功时给出已按允许根校验过的只读产物投影。 */
export type ArtifactResolution =
  | { readonly ok: true; readonly artifact: ViewArtifact }
  | { readonly ok: false; readonly code: ArtifactRejection };

/** 产物校验依赖的路径事实；全部为宿主可直接取得的绝对路径。 */
export interface ArtifactPolicyOptions {
  /** 会话工作区根；相对产物路径以它为基准解析。 */
  readonly workspaceRoot: string;
  /** 用户主目录；除会话自身显式挂载于受管默认工作区或受管工作树根内之外，`~/.kapibala` 其余凭据与状态目录一律排除。 */
  readonly homeDirectory: string;
  /** OS 临时目录；仅测试可覆盖，生产缺省 `os.tmpdir()`。 */
  readonly tempRoot?: string;
}

/**
 * 工具产物投影策略。
 *
 * 只回答「这次调用有没有可预览产物」，不执行工具、不读文件内容；
 * 失败/中断终态、非 `write_file` 调用一律返回 undefined（设计 012 §2 / §6.1）。
 */
export type ArtifactPolicy = (
  toolName: string,
  input: Record<string, unknown>,
  succeeded: boolean,
) => readonly ViewArtifact[] | undefined;

/** realpath 归一；文件尚不存在时归一到最近已存在祖先再拼回剩余段，保证边界比较用物理路径。 */
function canonicalize(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(canonicalize(parent), path.basename(target));
  }
}

/** 目标是否位于根本身或根之内；`path.relative` 在 Windows 已按大小写不敏感比较。 */
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 解析一次 `write_file` 的目标路径并按固定允许根校验。
 *
 * 顺序固定为「先判边界，再判存在」：先越界检查可以避免用存在性探测工作区之外的
 * 路径；只有落在允许根内才做 `stat`，因此越界路径永远返回 `path_not_allowed`，
 * 不会因为文件恰好不存在而退化成 `file_not_found`。只读投影，不读取文件内容。
 */
export function resolveWriteArtifact(
  options: ArtifactPolicyOptions,
  input: Record<string, unknown>,
): ArtifactResolution {
  const raw = input.path;
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, code: 'file_not_found' };
  const ext = path.extname(raw).slice(1).toLowerCase();
  if (!PREVIEWABLE_IMAGE_EXTENSIONS.has(ext)) return { ok: false, code: 'not_image' };

  const candidate = path.isAbsolute(raw)
    ? path.normalize(raw)
    : path.resolve(options.workspaceRoot, raw);
  const target = canonicalize(candidate);
  const canonicalWorkspace = canonicalize(options.workspaceRoot);
  const allowedRoots = [canonicalWorkspace, canonicalize(options.tempRoot ?? os.tmpdir())];

  // 工作区内部的 `.kapibala`（项目级 `mcp.json`、发件箱等）始终禁止作为图片产物预览。
  const workspaceDotKapibala = canonicalize(path.join(canonicalWorkspace, '.kapibala'));
  if (within(workspaceDotKapibala, target)) return { ok: false, code: 'path_not_allowed' };

  const kapibalaHomeRoot = canonicalize(path.join(options.homeDirectory, '.kapibala'));
  if (within(kapibalaHomeRoot, target)) {
    // 仅当会话 workspaceRoot 自身规范化后位于受管默认工作区或受管工作树根之内时，放行该工作区内部产物，
    // 其余 `~/.kapibala/**`（settings.json、sessions、mcp.json 及其他工作树）一律拒绝。
    const managedWorkspaceRoots = [
      canonicalize(path.join(options.homeDirectory, '.kapibala', 'workspaces', 'default')),
      canonicalize(path.join(options.homeDirectory, '.kapibala', 'worktrees')),
    ];
    const matchedManagedSubroot = managedWorkspaceRoots.find((subroot) =>
      within(subroot, canonicalWorkspace),
    );
    if (
      !matchedManagedSubroot ||
      !within(matchedManagedSubroot, target) ||
      !within(canonicalWorkspace, target)
    ) {
      return { ok: false, code: 'path_not_allowed' };
    }
  }
  if (!allowedRoots.some((root) => within(root, target)))
    return { ok: false, code: 'path_not_allowed' };

  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return { ok: false, code: 'file_not_found' };
  }
  if (!stat.isFile()) return { ok: false, code: 'not_file' };
  return { ok: true, artifact: { kind: 'image', path: target, ext, size: stat.size } };
}

/**
 * 构造与宿主会话绑定的产物策略。
 *
 * 成功终态才投影；`edit_file` / `run_command` / MCP 等调用即使目标扩展名是图片
 * 也不会匹配（无法可靠归因，与看板「不计命令行间接改动」同口径）。
 * 返回的产物带上 `size`，渲染层据此决定是否只展示文件名与过大提示。
 */
export function createArtifactPolicy(options: ArtifactPolicyOptions): ArtifactPolicy {
  return (toolName, input, succeeded) => {
    if (!succeeded || toolName !== 'write_file') return undefined;
    const resolved = resolveWriteArtifact(options, input);
    return resolved.ok ? [resolved.artifact] : undefined;
  };
}
