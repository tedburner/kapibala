import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadInstructions } from '../src/instructions/index.js';

describe('AGENTS.md instruction loader', () => {
  const dirs: string[] = [];
  const temp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-instructions-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads user, root, then nested instructions in stable order', () => {
    const root = temp();
    const nested = path.join(root, 'src');
    fs.mkdirSync(nested);
    const user = path.join(root, 'user-AGENTS.md');
    fs.writeFileSync(user, 'user');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'root');
    fs.writeFileSync(path.join(nested, 'AGENTS.md'), 'nested');
    expect(
      loadInstructions({ projectRoot: root, cwd: nested, userFile: user }).sources.map(
        (source) => source.content,
      ),
    ).toEqual(['user', 'root', 'nested']);
  });

  it('rejects oversized and symlinked instruction files without partial content', () => {
    const root = temp();
    const file = path.join(root, 'AGENTS.md');
    fs.writeFileSync(file, 'x'.repeat(32 * 1024 + 1));
    expect(() =>
      loadInstructions({ projectRoot: root, cwd: root, userFile: path.join(root, 'missing') }),
    ).toThrow(/AGENTS.md.*32 KiB/);
    fs.unlinkSync(file);
    // 无 symlink 权限的 Windows 机器上 symlinkSync 可能静默产出非链接条目，此时跳过该断言。
    let linked = false;
    try {
      fs.symlinkSync(path.join(root, 'target.md'), file);
      linked = fs.lstatSync(file).isSymbolicLink();
    } catch {
      linked = false;
    }
    if (!linked) return;
    expect(() =>
      loadInstructions({ projectRoot: root, cwd: root, userFile: path.join(root, 'missing') }),
    ).toThrow(/symbolic link/i);
  });

  it('rejects working directories outside the project root', () => {
    const root = temp();
    expect(() =>
      loadInstructions({
        projectRoot: root,
        cwd: os.tmpdir(),
        userFile: path.join(root, 'missing'),
      }),
    ).toThrow(/outside/i);
  });

  it('deduplicates when userFile and project AGENTS.md refer to the same file', () => {
    const root = temp();
    const agentsFile = path.join(root, 'AGENTS.md');
    fs.writeFileSync(agentsFile, 'shared-content');
    const result = loadInstructions({
      projectRoot: root,
      cwd: root,
      userFile: agentsFile,
    });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.content).toBe('shared-content');
  });
});
