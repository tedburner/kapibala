import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { AbortError, ToolError } from '../../errors/index.js';
import { PathSandbox } from '../../security/sandbox.js';
import { defineTool } from '../index.js';

// PathSandbox 会缓存 rootDir 的 realpath，按 rootDir 复用实例避免每次调用重建缓存
const sandboxCache = new Map<string, PathSandbox>();

function getSandbox(rootDir: string): PathSandbox {
  let sandbox = sandboxCache.get(rootDir);
  if (!sandbox) {
    sandbox = new PathSandbox({ rootDir });
    sandboxCache.set(rootDir, sandbox);
  }
  return sandbox;
}

// 1. read_file
export const readFileTool = defineTool({
  name: 'read_file',
  description: 'Read the text contents of a file at the specified path.',
  metadata: {
    source: 'builtin',
    permissions: ['fs:read'],
  },
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path of the file to read (relative to workspace or absolute).',
      },
      startLine: {
        type: 'integer',
        description: 'Optional 1-based start line to read from.',
      },
      endLine: {
        type: 'integer',
        description: 'Optional 1-based end line to read to (inclusive).',
      },
    },
    required: ['path'],
  },
  async execute(input: { path: string; startLine?: number; endLine?: number }, ctx) {
    const sandbox = getSandbox(ctx.rootDir);
    const safePath = sandbox.resolveSafePath(input.path);

    if (!fs.existsSync(safePath)) {
      throw new ToolError(`File not found: ${input.path}`);
    }

    const stat = fs.statSync(safePath);
    if (stat.isDirectory()) {
      throw new ToolError(`Target path is a directory, not a file: ${input.path}`);
    }

    // 大小上限：避免把超大文件整段读进模型上下文撑爆 token
    const maxReadBytes = 512 * 1024;
    const hasLineRange = input.startLine !== undefined || input.endLine !== undefined;
    if (stat.size > maxReadBytes && !hasLineRange) {
      throw new ToolError(
        `File too large to read in one call: ${input.path} (${stat.size} bytes > ${maxReadBytes}). Use startLine/endLine to read in chunks, or narrow the file first.`,
      );
    }

    // 二进制嗅探：首 8KB 出现 NUL 字节基本可判定为二进制文件，避免乱码进入上下文
    const prefixSize = Math.min(stat.size, 8192);
    const prefix = Buffer.alloc(prefixSize);
    const fileDescriptor = fs.openSync(safePath, 'r');
    try {
      fs.readSync(fileDescriptor, prefix, 0, prefixSize, 0);
    } finally {
      fs.closeSync(fileDescriptor);
    }
    if (prefix.includes(0)) {
      throw new ToolError(`Cannot read binary file: ${input.path}`);
    }

    if (hasLineRange) {
      return readFileLineRange(
        safePath,
        Math.max(1, input.startLine ?? 1),
        input.endLine,
        maxReadBytes,
      );
    }

    return fs.readFileSync(safePath, 'utf-8');
  },
});

/**
 * 流式读取指定的 1-based 闭区间，避免为了少量目标行把整个大文件载入内存。
 * 返回片段仍受 maxReadBytes 限制，防止调用方用超大行区间绕过全文读取上限。
 */
async function readFileLineRange(
  filePath: string,
  startLine: number,
  endLine: number | undefined,
  maxReadBytes: number,
): Promise<string> {
  if (endLine !== undefined && endLine < startLine) return '';

  const selectedLines: string[] = [];
  let selectedBytes = 0;
  let currentLine = 1;
  let pending = '';
  let reachedEnd = false;
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });

  const selectLine = (line: string): void => {
    if (currentLine >= startLine && (endLine === undefined || currentLine <= endLine)) {
      const addedBytes = Buffer.byteLength(line, 'utf-8') + (selectedLines.length > 0 ? 1 : 0);
      if (selectedBytes + addedBytes > maxReadBytes) {
        throw new ToolError(
          `Requested line range exceeds ${maxReadBytes} bytes. Use a narrower startLine/endLine range.`,
        );
      }
      selectedLines.push(line);
      selectedBytes += addedBytes;
    }
    currentLine++;
    reachedEnd = endLine !== undefined && currentLine > endLine;
  };

  try {
    for await (const chunk of stream) {
      pending += chunk;
      let newlineIndex = pending.indexOf('\n');
      while (newlineIndex >= 0) {
        selectLine(pending.slice(0, newlineIndex));
        pending = pending.slice(newlineIndex + 1);
        if (reachedEnd) break;
        newlineIndex = pending.indexOf('\n');
      }
      if (reachedEnd) break;
    }
    if (!reachedEnd) selectLine(pending);
  } finally {
    stream.destroy();
  }

  return selectedLines.join('\n');
}

// 2. write_file
export const writeFileTool = defineTool({
  name: 'write_file',
  description: 'Create a new file or overwrite an existing file with new content.',
  metadata: {
    source: 'builtin',
    permissions: ['fs:write'],
  },
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path of the file to write to.',
      },
      content: {
        type: 'string',
        description: 'The full text content to write into the file.',
      },
    },
    required: ['path', 'content'],
  },
  async execute(input: { path: string; content: string }, ctx) {
    const sandbox = getSandbox(ctx.rootDir);
    const safePath = sandbox.resolveSafePath(input.path);

    const dir = path.dirname(safePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(safePath, input.content, 'utf-8');
    return `Successfully wrote ${Buffer.byteLength(input.content, 'utf-8')} bytes to ${input.path}`;
  },
});

// 3. edit_file
export const editFileTool = defineTool({
  name: 'edit_file',
  description: 'Perform an exact string replacement in a file.',
  metadata: {
    source: 'builtin',
    permissions: ['fs:write'],
  },
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path of the file to edit.',
      },
      targetContent: {
        type: 'string',
        description: 'The exact string snippet in the file to be replaced.',
      },
      replacementContent: {
        type: 'string',
        description: 'The new replacement content to put in place of targetContent.',
      },
    },
    required: ['path', 'targetContent', 'replacementContent'],
  },
  async execute(input: { path: string; targetContent: string; replacementContent: string }, ctx) {
    const sandbox = getSandbox(ctx.rootDir);
    const safePath = sandbox.resolveSafePath(input.path);

    if (!fs.existsSync(safePath)) {
      throw new ToolError(`File not found: ${input.path}`);
    }

    const content = fs.readFileSync(safePath, 'utf-8');
    if (!content.includes(input.targetContent)) {
      throw new ToolError(
        `Target content not found in ${input.path}. Ensure exact indentation and characters.`,
      );
    }

    // 统计出现次数，若出现多次则要求精确
    const occurrences = content.split(input.targetContent).length - 1;
    if (occurrences > 1) {
      throw new ToolError(
        `Target content occurs ${occurrences} times in ${input.path}. Please provide more surrounding context to match uniquely.`,
      );
    }

    // 必须用函数形式提供 replacement：字符串形式会把 $& / $` / $' / $$ 当特殊模式展开，
    // 导致写入内容被静默污染(例如替换目标里写 '$$' 会变成 '$')。
    const newContent = content.replace(input.targetContent, () => input.replacementContent);
    fs.writeFileSync(safePath, newContent, 'utf-8');
    return `Successfully replaced target content in ${input.path}`;
  },
});

// 4. glob
export const globTool = defineTool({
  name: 'glob',
  description: 'Search for files matching a pattern within a directory.',
  metadata: {
    source: 'builtin',
    permissions: ['fs:read'],
  },
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'A glob pattern or filename prefix/suffix to match (e.g. "*.ts", "src/**").',
      },
      subDirectory: {
        type: 'string',
        description: 'Optional sub-directory to restrict search within.',
      },
    },
    required: ['pattern'],
  },
  async execute(input: { pattern: string; subDirectory?: string }, ctx) {
    const sandbox = getSandbox(ctx.rootDir);
    const searchRoot = input.subDirectory
      ? sandbox.resolveSafePath(input.subDirectory)
      : ctx.rootDir;

    if (!fs.existsSync(searchRoot)) {
      throw new ToolError(`Directory not found: ${input.subDirectory ?? '.'}`);
    }

    const results: string[] = [];
    const maxResults = 100;

    function walk(currentDir: string) {
      if (results.length >= maxResults) return;
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
          continue;
        }
        const fullPath = path.join(currentDir, entry.name);
        const relPath = path.relative(ctx.rootDir, fullPath).replace(/\\/g, '/');

        if (entry.isDirectory()) {
          walk(fullPath);
        } else {
          // 简易 glob 模式匹配
          if (simpleMatch(entry.name, input.pattern) || simpleMatch(relPath, input.pattern)) {
            results.push(relPath);
            if (results.length >= maxResults) return;
          }
        }
      }
    }

    walk(searchRoot);
    return results.length > 0 ? results.join('\n') : 'No matching files found.';
  },
});

// 5. grep
export const grepTool = defineTool({
  name: 'grep',
  description: 'Search for case-insensitive literal text in files within workspace.',
  metadata: {
    source: 'builtin',
    permissions: ['fs:read'],
  },
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          'Literal text to search for. Regular-expression characters have no special meaning.',
      },
      path: {
        type: 'string',
        description: 'File or directory path to search within.',
      },
    },
    required: ['pattern'],
  },
  async execute(input: { pattern: string; path?: string }, ctx) {
    if (ctx.signal?.aborted) throw new AbortError();
    const sandbox = getSandbox(ctx.rootDir);
    const target = input.path ? sandbox.resolveSafePath(input.path) : ctx.rootDir;

    if (!fs.existsSync(target)) {
      throw new ToolError(`Path not found: ${input.path ?? '.'}`);
    }

    if (!input.pattern.trim()) throw new ToolError('Search pattern must not be empty');
    const needle = input.pattern.toLowerCase();
    const matches: string[] = [];
    const maxMatches = 50;

    async function searchFile(filePath: string): Promise<void> {
      if (matches.length >= maxMatches) return;
      const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const lines = readline.createInterface({
        input: stream,
        crlfDelay: Number.POSITIVE_INFINITY,
      });
      try {
        const relPath = path.relative(ctx.rootDir, filePath).replace(/\\/g, '/');
        let lineNumber = 0;
        for await (const line of lines) {
          if (ctx.signal?.aborted) throw new AbortError();
          lineNumber++;
          if (line.toLowerCase().includes(needle)) {
            matches.push(`${relPath}:${lineNumber}: ${line.trim()}`);
            if (matches.length >= maxMatches) break;
          }
        }
      } catch (error: unknown) {
        if (error instanceof AbortError) throw error;
        // 忽略非文本或读取错误
      } finally {
        lines.close();
        stream.destroy();
      }
    }

    async function walk(dirPath: string): Promise<void> {
      if (matches.length >= maxMatches) return;
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (ctx.signal?.aborted) throw new AbortError();
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
          continue;
        }
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else {
          await searchFile(fullPath);
        }
        if (matches.length >= maxMatches) return;
      }
    }

    const stat = fs.statSync(target);
    if (stat.isFile()) {
      await searchFile(target);
    } else {
      await walk(target);
    }

    return matches.length > 0 ? matches.join('\n') : 'No matches found.';
  },
});

function simpleMatch(str: string, pattern: string): boolean {
  if (pattern === '*' || pattern === '**') return true;
  // 单趟替换，同时完成特殊字符转义与通配符展开：
  // 1. 避免 pattern 里的 ( + [ 等字符炸出非法正则或意外语义；
  // 2. 通配符是纯字面匹配，不存在回溯放大，天然规避 ReDoS。
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]|\*{1,2}/g, (match) =>
    match === '**' ? '.*' : match === '*' ? '[^/]*' : `\\${match}`,
  );
  return new RegExp(`^${escaped}$`, 'i').test(str);
}

export const builtinTools = [readFileTool, writeFileTool, editFileTool, globTool, grepTool];
