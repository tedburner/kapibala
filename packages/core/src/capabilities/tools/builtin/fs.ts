import fs from 'node:fs';
import path from 'node:path';
import { AbortError, ToolError } from '../../../errors/index.js';
import type { ToolDiffFacts } from '../../../types/index.js';
import { PathSandbox } from '../../security/sandbox.js';
import { defineTool } from '../index.js';
import { todoWriteTool } from './todo.js';

import type { ToolContext, ToolExecutionResult } from '../index.js';
import { MAX_DIFF_BYTES, countLineDiff, countTextLines } from './file-diff.js';

/** 写入工具的成功返回：正文保持原有字符串语义，另附可落盘的行数事实。 */
interface FileWriteOutput {
  content: string;
  diff?: ToolDiffFacts;
}

/**
 * 把写入结果收敛为执行事实；执行器只在成功路径调用它。
 * 没有 diff 时不写空 facts，避免历史里出现「有事实但没有数字」的歧义记录。
 */
function toWriteExecutionResult(raw: FileWriteOutput): ToolExecutionResult {
  return {
    content: raw.content,
    execution: {
      version: 1,
      dispatchOutcome: 'succeeded',
      ...(raw.diff ? { facts: { version: 1, diff: raw.diff } } : {}),
    },
  };
}

/**
 * 优先复用调用上下文由 AgentSession 持有的 PathSandbox 独占实例，
 * 缺失时根据上下文根路径创建独立实例，杜绝全局模块级单例缓存串扰。
 */
function resolveToolSandbox(ctx: ToolContext): PathSandbox {
  if (ctx.sandbox) return ctx.sandbox;
  return new PathSandbox({ workspaceRoot: ctx.workspaceRoot ?? ctx.rootDir });
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
    const sandbox = resolveToolSandbox(ctx);
    // read 模式允许 PathSandbox 的只读豁免（本会话受管结果目录），写入工具不得传此模式。
    const safePath = sandbox.resolveSafePath(input.path, { mode: 'read' });

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
    if (Buffer.byteLength(line, 'utf-8') > maxReadBytes) {
      throw new ToolError(`File line exceeds ${maxReadBytes} byte limit`);
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
      if (Buffer.byteLength(pending, 'utf-8') > maxReadBytes) {
        throw new ToolError(`File line exceeds ${maxReadBytes} byte limit`);
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
  toExecutionResult: toWriteExecutionResult,
  async execute(input: { path: string; content: string }, ctx): Promise<FileWriteOutput> {
    const sandbox = resolveToolSandbox(ctx);
    const safePath = sandbox.resolveSafePath(input.path);

    const dir = path.dirname(safePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 行数事实在写盘前生成：覆盖已有文件需要旧内容，新建文件按行数计 +N −0。
    // 读取失败或文件过大时不阻断写入，只让 fact 缺失或标记截断，绝不猜数字。
    let diff: ToolDiffFacts | undefined;
    if (!fs.existsSync(safePath)) {
      diff = { additions: countTextLines(input.content), deletions: 0 };
    } else {
      try {
        const stat = fs.statSync(safePath);
        if (stat.isFile()) {
          if (stat.size > MAX_DIFF_BYTES) diff = { truncated: true };
          else diff = countLineDiff(fs.readFileSync(safePath, 'utf-8'), input.content);
        }
      } catch {
        /* 旧内容不可读时保留「未记录」，写入本身仍按既有语义执行。 */
      }
    }

    fs.writeFileSync(safePath, input.content, 'utf-8');
    return {
      content: `Successfully wrote ${Buffer.byteLength(input.content, 'utf-8')} bytes to ${input.path}`,
      ...(diff ? { diff } : {}),
    };
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
  toExecutionResult: toWriteExecutionResult,
  async execute(
    input: { path: string; targetContent: string; replacementContent: string },
    ctx,
  ): Promise<FileWriteOutput> {
    const sandbox = resolveToolSandbox(ctx);
    const safePath = sandbox.resolveSafePath(input.path);

    if (!fs.existsSync(safePath)) {
      throw new ToolError(`File not found: ${input.path}`);
    }

    if (typeof input.targetContent !== 'string' || !input.targetContent) {
      throw new ToolError('Target content must be a non-empty string');
    }
    if (typeof input.replacementContent !== 'string') {
      throw new ToolError('Replacement content must be a string');
    }

    const content = fs.readFileSync(safePath, 'utf-8');
    let actualTarget = input.targetContent;
    let actualReplacement = input.replacementContent;
    if (
      !content.includes(actualTarget) &&
      content.includes('\r\n') &&
      !actualTarget.includes('\r\n')
    ) {
      // Windows/遗留仓库文件常为 CRLF，而模型入参固定发送 LF：仅在转换后能命中时回退，并保持原文件 CRLF 行尾。
      const crlfTarget = actualTarget.replace(/\n/g, '\r\n');
      if (content.includes(crlfTarget)) {
        actualTarget = crlfTarget;
        actualReplacement = actualReplacement.replace(/\r?\n/g, '\r\n');
      }
    }
    if (!content.includes(actualTarget)) {
      throw new ToolError(
        `Target content not found in ${input.path}. Read the relevant lines first and ensure exact indentation and characters.`,
      );
    }

    // 统计出现次数，若出现多次则要求精确
    const occurrences = content.split(actualTarget).length - 1;
    if (occurrences > 1) {
      throw new ToolError(
        `Target content occurs ${occurrences} times in ${input.path}. Please provide more surrounding context to match uniquely.`,
      );
    }

    // 必须用函数形式提供 replacement：字符串形式会把 $& / $` / $' / $$ 当特殊模式展开，
    // 导致写入内容被静默污染(例如替换目标里写 '$$' 会变成 '$')。
    const newContent = content.replace(actualTarget, () => actualReplacement);
    fs.writeFileSync(safePath, newContent, 'utf-8');
    return {
      content: `Successfully replaced target content in ${input.path}`,
      diff: countLineDiff(content, newContent),
    };
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
    if (typeof input.pattern !== 'string' || !input.pattern.trim()) {
      throw new ToolError('Search pattern must not be empty');
    }
    const sandbox = resolveToolSandbox(ctx);
    // 枚举根与相对化基准都取沙箱的 native 物理根：宿主传入的 rootDir 可能是 Windows 8.3 短名或
    // 软链接别名，与 resolveSafePath 的长路径身份混用会让 path.relative 产出 "../.." 逃逸串。
    const relBase = sandbox.workspaceRoot;
    const searchRoot = input.subDirectory ? sandbox.resolveSafePath(input.subDirectory) : relBase;

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
        const relPath = path.relative(relBase, fullPath).replace(/\\/g, '/');

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
      include: {
        type: 'string',
        description: 'Optional filename/path glob filter (e.g. "*.xml", "pom.xml", "src/**/*.ts").',
      },
    },
    required: ['pattern'],
  },
  async execute(input: { pattern: string; path?: string }, ctx) {
    if (ctx.signal?.aborted) throw new AbortError();
    if (typeof input.pattern !== 'string' || !input.pattern.trim()) {
      throw new ToolError('Search pattern must not be empty');
    }
    const sandbox = resolveToolSandbox(ctx);
    // 与 list_dir 同理：命中行的相对路径必须以沙箱 native 物理根为基准，否则短名/软链接别名根
    // 会渲染成 "../../…" 这种对模型无意义且无法回读的路径。
    const relBase = sandbox.workspaceRoot;
    const target = input.path ? sandbox.resolveSafePath(input.path) : relBase;

    if (!fs.existsSync(target)) {
      throw new ToolError(`Path not found: ${input.path ?? '.'}`);
    }

    const rawInclude = (input as { include?: unknown }).include;
    const includeFilter =
      typeof rawInclude === 'string' && rawInclude.trim() ? rawInclude.trim() : undefined;
    const needle = input.pattern.toLowerCase();
    const matches: string[] = [];
    const maxMatches = 50;
    let outputBytes = 0;

    async function searchFile(filePath: string): Promise<void> {
      if (matches.length >= maxMatches) return;
      const maxLineBytes = 512 * 1024;
      const maxOutputBytes = 512 * 1024;
      const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const relPath = path.relative(relBase, filePath).replace(/\\/g, '/');
      let lineNumber = 0;
      let pending = '';
      let skippingLongLine = false;

      const inspectLine = (line: string): void => {
        lineNumber++;
        if (skippingLongLine || Buffer.byteLength(line, 'utf-8') > maxLineBytes) {
          skippingLongLine = false;
          if (line.toLowerCase().includes(needle)) {
            throw new ToolError(`Search line exceeds ${maxLineBytes} byte limit`);
          }
          return;
        }
        if (!line.toLowerCase().includes(needle)) return;
        const match = `${relPath}:${lineNumber}: ${line.trim()}`;
        const bytes = Buffer.byteLength(match, 'utf-8') + (matches.length > 0 ? 1 : 0);
        if (outputBytes + bytes > maxOutputBytes) {
          throw new ToolError(`Search results exceed ${maxOutputBytes} byte limit`);
        }
        matches.push(match);
        outputBytes += bytes;
      };

      try {
        for await (const chunk of stream) {
          if (ctx.signal?.aborted) throw new AbortError();
          pending += chunk;
          let newlineIndex = pending.indexOf('\n');
          while (newlineIndex >= 0) {
            inspectLine(pending.slice(0, newlineIndex).replace(/\r$/, ''));
            pending = pending.slice(newlineIndex + 1);
            if (matches.length >= maxMatches) return;
            newlineIndex = pending.indexOf('\n');
          }
          if (Buffer.byteLength(pending, 'utf-8') > maxLineBytes) {
            if (pending.toLowerCase().includes(needle)) {
              throw new ToolError(`Search line exceeds ${maxLineBytes} byte limit`);
            }
            skippingLongLine = true;
            pending = needle.length > 1 ? pending.slice(1 - needle.length) : '';
          }
        }
        if (pending.length > 0) inspectLine(pending.replace(/\r$/, ''));
      } catch (error: unknown) {
        if (error instanceof AbortError || error instanceof ToolError) throw error;
        // 无法读取的文件不阻断其它搜索结果。
      } finally {
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
        if (entry.isSymbolicLink()) continue;
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else {
          if (includeFilter) {
            const relPath = path.relative(relBase, fullPath).replace(/\\/g, '/');
            if (!simpleMatch(entry.name, includeFilter) && !simpleMatch(relPath, includeFilter)) {
              continue;
            }
          }
          await searchFile(fullPath);
        }
        if (matches.length >= maxMatches) return;
      }
    }

    const stat = fs.statSync(target);
    if (stat.isFile()) {
      if (includeFilter) {
        const relPath = path.relative(relBase, target).replace(/\\/g, '/');
        const baseName = path.basename(target);
        if (simpleMatch(baseName, includeFilter) || simpleMatch(relPath, includeFilter)) {
          await searchFile(target);
        }
      } else {
        await searchFile(target);
      }
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

/**
 * 内置工具聚合：五个文件工具（全部经 PathSandbox 校验，路径越界或符号链接穿透一律拒绝）
 * 加会话任务清单写入工具（无文件副作用，见 todo.ts）。宿主按此数组整体注册。
 */
export const builtinTools = [
  readFileTool,
  writeFileTool,
  editFileTool,
  globTool,
  grepTool,
  todoWriteTool,
];
