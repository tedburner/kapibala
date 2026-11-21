import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countLineDiff } from '../src/capabilities/tools/builtin/file-diff.js';
import {
  builtinTools,
  editFileTool,
  globTool,
  grepTool,
  readFileTool,
  writeFileTool,
} from '../src/capabilities/tools/builtin/fs.js';
import { ToolRegistry } from '../src/capabilities/tools/registry.js';
import { ToolError } from '../src/errors/index.js';

/**
 * 内置 fs 工具的端到端行为测试。
 *
 * 沙箱的"越界拒绝"已由 sandbox.test.ts 覆盖，这里只关心工具本身的语义：
 * 真实读写、行区间、精确替换的唯一性约束、遍历剪枝与结果上限。
 */
describe('builtin fs tools', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-tools-test-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  describe('read_file', () => {
    it('拒绝超长单行，即使目标行在后面', async () => {
      fs.writeFileSync(path.join(rootDir, 'long-line.txt'), `${'x'.repeat(600_000)}\ntarget`);
      await expect(
        readFileTool.execute({ path: 'long-line.txt', startLine: 2, endLine: 2 }, { rootDir }),
      ).rejects.toThrow(/line.*limit/i);
    });
    it('应能读取已存在的文件全文', async () => {
      fs.writeFileSync(path.join(rootDir, 'a.txt'), 'hello\nworld');
      await expect(readFileTool.execute({ path: 'a.txt' }, { rootDir })).resolves.toBe(
        'hello\nworld',
      );
    });

    it('应按 1-based 闭区间返回指定行', async () => {
      fs.writeFileSync(path.join(rootDir, 'a.txt'), 'l1\nl2\nl3\nl4');
      await expect(
        readFileTool.execute({ path: 'a.txt', startLine: 2, endLine: 3 }, { rootDir }),
      ).resolves.toBe('l2\nl3');
    });

    it('endLine 超出总行数时应截断而不报错', async () => {
      fs.writeFileSync(path.join(rootDir, 'a.txt'), 'l1\nl2');
      await expect(
        readFileTool.execute({ path: 'a.txt', startLine: 1, endLine: 99 }, { rootDir }),
      ).resolves.toBe('l1\nl2');
    });

    it('文件不存在时应抛 ToolError', async () => {
      await expect(readFileTool.execute({ path: 'nope.txt' }, { rootDir })).rejects.toThrow(
        ToolError,
      );
    });

    it('目标为目录时应抛 ToolError 而不是返回内容', async () => {
      fs.mkdirSync(path.join(rootDir, 'sub'));
      await expect(readFileTool.execute({ path: 'sub' }, { rootDir })).rejects.toThrow(ToolError);
    });

    it('大文件指定行区间时应流式读取所需片段', async () => {
      const lineCount = 270_000;
      fs.writeFileSync(path.join(rootDir, 'large.txt'), `${'x\n'.repeat(lineCount)}target`);

      await expect(
        readFileTool.execute(
          { path: 'large.txt', startLine: lineCount + 1, endLine: lineCount + 1 },
          { rootDir },
        ),
      ).resolves.toBe('target');
    });
  });

  describe('write_file', () => {
    it('应新建文件并写入内容', async () => {
      await writeFileTool.execute({ path: 'new.txt', content: 'abc' }, { rootDir });
      expect(fs.readFileSync(path.join(rootDir, 'new.txt'), 'utf-8')).toBe('abc');
    });

    it('父目录不存在时应自动递归创建', async () => {
      await writeFileTool.execute({ path: 'deep/nested/x.txt', content: 'y' }, { rootDir });
      expect(fs.existsSync(path.join(rootDir, 'deep', 'nested', 'x.txt'))).toBe(true);
    });

    it('写入已存在文件时应整体覆盖而非追加', async () => {
      fs.writeFileSync(path.join(rootDir, 'a.txt'), 'old-content-longer');
      await writeFileTool.execute({ path: 'a.txt', content: 'new' }, { rootDir });
      expect(fs.readFileSync(path.join(rootDir, 'a.txt'), 'utf-8')).toBe('new');
    });

    it('返回值应带上写入字节数', async () => {
      const result = await writeFileTool.execute({ path: 'a.txt', content: '中文' }, { rootDir });
      // '中文' 为 6 字节(UTF-8)，若按字符数统计会得到 2
      expect(result.content).toContain('6 bytes');
    });

    it('新建文件应记录 +行数 −0 的行数事实', async () => {
      const result = await writeFileTool.execute(
        { path: 'new.txt', content: 'a\nb\nc\n' },
        { rootDir },
      );
      expect(result.diff).toEqual({ additions: 3, deletions: 0 });
      expect(writeFileTool.toExecutionResult!(result).execution?.facts?.diff).toEqual({
        additions: 3,
        deletions: 0,
      });
    });

    it('覆盖已有文件应按真实差分统计增删', async () => {
      fs.writeFileSync(path.join(rootDir, 'a.txt'), 'keep\nold\nkeep2');
      const result = await writeFileTool.execute(
        { path: 'a.txt', content: 'keep\nnew\nkeep2' },
        { rootDir },
      );
      expect(result.diff).toEqual({ additions: 1, deletions: 1 });
    });

    it('写入内容与旧内容相同时记 0/0，不伪造变更', async () => {
      fs.writeFileSync(path.join(rootDir, 'a.txt'), 'same');
      const result = await writeFileTool.execute({ path: 'a.txt', content: 'same' }, { rootDir });
      expect(result.diff).toEqual({ additions: 0, deletions: 0 });
    });
  });

  describe('edit_file', () => {
    it('拒绝空目标文本，避免意外插入内容', async () => {
      fs.writeFileSync(path.join(rootDir, 'a.txt'), 'x');
      await expect(
        editFileTool.execute(
          { path: 'a.txt', targetContent: '', replacementContent: 'prefix' },
          { rootDir },
        ),
      ).rejects.toThrow(/empty/i);
      expect(fs.readFileSync(path.join(rootDir, 'a.txt'), 'utf-8')).toBe('x');
    });
    it('应精确替换唯一目标片段', async () => {
      fs.writeFileSync(path.join(rootDir, 'a.txt'), 'const a = 1;\nconst b = 2;');
      await editFileTool.execute(
        { path: 'a.txt', targetContent: 'const a = 1;', replacementContent: 'const a = 9;' },
        { rootDir },
      );
      expect(fs.readFileSync(path.join(rootDir, 'a.txt'), 'utf-8')).toBe(
        'const a = 9;\nconst b = 2;',
      );
    });

    it('目标片段不存在时应抛 ToolError 且不改动文件', async () => {
      fs.writeFileSync(path.join(rootDir, 'a.txt'), 'original');
      await expect(
        editFileTool.execute(
          { path: 'a.txt', targetContent: 'missing', replacementContent: 'x' },
          { rootDir },
        ),
      ).rejects.toThrow(ToolError);
      expect(fs.readFileSync(path.join(rootDir, 'a.txt'), 'utf-8')).toBe('original');
    });

    it('目标片段出现多次时应拒绝，避免误改', async () => {
      fs.writeFileSync(path.join(rootDir, 'a.txt'), 'dup\ndup\n');
      await expect(
        editFileTool.execute(
          { path: 'a.txt', targetContent: 'dup', replacementContent: 'x' },
          { rootDir },
        ),
      ).rejects.toThrow(/occurs 2 times/);
      expect(fs.readFileSync(path.join(rootDir, 'a.txt'), 'utf-8')).toBe('dup\ndup\n');
    });

    it('文件不存在时应抛 ToolError', async () => {
      await expect(
        editFileTool.execute(
          { path: 'nope.txt', targetContent: 'a', replacementContent: 'b' },
          { rootDir },
        ),
      ).rejects.toThrow(ToolError);
    });

    it('精确替换应记录单行增删事实', async () => {
      fs.writeFileSync(path.join(rootDir, 'a.txt'), 'const a = 1;\nconst b = 2;');
      const result = await editFileTool.execute(
        { path: 'a.txt', targetContent: 'const a = 1;', replacementContent: 'const a = 9;' },
        { rootDir },
      );
      expect(result.diff).toEqual({ additions: 1, deletions: 1 });
      expect(editFileTool.toExecutionResult!(result).execution?.facts?.diff).toEqual({
        additions: 1,
        deletions: 1,
      });
    });

    it('替换为多行时应按新增行数统计', async () => {
      fs.writeFileSync(path.join(rootDir, 'a.txt'), 'head\nold\ntail');
      const result = await editFileTool.execute(
        { path: 'a.txt', targetContent: 'old', replacementContent: 'new1\nnew2\nnew3' },
        { rootDir },
      );
      expect(result.diff).toEqual({ additions: 3, deletions: 1 });
    });
  });

  describe('glob', () => {
    beforeEach(() => {
      fs.mkdirSync(path.join(rootDir, 'src', 'nested'), { recursive: true });
      fs.mkdirSync(path.join(rootDir, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(rootDir, 'src', 'a.ts'), '');
      fs.writeFileSync(path.join(rootDir, 'src', 'nested', 'b.ts'), '');
      fs.writeFileSync(path.join(rootDir, 'README.md'), '');
      fs.writeFileSync(path.join(rootDir, 'node_modules', 'dep.ts'), '');
    });

    it('应按扩展名匹配并递归子目录', async () => {
      const result = await globTool.execute({ pattern: '*.ts' }, { rootDir });
      expect(result).toContain('src/a.ts');
      expect(result).toContain('src/nested/b.ts');
      expect(result).not.toContain('README.md');
    });

    it('应剪枝 node_modules', async () => {
      const result = await globTool.execute({ pattern: '*.ts' }, { rootDir });
      expect(result).not.toContain('node_modules');
    });

    it('subDirectory 应把搜索范围限制在子目录内', async () => {
      const result = await globTool.execute({ pattern: '*.ts', subDirectory: 'src' }, { rootDir });
      expect(result).toContain('src/a.ts');
      expect(result).not.toContain('README.md');
    });

    it('无匹配时应返回提示文案而非空串', async () => {
      await expect(globTool.execute({ pattern: '*.zzz' }, { rootDir })).resolves.toBe(
        'No matching files found.',
      );
    });
  });

  describe('grep', () => {
    it('跳过未命中的超长行并继续返回后续匹配', async () => {
      fs.writeFileSync(
        path.join(rootDir, 'src', 'long-line.txt'),
        `${'x'.repeat(600_000)}\nneedle on next line`,
      );
      await expect(grepTool.execute({ pattern: 'needle' }, { rootDir })).resolves.toContain(
        'src/long-line.txt:2: needle on next line',
      );
    });

    it('拒绝返回超长的匹配行', async () => {
      fs.writeFileSync(path.join(rootDir, 'src', 'long-line.txt'), `needle${'x'.repeat(600_000)}`);
      await expect(grepTool.execute({ pattern: 'needle' }, { rootDir })).rejects.toThrow(
        /line.*limit/i,
      );
    });

    it('超长行尾部命中时仍拒绝返回该行', async () => {
      fs.writeFileSync(path.join(rootDir, 'src', 'long-line.txt'), `${'x'.repeat(600_000)}needle`);
      await expect(grepTool.execute({ pattern: 'needle' }, { rootDir })).rejects.toThrow(
        /line.*limit/i,
      );
    });

    it('递归搜索不读取指向工作区外部的符号链接文件', async (testContext) => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-grep-outside-'));
      try {
        const outsideFile = path.join(outsideDir, 'secret.txt');
        fs.writeFileSync(outsideFile, 'outside-secret-marker');
        try {
          fs.symlinkSync(outsideFile, path.join(rootDir, 'src', 'linked.txt'));
        } catch (error: unknown) {
          if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
            testContext.skip();
            return;
          }
          throw error;
        }
        if (!fs.lstatSync(path.join(rootDir, 'src', 'linked.txt')).isSymbolicLink()) {
          testContext.skip();
          return;
        }
        const result = await grepTool.execute({ pattern: 'outside-secret-marker' }, { rootDir });
        expect(result).toBe('No matches found.');
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });
    beforeEach(() => {
      fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(rootDir, 'src', 'a.ts'),
        'const alpha = 1;\nconst Beta = 2;\nconst gamma = 3;',
      );
      fs.writeFileSync(path.join(rootDir, 'README.md'), 'no match here');
    });

    it('应返回 相对路径:行号: 内容 的命中行', async () => {
      const result = await grepTool.execute({ pattern: 'alpha' }, { rootDir });
      expect(result).toBe('src/a.ts:1: const alpha = 1;');
    });

    it('应忽略大小写', async () => {
      const result = await grepTool.execute({ pattern: 'beta' }, { rootDir });
      expect(result).toContain('src/a.ts:2');
    });

    it('path 指向单个文件时应只搜该文件', async () => {
      const result = await grepTool.execute({ pattern: 'match', path: 'README.md' }, { rootDir });
      expect(result).toBe('README.md:1: no match here');
    });

    it('无命中时应返回提示文案', async () => {
      await expect(grepTool.execute({ pattern: 'zzzz' }, { rootDir })).resolves.toBe(
        'No matches found.',
      );
    });

    it('将正则元字符作为普通文本搜索，不执行用户可控正则', async () => {
      fs.writeFileSync(path.join(rootDir, 'src', 'regex.txt'), 'literal pattern: (a+)+$');
      const result = await grepTool.execute({ pattern: '(a+)+$' }, { rootDir });
      expect(result).toBe('src/regex.txt:1: literal pattern: (a+)+$');
    });

    it('拒绝空搜索文本，避免无意匹配每一行', async () => {
      await expect(grepTool.execute({ pattern: '   ' }, { rootDir })).rejects.toThrow(
        /must not be empty/i,
      );
    });

    it('在调用前已取消时立即终止搜索', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        grepTool.execute({ pattern: 'alpha' }, { rootDir, signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('路径不存在时应抛 ToolError', async () => {
      await expect(
        grepTool.execute({ pattern: 'a', path: 'missing' }, { rootDir }),
      ).rejects.toThrow(ToolError);
    });
  });

  describe('countLineDiff', () => {
    it('相同文本记 0/0', () => {
      expect(countLineDiff('a\nb', 'a\nb')).toEqual({ additions: 0, deletions: 0 });
    });

    it('只在末尾追加时按新增行计数', () => {
      expect(countLineDiff('a', 'a\nb\nc')).toEqual({ additions: 2, deletions: 0 });
    });

    it('删除中间行时按删除行计数', () => {
      expect(countLineDiff('a\nb\nc\nd', 'a\nd')).toEqual({ additions: 0, deletions: 2 });
    });

    it('多处分散修改按 LCS 统计，不把未变行算进变更', () => {
      expect(countLineDiff('1\n2\n3\n4\n5', '1\nX\n3\nY\n5')).toEqual({
        additions: 2,
        deletions: 2,
      });
    });

    it('中段超出 LCS 预算时只标记截断，不返回猜测数字', () => {
      const before = Array.from({ length: 2100 }, (_, index) => `a-${index}`).join('\n');
      const after = Array.from({ length: 2100 }, (_, index) => `b-${index}`).join('\n');
      expect(countLineDiff(before, after)).toEqual({ truncated: true });
    });

    it('前后文本合计超出字节预算时标记截断', () => {
      expect(countLineDiff('x'.repeat(6 * 1024 * 1024), 'y'.repeat(6 * 1024 * 1024))).toEqual({
        truncated: true,
      });
    });
  });

  describe('注册表装配', () => {
    it('builtinTools 应导出 6 个工具且名称无重复', () => {
      expect(builtinTools).toHaveLength(6);
      const names = builtinTools.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toEqual(['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'todo_write']);
    });

    it('每个工具都应声明 minimal 契约：name/description/parameters/execute', () => {
      for (const tool of builtinTools) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.parameters).toMatchObject({ type: 'object' });
        expect(typeof tool.execute).toBe('function');
      }
    });

    it('应能整体注册进 ToolRegistry 并产出 6 条 definitions', () => {
      const registry = new ToolRegistry();
      registry.registerSource('builtin', builtinTools);
      expect(registry.list()).toHaveLength(6);
      expect(registry.definitions()).toHaveLength(6);
      expect(registry.resolve('read_file').name).toBe('read_file');
    });

    it('权限声明应与读写语义一致', () => {
      const readOnly = ['read_file', 'glob', 'grep', 'todo_write'];
      const writable = ['write_file', 'edit_file'];
      for (const tool of builtinTools) {
        const expected = readOnly.includes(tool.name)
          ? ['fs:read']
          : writable.includes(tool.name)
            ? ['fs:write']
            : null;
        expect(expected).not.toBeNull();
        expect(tool.metadata?.permissions).toEqual(expected);
      }
    });
  });
});
