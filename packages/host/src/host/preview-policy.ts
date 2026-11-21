import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ViewArtifact } from '../view-model/index.js';

/**
 * 可预览位图扩展名（小写、不含点）。
 *
 * 刻意排除 SVG：现有图片预览白名单虽含 svg，但 v1 只投影模型生成的位图；
 * 若在此放行会出现「白名单有、面板却有/没有」的口径分裂（设计 012 §6.2）。
 */
export const RASTER_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
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
  /** 用户主目录；`~/.kapibala` 整根排除（含 settings.json 等凭据）。 */
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
  if (!RASTER_IMAGE_EXTENSIONS.has(ext)) return { ok: false, code: 'not_image' };

  const candidate = path.isAbsolute(raw)
    ? path.normalize(raw)
    : path.resolve(options.workspaceRoot, raw);
  const target = canonicalize(candidate);
  const allowedRoots = [
    canonicalize(options.workspaceRoot),
    canonicalize(options.tempRoot ?? os.tmpdir()),
  ];
  const excluded = canonicalize(path.join(options.homeDirectory, '.kapibala'));
  // 排除整根 `.kapibala`：它会存放凭据与会话状态，即使工作区恰好包含主目录也不能预览。
  if (within(excluded, target)) return { ok: false, code: 'path_not_allowed' };
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
