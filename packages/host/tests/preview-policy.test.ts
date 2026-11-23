import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createArtifactPolicy, resolveWriteArtifact } from '../src/host/preview-policy.js';

// 只写最小 PNG 字节序（不是有效图片）：产物识别只看扩展名、存在与常规文件，不解码内容。
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function makeRoots(): { base: string; workspace: string; home: string; temp: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-artifact-'));
  const workspace = path.join(base, 'workspace');
  const home = path.join(base, 'home');
  const temp = path.join(base, 'temp');
  for (const dir of [workspace, home, temp]) fs.mkdirSync(dir, { recursive: true });
  return { base, workspace, home, temp };
}

const roots = makeRoots();
const options = {
  workspaceRoot: roots.workspace,
  homeDirectory: roots.home,
  tempRoot: roots.temp,
};

afterAll(() => fs.rmSync(roots.base, { recursive: true, force: true }));

describe('preview artifact policy', () => {
  it('projects a successful write_file bitmap with host-observed facts', () => {
    const target = path.join(roots.workspace, 'chart.png');
    fs.writeFileSync(target, PNG_BYTES);
    const policy = createArtifactPolicy(options);
    const artifacts = policy('write_file', { path: 'chart.png', content: 'x' }, true);
    expect(artifacts).toEqual([
      {
        kind: 'image',
        path: fs.realpathSync.native(target),
        ext: 'png',
        size: PNG_BYTES.byteLength,
      },
    ]);
  });

  it('accepts an absolute path inside the workspace and a file under the OS temp root', () => {
    const workspaceTarget = path.join(roots.workspace, 'absolute.JPG');
    fs.writeFileSync(workspaceTarget, PNG_BYTES);
    const tempTarget = path.join(roots.temp, 'temp.webp');
    fs.writeFileSync(tempTarget, PNG_BYTES);
    const policy = createArtifactPolicy(options);
    expect(policy('write_file', { path: workspaceTarget }, true)?.[0]?.ext).toBe('jpg');
    expect(policy('write_file', { path: tempTarget }, true)?.[0]?.ext).toBe('webp');
  });

  it('projects a successful SVG write with the same read-only facts as bitmaps', () => {
    const target = path.join(roots.workspace, 'icon.svg');
    const content = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4" /></svg>';
    fs.writeFileSync(target, content);
    const policy = createArtifactPolicy(options);
    expect(policy('write_file', { path: 'icon.svg' }, true)).toEqual([
      {
        kind: 'image',
        path: fs.realpathSync.native(target),
        ext: 'svg',
        size: Buffer.byteLength(content),
      },
    ]);
  });

  it('skips failed terminal states, non-write tools and non-image extensions', () => {
    const policy = createArtifactPolicy(options);
    expect(policy('write_file', { path: 'chart.png' }, false)).toBeUndefined();
    expect(policy('edit_file', { path: 'chart.png' }, true)).toBeUndefined();
    expect(policy('run_command', { path: 'chart.png' }, true)).toBeUndefined();
    expect(policy('write_file', { path: 'notes.md' }, true)).toBeUndefined();
  });

  it('separates path_not_allowed from file_not_found', () => {
    const outside = path.join(roots.home, 'outside.png');
    fs.writeFileSync(outside, PNG_BYTES);
    expect(resolveWriteArtifact(options, { path: outside })).toEqual({
      ok: false,
      code: 'path_not_allowed',
    });
    expect(resolveWriteArtifact(options, { path: 'missing.png' })).toEqual({
      ok: false,
      code: 'file_not_found',
    });
  });

  it('rejects the whole ~/.kapibala root even when the workspace contains the home', () => {
    const nested = {
      workspaceRoot: roots.base,
      homeDirectory: roots.home,
      tempRoot: roots.temp,
    };
    const settings = path.join(roots.home, '.kapibala', 'settings.png');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, PNG_BYTES);
    expect(resolveWriteArtifact(nested, { path: settings })).toEqual({
      ok: false,
      code: 'path_not_allowed',
    });
  });

  it('rejects directories and non-image extensions', () => {
    fs.mkdirSync(path.join(roots.workspace, 'folder.png'));
    expect(resolveWriteArtifact(options, { path: 'folder.png' })).toEqual({
      ok: false,
      code: 'not_file',
    });
    expect(resolveWriteArtifact(options, { path: 'notes.md' })).toEqual({
      ok: false,
      code: 'not_image',
    });
  });

  it('returns file_not_found for an empty or missing path without touching the disk', () => {
    expect(resolveWriteArtifact(options, { path: '' })).toEqual({
      ok: false,
      code: 'file_not_found',
    });
    expect(resolveWriteArtifact(options, {})).toEqual({ ok: false, code: 'file_not_found' });
  });
});
