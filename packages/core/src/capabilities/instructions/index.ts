import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 单个通过全部校验的指令文件；path 为去重后的候选路径，content 是严格 UTF-8 解码的全文。 */
export interface InstructionSource {
  path: string;
  content: string;
}

/** 一次成功加载的完整结果；sources 按「用户层 → 项目根 → 逐级子目录」顺序排列。 */
export interface InstructionSnapshot {
  sources: readonly InstructionSource[];
  /** 全部来源实际字节数之和（以读取结果为准），供调用方审计体积预算。 */
  totalBytes: number;
}

export interface InstructionLoadOptions {
  /** 目录链上界；cwd 必须位于其内，越界直接失败而不是静默截断链。 */
  projectRoot: string;
  /** 指令收集的终点目录；相对 projectRoot 的每一层都会尝试读取 AGENTS.md。 */
  cwd: string;
  /** 用户层指令文件；缺省为 ~/.kapibala/AGENTS.md，与项目层同路径时去重。 */
  userFile?: string;
}

const MAX_FILE_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024;
// 目录链层级上限；判定计数含项目根自身，故比较时用 segments.length + 1
const MAX_LEVELS = 16;

/** 存在的文件解析为 native 真实路径；不存在的候选保持绝对路径形式，等待后续按 ENOENT 跳过。 */
function canonicalizeOptionalFile(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
}

/**
 * 按用户层和项目根至 cwd 的目录链读取指令，全部成功后才返回快照。
 * 所有路径统一用 native 语义解析（与 resolveSessionProject 的 projectRoot 对齐）：JS realpath
 * 不展开 Windows 8.3 短名（CI 临时目录形如 RUNNER~1），混用会让包含性检查把同一目录误判越界、
 * 让去重错过同一文件；返回的 source 路径因此是 canonical 形式，调用方按 canonical 比较。
 */
export function loadInstructions(options: InstructionLoadOptions): InstructionSnapshot {
  const root = fs.realpathSync.native(options.projectRoot);
  const cwd = fs.realpathSync.native(options.cwd);
  const userFile = canonicalizeOptionalFile(
    options.userFile ?? path.join(os.homedir(), '.kapibala', 'AGENTS.md'),
  );
  const relative = path.relative(root, cwd);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Instruction cwd is outside project root');
  }
  const segments = relative ? relative.split(path.sep) : [];
  if (segments.length + 1 > MAX_LEVELS)
    throw new Error(`Instruction directory chain exceeds ${MAX_LEVELS} levels`);
  const candidates = [userFile];
  let directory = root;
  candidates.push(path.join(directory, 'AGENTS.md'));
  for (const segment of segments) {
    directory = path.join(directory, segment);
    candidates.push(path.join(directory, 'AGENTS.md'));
  }

  // 用户层与项目层可能指向同一文件（如用户文件就放在项目根），按平台大小写规则去重
  const seenPaths = new Set<string>();
  const uniqueCandidates: string[] = [];
  for (const file of candidates) {
    const resolved = path.resolve(file);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (!seenPaths.has(key)) {
      seenPaths.add(key);
      uniqueCandidates.push(file);
    }
  }

  const sources: InstructionSource[] = [];
  let totalBytes = 0;
  for (const file of uniqueCandidates) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`Cannot inspect instructions at ${file}`, { cause: error });
    }
    if (stat.isSymbolicLink())
      throw new Error(`Instruction symbolic link is not accepted: ${file}`);
    if (!stat.isFile()) throw new Error(`Instruction source is not a regular file: ${file}`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`Instruction ${file} exceeds 32 KiB`);
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Instructions exceed 128 KiB total');
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch (error: unknown) {
      throw new Error(`Cannot read instructions at ${file}`, { cause: error });
    }
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`Instruction ${file} exceeds 32 KiB`);
    // stat 与读取之间文件可能被替换或增长：用实际字节数校正预算，超限同样失败
    totalBytes += bytes.byteLength - stat.size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Instructions exceed 128 KiB total');
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error: unknown) {
      throw new Error(`Instruction ${file} is not valid UTF-8`, { cause: error });
    }
    sources.push({ path: file, content });
  }
  return { sources, totalBytes };
}
