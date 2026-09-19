import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolError } from '../src/errors/index.js';
import {
  builtinTools,
  editFileTool,
  globTool,
  grepTool,
  readFileTool,
  writeFileTool,
} from '../src/tools/builtin/fs.js';
import { ToolRegistry } from '../src/tools/registry.js';

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
      expect(result).toContain('6 bytes');
    });
  });

  describe('edit_file', () => {
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

  describe('注册表装配', () => {
    it('builtinTools 应导出 5 个工具且名称无重复', () => {
      expect(builtinTools).toHaveLength(5);
      const names = builtinTools.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toEqual(['read_file', 'write_file', 'edit_file', 'glob', 'grep']);
    });

    it('每个工具都应声明 minimal 契约：name/description/parameters/execute', () => {
      for (const tool of builtinTools) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.parameters).toMatchObject({ type: 'object' });
        expect(typeof tool.execute).toBe('function');
      }
    });

    it('应能整体注册进 ToolRegistry 并产出 5 条 definitions', () => {
      const registry = new ToolRegistry();
      registry.registerSource('builtin', builtinTools);
      expect(registry.list()).toHaveLength(5);
      expect(registry.definitions()).toHaveLength(5);
      expect(registry.resolve('read_file').name).toBe('read_file');
    });

    it('权限声明应与读写语义一致', () => {
      const readOnly = ['read_file', 'glob', 'grep'];
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
