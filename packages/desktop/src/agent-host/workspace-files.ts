import fs from 'node:fs';
import path from 'node:path';
import { KapibalaError, PathSandbox, toNativePhysicalPath } from '@kiturone/kapibala';

/** 单次文件预览允许读取的最大 UTF-8 字节上限（512 KiB）。 */
export const MAX_WORKSPACE_FILE_READ_BYTES = 512 * 1024;

/** 二进制文件探测窗口（前 8 KiB 出现 `0x00` 字节即判定为二进制文件）。 */
const BINARY_PROBE_BYTES = 8 * 1024;

/** 带搜索词过滤时的最大候选文件扫描预算，保障超过 5,000 文件的大型仓库仍可全量检索。 */
const MAX_QUERY_SCAN_FILES = 100_000;

/** 通用忽略目录：依赖、虚拟环境、构建产物与版本库元数据一律不进补全清单。 */
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.kapibala',
  'dist',
  'out',
  'build',
  'coverage',
  'test-results',
  'playwright-report',
  'venv',
  '__pycache__',
  'target',
]);

const EXTENSION_LANGUAGE_MAP: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'jsx',
  '.json': 'json',
  '.jsonc': 'json',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  '.svg': 'xml',
  '.xml': 'xml',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.ps1': 'powershell',
  '.cmd': 'bat',
  '.bat': 'bat',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.vue': 'vue',
  '.svelte': 'svelte',
};

function isAllowedEnvTemplateName(baseName: string): boolean {
  return /^\.env\.(example|sample|template)$/i.test(baseName);
}

function isDeniedEnvOrHookFileName(baseName: string): boolean {
  const lower = baseName.toLowerCase();
  if (lower === '.envrc') return true;
  return /^\.env($|\.)/i.test(baseName) && !isAllowedEnvTemplateName(baseName);
}

/**
 * 判断相对路径是否命中桌面文件检视硬禁区（`.kapibala/**`、`.git/**`、`.envrc`、敏感 `.env` / `.env.*`）。
 */
export function isDeniedWorkspaceReadPath(relPath: string): boolean {
  const normalized = relPath.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized) return true;
  const segments = normalized.split('/').filter(Boolean);
  for (const seg of segments) {
    const lower = seg.toLowerCase();
    if (lower === '.kapibala' || lower === '.git') {
      return true;
    }
  }
  const baseName = segments[segments.length - 1] ?? '';
  if (isDeniedEnvOrHookFileName(baseName)) {
    return true;
  }
  return false;
}

/**
 * 计算路径与查询词的匹配优先级（数值越小越靠前；不匹配返回 `null`）。
 * 优先级：精确文件名(0) > 文件名前缀(1) > 文件名子串(2) > 路径子串(3) > 顺序模糊子序列(4)。
 */
function scoreFileQueryMatch(relPath: string, lowerQuery: string): number | null {
  const posixPath = relPath.replaceAll('\\', '/');
  const lowerPath = posixPath.toLowerCase();
  const slashIdx = lowerPath.lastIndexOf('/');
  const lowerBase = slashIdx >= 0 ? lowerPath.slice(slashIdx + 1) : lowerPath;

  if (lowerBase === lowerQuery) return 0;
  if (lowerBase.startsWith(lowerQuery)) return 1;
  if (lowerBase.includes(lowerQuery)) return 2;
  if (lowerPath.includes(lowerQuery)) return 3;

  // 顺序子序列模糊匹配（如 `wfiles` 匹配 `workspace-files.ts`）
  let qIdx = 0;
  for (let i = 0; i < lowerPath.length && qIdx < lowerQuery.length; i++) {
    if (lowerPath[i] === lowerQuery[qIdx]) {
      qIdx += 1;
    }
  }
  return qIdx === lowerQuery.length ? 4 : null;
}

function trimIncompleteUtf8Tail(buf: Buffer): number {
  const len = buf.length;
  if (len === 0) return 0;
  let contCount = 0;
  while (contCount < 3 && contCount < len && (buf[len - 1 - contCount]! & 0xc0) === 0x80) {
    contCount += 1;
  }
  if (contCount === len) return len;
  const leadIndex = len - 1 - contCount;
  const lead = buf[leadIndex]!;
  if (lead < 0x80) {
    return contCount === 0 ? len : leadIndex + 1;
  }
  let expectedSeqLen = 1;
  if ((lead & 0xe0) === 0xc0) expectedSeqLen = 2;
  else if ((lead & 0xf0) === 0xe0) expectedSeqLen = 3;
  else if ((lead & 0xf8) === 0xf0) expectedSeqLen = 4;
  else return leadIndex;

  return 1 + contCount < expectedSeqLen ? leadIndex : len;
}

function detectFileLanguage(relPosixPath: string): string {
  const baseLower = path.posix.basename(relPosixPath).toLowerCase();
  if (baseLower === 'dockerfile' || baseLower.startsWith('dockerfile.')) return 'dockerfile';
  if (baseLower === 'makefile') return 'makefile';
  const ext = path.posix.extname(baseLower);
  return EXTENSION_LANGUAGE_MAP[ext] ?? 'plaintext';
}

/**
 * 工作区相对路径枚举：composer `@` 文件补全与右侧工作台 `Files` 标签树共用数据源。
 *
 * 保证与边界：
 * - 只枚举路径，不读取文件内容；调用方负责先确认工作区已受信任（requireTrust）；
 * - **广度优先 + 逐层按名称排序**：浅层文件先于深层入列，跨平台枚举顺序完全一致；
 * - 当提供非空 `query` 时，先扫描全仓（上限 10 万条）做大小写不敏感子串/模糊打分排序，再截取前 `maxFiles` 条，
 *   确保超过 5,000 文件的大型仓库仍能搜到深层文件；
 * - 通用忽略目录、点开头目录与敏感 `.env*` 密钥文件（不含 `.env.example|.sample|.template`）一律跳过。
 */
export function enumerateWorkspaceFiles(
  root: string,
  budgets: { maxFiles: number; maxDepth: number; query?: string },
): { files: string[]; truncated: boolean } {
  const trimmedQuery = budgets.query?.trim().toLowerCase() ?? '';
  if (!trimmedQuery) {
    const files: string[] = [];
    let truncated = false;
    const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (queue.length > 0) {
      if (files.length >= budgets.maxFiles) {
        truncated = true;
        break;
      }
      const { dir, depth } = queue.shift() as { dir: string; depth: number };
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const directories: string[] = [];
      const directoryFiles: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
          directories.push(entry.name);
        } else if (entry.isFile()) {
          if (isDeniedEnvOrHookFileName(entry.name)) continue;
          directoryFiles.push(entry.name);
        }
      }
      directories.sort((a, b) => a.localeCompare(b));
      directoryFiles.sort((a, b) => a.localeCompare(b));
      for (const name of directoryFiles) {
        if (files.length >= budgets.maxFiles) {
          truncated = true;
          break;
        }
        files.push(path.relative(root, path.join(dir, name)));
      }
      if (files.length >= budgets.maxFiles) break;
      if (depth + 1 > budgets.maxDepth) {
        if (directories.length > 0) truncated = true;
        continue;
      }
      for (const name of directories) {
        queue.push({ dir: path.join(dir, name), depth: depth + 1 });
      }
    }
    return { files, truncated };
  }

  // 带查询词时全树检索并按相关性排序后再截断到 maxFiles
  const scored: Array<{ file: string; score: number }> = [];
  let scanned = 0;
  let truncated = false;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    if (scanned >= MAX_QUERY_SCAN_FILES) {
      truncated = true;
      break;
    }
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const directories: string[] = [];
    const directoryFiles: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
        directories.push(entry.name);
      } else if (entry.isFile()) {
        if (isDeniedEnvOrHookFileName(entry.name)) continue;
        directoryFiles.push(entry.name);
      }
    }
    directories.sort((a, b) => a.localeCompare(b));
    directoryFiles.sort((a, b) => a.localeCompare(b));
    for (const name of directoryFiles) {
      if (scanned >= MAX_QUERY_SCAN_FILES) {
        truncated = true;
        break;
      }
      scanned += 1;
      const rel = path.relative(root, path.join(dir, name));
      const score = scoreFileQueryMatch(rel, trimmedQuery);
      if (score !== null) {
        scored.push({ file: rel, score });
      }
    }
    if (scanned >= MAX_QUERY_SCAN_FILES) break;
    if (depth + 1 > budgets.maxDepth) {
      if (directories.length > 0) truncated = true;
      continue;
    }
    for (const name of directories) {
      queue.push({ dir: path.join(dir, name), depth: depth + 1 });
    }
  }

  scored.sort(
    (a, b) => a.score - b.score || a.file.length - b.file.length || a.file.localeCompare(b.file),
  );
  if (scored.length > budgets.maxFiles) {
    truncated = true;
  }
  return {
    files: scored.slice(0, budgets.maxFiles).map((item) => item.file),
    truncated,
  };
}

/**
 * 只读读取已信任工作区（或已验真受管 Git Worktree）内的单个文件供工作台 `Files` 标签渲染。
 *
 * 安全与预算不变量：
 * 1. 经 Core `PathSandbox(mode: 'read')` 解析，严格拦截 `..` 穿越、越界软链与 Windows NTFS 备用数据流；
 * 2. 硬禁区拦截 `.kapibala/**`、`.git/**` 与 `.env` / `.env.*`（仅放行 `.env.example|.sample|.template`），
 *    同时复核真实物理目标路径，阻断工作区内软链绕过读取敏感密钥；
 * 3. 使用定长文件描述符读取（上限 `512 KiB`），前 `8 KiB` 含 `0x00` 判为二进制并直接返回空正文。
 */
export function readWorkspaceFile(options: {
  readonly root: string;
  readonly targetPath: string;
  readonly maxBytes?: number;
}): {
  readonly path: string;
  readonly content: string;
  readonly byteLength: number;
  readonly truncated: boolean;
  readonly binary: boolean;
  readonly language: string;
} {
  const maxBytes = options.maxBytes ?? MAX_WORKSPACE_FILE_READ_BYTES;
  const canonicalRoot = toNativePhysicalPath(path.resolve(options.root));
  const rawTarget = options.targetPath.trim();
  if (!rawTarget || rawTarget.includes('\0')) {
    throw new KapibalaError('Invalid file path', {
      code: 'INVALID_REQUEST',
      retryPolicy: 'never',
      safeMessage: '文件路径无效',
    });
  }

  const sandbox = new PathSandbox({ workspaceRoot: canonicalRoot });
  let resolvedPath: string;
  try {
    resolvedPath = sandbox.resolveSafePath(rawTarget, { mode: 'read' });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const msg = err instanceof Error ? err.message : String(err);
    if (code === 'PERMISSION_DENIED') {
      throw new KapibalaError(msg, {
        code: 'PERMISSION_DENIED',
        retryPolicy: 'never',
        safeMessage: '禁止读取受保护的配置或密钥文件',
      });
    }
    if (msg.toLowerCase().includes('escapes')) {
      throw new KapibalaError(msg, {
        code: 'WORKSPACE_ESCAPE',
        retryPolicy: 'never',
        safeMessage: '请求的文件路径越出了工作区安全边界',
      });
    }
    throw err;
  }
  const relFromInput = path.relative(canonicalRoot, path.resolve(canonicalRoot, rawTarget));
  const relFromResolved = path.relative(canonicalRoot, resolvedPath);

  if (isDeniedWorkspaceReadPath(relFromInput) || isDeniedWorkspaceReadPath(relFromResolved)) {
    throw new KapibalaError(`Access denied for protected path: ${rawTarget}`, {
      code: 'PERMISSION_DENIED',
      retryPolicy: 'never',
      safeMessage: '禁止读取受保护的配置或密钥文件',
    });
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw Object.assign(new Error('FILE_NOT_FOUND'), { code: 'FILE_NOT_FOUND' });
    }
    throw err;
  }

  if (stat.isDirectory()) {
    throw Object.assign(new Error('FILE_IS_DIRECTORY'), { code: 'FILE_IS_DIRECTORY' });
  }
  if (!stat.isFile()) {
    throw Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN' });
  }

  // 展开工作区内软链/联接点物理路径，阻断通过 `link-env -> .env` 或 `link -> .kapibala/mcp.json` 绕过硬禁区。
  const physicalTarget = toNativePhysicalPath(resolvedPath);
  const relFromPhysical = path.relative(canonicalRoot, physicalTarget);
  if (
    !relFromPhysical ||
    relFromPhysical === '..' ||
    relFromPhysical.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relFromPhysical)
  ) {
    throw new KapibalaError(`Symlink target escapes workspace: ${rawTarget}`, {
      code: 'WORKSPACE_ESCAPE',
      retryPolicy: 'never',
      safeMessage: '请求的文件路径越出了工作区安全边界',
    });
  }
  if (isDeniedWorkspaceReadPath(relFromPhysical)) {
    throw new KapibalaError(`Access denied for symlinked protected path: ${rawTarget}`, {
      code: 'PERMISSION_DENIED',
      retryPolicy: 'never',
      safeMessage: '禁止读取受保护的配置或密钥文件',
    });
  }

  const normalizedRelPosix = relFromResolved.replaceAll('\\', '/');
  const language = detectFileLanguage(normalizedRelPosix);
  const cap = maxBytes + 1;
  const buf = Buffer.allocUnsafe(Math.min(Math.max(stat.size + 1, 64), cap));
  const fd = fs.openSync(physicalTarget, 'r');
  let totalRead = 0;
  try {
    while (totalRead < buf.byteLength) {
      const chunk = fs.readSync(fd, buf, totalRead, buf.byteLength - totalRead, totalRead);
      if (chunk <= 0) break;
      totalRead += chunk;
    }
    if (totalRead === buf.byteLength && totalRead < cap) {
      const grown = Buffer.allocUnsafe(cap);
      buf.copy(grown, 0, 0, totalRead);
      while (totalRead < cap) {
        const chunk = fs.readSync(fd, grown, totalRead, cap - totalRead, totalRead);
        if (chunk <= 0) break;
        totalRead += chunk;
      }
      const truncated = totalRead > maxBytes || stat.size > maxBytes;
      const bytesRead = Math.min(totalRead, maxBytes);
      const slice = grown.subarray(0, bytesRead);
      const probeWindow = slice.subarray(0, Math.min(slice.length, BINARY_PROBE_BYTES));
      if (probeWindow.includes(0)) {
        return {
          path: normalizedRelPosix,
          content: '',
          byteLength: Math.max(stat.size, totalRead),
          truncated: false,
          binary: true,
          language: 'plaintext',
        };
      }
      const safeUtf8Len = truncated ? trimIncompleteUtf8Tail(slice) : slice.length;
      return {
        path: normalizedRelPosix,
        content: slice.subarray(0, safeUtf8Len).toString('utf8'),
        byteLength: Math.max(stat.size, totalRead),
        truncated,
        binary: false,
        language,
      };
    }
  } finally {
    fs.closeSync(fd);
  }

  if (totalRead === 0) {
    return {
      path: normalizedRelPosix,
      content: '',
      byteLength: stat.size,
      truncated: false,
      binary: false,
      language,
    };
  }

  const truncated = totalRead > maxBytes || stat.size > maxBytes;
  const bytesRead = Math.min(totalRead, maxBytes);
  const slice = buf.subarray(0, bytesRead);
  const probeWindow = slice.subarray(0, Math.min(slice.length, BINARY_PROBE_BYTES));
  if (probeWindow.includes(0)) {
    return {
      path: normalizedRelPosix,
      content: '',
      byteLength: Math.max(stat.size, totalRead),
      truncated: false,
      binary: true,
      language: 'plaintext',
    };
  }

  const safeUtf8Len = truncated ? trimIncompleteUtf8Tail(slice) : slice.length;
  return {
    path: normalizedRelPosix,
    content: slice.subarray(0, safeUtf8Len).toString('utf8'),
    byteLength: Math.max(stat.size, totalRead),
    truncated,
    binary: false,
    language,
  };
}
