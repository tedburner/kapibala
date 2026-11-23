import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { enumerateWorkspaceFiles } from '../src/agent-host/workspace-files.js';
import { rankFileMatches } from '../src/renderer/file-completion.js';

describe('工作区文件枚举（@ 文件补全数据源）', () => {
  it('广度优先：预算被大子树吃满时，根目录文件仍先入列，不再被饿死', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-files-'));
    try {
      // 大子树恰好塞满预算；根目录文件按旧深度优先实现可能排在它之后而被截断。
      fs.mkdirSync(path.join(root, 'big'));
      for (let index = 0; index < 60; index += 1) {
        fs.writeFileSync(path.join(root, 'big', `file-${index}.txt`), '');
      }
      fs.writeFileSync(path.join(root, 'update-all.sh'), '');
      const result = enumerateWorkspaceFiles(root, { maxFiles: 60, maxDepth: 16 });
      expect(result.files[0]).toBe('update-all.sh');
      expect(result.truncated).toBe(true);
      expect(result.files).toHaveLength(60);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('逐层排序：枚举顺序跨平台确定，忽略目录与点开头目录跳过', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-files-'));
    try {
      fs.writeFileSync(path.join(root, 'b.txt'), '');
      fs.writeFileSync(path.join(root, 'a.txt'), '');
      fs.mkdirSync(path.join(root, 'node_modules'));
      fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), '');
      fs.mkdirSync(path.join(root, '.hidden'));
      fs.writeFileSync(path.join(root, '.hidden', 'y.js'), '');
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'src', 'demo.ts'), '');
      const result = enumerateWorkspaceFiles(root, { maxFiles: 100, maxDepth: 16 });
      expect(result.files).toEqual(['a.txt', 'b.txt', path.join('src', 'demo.ts')]);
      expect(result.truncated).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('深度预算：目录未展开完时明示截断', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-files-'));
    try {
      fs.writeFileSync(path.join(root, 'root.txt'), '');
      fs.mkdirSync(path.join(root, 'a'));
      fs.writeFileSync(path.join(root, 'a', 'deep.txt'), '');
      const result = enumerateWorkspaceFiles(root, { maxFiles: 100, maxDepth: 0 });
      expect(result.files).toEqual(['root.txt']);
      expect(result.truncated).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('@ 文件补全排序', () => {
  const files = [
    'ARTEX/selfupdate/bootstrap.go',
    'ARTEX/selfupdate/github.go',
    'ARTEX/selfupdate/selfupdate.go',
    'ARTEX/selfupdate/selfupdate_test.go',
    'ARTEX/selfupdate/stage.go',
    'ARTEX/server/update.go',
    'ARTEX/server/update_test.go',
    'ARTEX/update.sh',
    // 清单里还有更多「update」命中：旧实现按清单顺序截 8 条，目标文件永远进不了面板。
    'ARTEX/client/update_cache.go',
    'docs/update-notes.md',
    'update-all.sh',
    'tools/update_all.py',
  ];

  it('文件名前缀命中排在最前：update-all.sh 不被深层同名片段挤出前 8', () => {
    const items = rankFileMatches(files, 'update').map((item) => item.label);
    expect(items[0]).toBe('update-all.sh');
    expect(items).toHaveLength(8);
    // 文件名前缀（update.sh / update-all.sh / update_cache.go）在文件名包含（update.go）之前；
    // 仅路径包含（selfupdate、github.go）垫底，进不了前 8。
    expect(items.indexOf('ARTEX/update.sh')).toBeLessThan(items.indexOf('ARTEX/server/update.go'));
    expect(items).not.toContain('ARTEX/selfupdate/bootstrap.go');
    expect(items).not.toContain('ARTEX/selfupdate/github.go');
    expect(items).toContain('ARTEX/server/update.go');
  });

  it('空前缀按更短路径优先；limit 只影响条数不影响排序', () => {
    const items = rankFileMatches(files, '', 3).map((item) => item.label);
    expect(items).toHaveLength(3);
    expect(items[0]).toBe('update-all.sh');
    expect(items[1]).toBe('ARTEX/update.sh');
  });
});
