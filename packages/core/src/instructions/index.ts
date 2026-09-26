import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface InstructionSource {
  path: string;
  content: string;
}

export interface InstructionSnapshot {
  sources: readonly InstructionSource[];
  totalBytes: number;
}

export interface InstructionLoadOptions {
  projectRoot: string;
  cwd: string;
  userFile?: string;
}

const MAX_FILE_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024;
const MAX_LEVELS = 16;

/** 按用户层和项目根至 cwd 的目录链读取指令，全部成功后才返回快照。 */
export function loadInstructions(options: InstructionLoadOptions): InstructionSnapshot {
  const root = fs.realpathSync(options.projectRoot);
  const cwd = fs.realpathSync(options.cwd);
  const relative = path.relative(root, cwd);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Instruction cwd is outside project root');
  }
  const segments = relative ? relative.split(path.sep) : [];
  if (segments.length + 1 > MAX_LEVELS)
    throw new Error(`Instruction directory chain exceeds ${MAX_LEVELS} levels`);
  const userFile = options.userFile ?? path.join(os.homedir(), '.kapibala', 'AGENTS.md');
  const candidates = [userFile];
  let directory = root;
  candidates.push(path.join(directory, 'AGENTS.md'));
  for (const segment of segments) {
    directory = path.join(directory, segment);
    candidates.push(path.join(directory, 'AGENTS.md'));
  }

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
