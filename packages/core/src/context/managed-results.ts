import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 受管工具结果文件的存放约定：`<resultsRoot>/<projectKey>/<sessionId>/`。
 *
 * 设计约束（对齐 codex/opencode 的通用做法）：
 * - 结果文件属于 harness 运行时产物，绝不写入用户项目目录，保证项目对 git 干净；
 * - 按项目哈希 + 会话 ID 分桶，目录生命周期与会话绑定（删除会话即删除产物）；
 * - 仅 harness 自身写入（0o700 目录 / 0o600 文件），agent 只通过 read_file 的
 *   PathSandbox 只读豁免读取本会话桶，跨会话/跨项目结果互相不可见。
 */

/** 受管结果文件名模式；仅匹配本模块创建的 UUID 文件，清理时绝不碰其它内容。 */
const OWNED_RESULT = /^run-[a-f0-9-]{36}\.txt$/;

/** 清理清单文件名；记录已创建结果文件的 dev/ino，防止目录被调包后误删用户文件。 */
const RESULT_MANIFEST = 'managed-results.jsonl';

/** 会话 ID 的合法形态：仅允许字母数字与 `._-`，且不得为相对路径特例。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 计算会话专属的受管结果目录。
 *
 * @param resultsRoot 受管结果根目录（宿主传入 `~/.kapibala/tool-results`）；
 *   传入前不校验存在性，首次写入时按需创建。
 * @param projectKey 工作区身份哈希（与 SessionManager 存储分桶同源，必须由调用方
 *   使用 `computeProjectKey` 从规范化根计算，禁止直接传原始路径）。
 * @param sessionId 会话 ID（conversationId）；仅允许安全字符，防止路径注入。
 * @throws sessionId 为空或含路径分隔符时抛出，绝不拼接不可信输入。
 */
export function sessionToolResultsDirectory(options: {
  resultsRoot: string;
  projectKey: string;
  sessionId: string;
}): string {
  if (
    !SESSION_ID_PATTERN.test(options.sessionId) ||
    options.sessionId === '.' ||
    options.sessionId === '..'
  ) {
    throw new Error(`Invalid session id for managed results: '${options.sessionId}'`);
  }
  return path.join(options.resultsRoot, options.projectKey, options.sessionId);
}

/**
 * 无宿主装配时的兜底目录：进程级系统临时目录。
 *
 * 仅限裸 SDK 用法（未经 AgentSession 装配、无 resultsRoot 注入）的场景；
 * 跨进程不保证可读，生命周期交给操作系统清理。按 uid 隔离，避免多用户共享
 * 机器时目录权限互相冲突（Windows 无 uid，退化为固定名，文件仍 0o600）。
 */
export function fallbackToolResultsDirectory(): string {
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'anon';
  return path.join(os.tmpdir(), `kapibala-tool-results-${uid}`);
}

/**
 * 记录一个受管结果文件到清理清单。
 *
 * 必须在文件创建成功后立即调用；dev/ino 用于后续清理时确认目录身份，
 * 防止目录被外部替换后按文件名误删同路径的用户文件。
 */
export function recordManagedResult(directory: string, file: string, descriptor: number): void {
  const stat = fs.fstatSync(descriptor);
  fs.appendFileSync(
    path.join(directory, RESULT_MANIFEST),
    `${JSON.stringify({ name: path.basename(file), dev: stat.dev, ino: stat.ino })}\n`,
    { mode: 0o600 },
  );
}

/**
 * 按 7 天 mtime 清理目录内的过期受管结果文件。
 *
 * 只处理清单登记且身份匹配（dev/ino 一致）的 `run-<uuid>.txt` 文件；
 * 清单缺失、损坏或目录被替换时直接放弃，绝不按文件名猜测删除。
 * 清单本身用「临时名 + 原子 rename」替换，崩溃不会留下半份清单。
 */
export function cleanupManagedResults(directory: string, now = Date.now()): void {
  if (!fs.existsSync(directory)) return;
  const manifest = path.join(directory, RESULT_MANIFEST);
  if (!fs.existsSync(manifest) || !fs.lstatSync(manifest).isFile()) return;
  const cutoff = now - 7 * 86_400_000;
  const retained: string[] = [];
  for (const line of fs.readFileSync(manifest, 'utf8').split('\n')) {
    if (!line) continue;
    let record: { name: string; dev: number; ino: number };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    if (!OWNED_RESULT.test(record.name)) continue;
    const file = path.join(directory, record.name);
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.dev !== record.dev || stat.ino !== record.ino) continue;
    if (stat.mtimeMs < cutoff) fs.unlinkSync(file);
    else retained.push(line);
  }
  const replacement = path.join(directory, `.managed-results-${randomUUID()}.tmp`);
  fs.writeFileSync(replacement, retained.length ? `${retained.join('\n')}\n` : '', { mode: 0o600 });
  fs.renameSync(replacement, manifest);
}

/**
 * 删除整个会话的结果子树；供 SessionManager 删除会话时联动调用。
 *
 * 容忍目录不存在或并发删除（force + 静默吞错）：清理失败不应阻断会话删除，
 * 残留目录会被下一次同类清理或用户手动处理。
 */
export function removeSessionToolResults(directory: string): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    /* 删除失败不阻断会话删除。 */
  }
}
