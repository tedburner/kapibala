import fs from 'node:fs';
import path from 'node:path';
import { ToolError } from '../../errors/index.js';
import { PathSandbox } from '../../security/sandbox.js';
import { defineTool } from '../index.js';

function getSandbox(rootDir: string): PathSandbox {
  return new PathSandbox({ rootDir });
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

    const content = fs.readFileSync(safePath, 'utf-8');
    if (input.startLine !== undefined || input.endLine !== undefined) {
      const lines = content.split('\n');
      const start = Math.max(1, input.startLine ?? 1) - 1;
      const end =
        input.endLine !== undefined ? Math.min(lines.length, input.endLine) : lines.length;
      return lines.slice(start, end).join('\n');
    }

    return content;
  },
});

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

    const newContent = content.replace(input.targetContent, input.replacementContent);
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
  description: 'Search for regex pattern matches in files within workspace.',
  metadata: {
    source: 'builtin',
    permissions: ['fs:read'],
  },
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regex pattern or substring to search for.',
      },
      path: {
        type: 'string',
        description: 'File or directory path to search within.',
      },
    },
    required: ['pattern'],
  },
  async execute(input: { pattern: string; path?: string }, ctx) {
    const sandbox = getSandbox(ctx.rootDir);
    const target = input.path ? sandbox.resolveSafePath(input.path) : ctx.rootDir;

    if (!fs.existsSync(target)) {
      throw new ToolError(`Path not found: ${input.path ?? '.'}`);
    }

    const regex = new RegExp(input.pattern, 'i');
    const matches: string[] = [];
    const maxMatches = 50;

    function searchFile(filePath: string) {
      if (matches.length >= maxMatches) return;
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const relPath = path.relative(ctx.rootDir, filePath).replace(/\\/g, '/');

        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i]!)) {
            matches.push(`${relPath}:${i + 1}: ${lines[i]?.trim()}`);
            if (matches.length >= maxMatches) return;
          }
        }
      } catch {
        // 忽略非文本或读取错误
      }
    }

    function walk(dirPath: string) {
      if (matches.length >= maxMatches) return;
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
          continue;
        }
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else {
          searchFile(fullPath);
        }
      }
    }

    const stat = fs.statSync(target);
    if (stat.isFile()) {
      searchFile(target);
    } else {
      walk(target);
    }

    return matches.length > 0 ? matches.join('\n') : 'No matches found.';
  },
});

function simpleMatch(str: string, pattern: string): boolean {
  if (pattern === '*' || pattern === '**') return true;
  const escaped = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '.*')
    .replace(/(?<!\.)\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`, 'i').test(str);
}

export const builtinTools = [readFileTool, writeFileTool, editFileTool, globTool, grepTool];
