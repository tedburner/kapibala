import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as settingsModule from '../src/settings.js';

const homes: string[] = [];
function home() {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-transaction-'));
  homes.push(result);
  return result;
}
afterEach(() => {
  for (const item of homes.splice(0)) fs.rmSync(item, { recursive: true, force: true });
});

describe('全局配置短事务', () => {
  it('锁内重读并保留其它写者已提交字段，不物化内置目录', () => {
    const homeDir = home();
    settingsModule.mutateGlobalSettings(
      (draft) => {
        draft.trustedProjects = ['/first'];
      },
      { homeDir },
    );
    settingsModule.mutateGlobalSettings(
      (draft) => {
        draft.modelRouting = { fast: 'custom' };
      },
      { homeDir },
    );
    const raw = settingsModule.loadGlobalSettingsForWrite({ homeDir });
    expect(raw.trustedProjects).toEqual(['/first']);
    expect(raw.modelRouting).toEqual({ fast: 'custom' });
    expect(raw.profiles).toEqual([]);
  });
  it('竞争立即失败，不根据陈旧 PID 或时间抢锁；只释放自己的锁', () => {
    const homeDir = home();
    let lock = '';
    settingsModule.mutateGlobalSettings(
      () => {
        lock = `${settingsModule.getGlobalSettingsPath(homeDir)}.lock`;
        expect(() => settingsModule.mutateGlobalSettings(() => {}, { homeDir })).toThrowError(
          /SETTINGS_BUSY/,
        );
        const replacement = JSON.stringify({ owner: 'external-owner', pid: -1 });
        fs.writeFileSync(lock, replacement);
      },
      { homeDir },
    );
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).owner).toBe('external-owner');
    expect(() => settingsModule.mutateGlobalSettings(() => {}, { homeDir })).toThrowError(
      /SETTINGS_BUSY/,
    );
  });
  it('异常、异步回调和损坏文件不覆盖旧值，锁可重用', () => {
    const homeDir = home();
    const file = settingsModule.getGlobalSettingsPath(homeDir);
    settingsModule.mutateGlobalSettings(() => {}, { homeDir });
    const original = fs.readFileSync(file, 'utf8');
    expect(() =>
      settingsModule.mutateGlobalSettings(
        () => {
          throw new Error('cancel');
        },
        { homeDir },
      ),
    ).toThrow('cancel');
    expect(() => settingsModule.mutateGlobalSettings(async () => {}, { homeDir })).toThrow(/同步/);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    fs.writeFileSync(file, '{broken');
    expect(() => settingsModule.mutateGlobalSettings(() => {}, { homeDir })).toThrow(
      /无法安全读取/,
    );
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });
  it('独立进程使用同一全局锁，竞争写入不覆盖已提交信任字段', async () => {
    const homeDir = home();
    const ready = path.join(homeDir, 'ready');
    // 子进程经 tsx 直接导入源码入口：verify 的 test 阶段可能先于构建执行，dist 产物既可能缺失
    // 也可能是旧实现编译出的陈旧版本；导入源码保证本用例与父进程测的是同一份当前实现。
    const entry = pathToFileURL(fileURLToPath(new URL('../src/settings.ts', import.meta.url))).href;
    const script = `import fs from 'node:fs'; import { mutateGlobalSettings } from ${JSON.stringify(entry)}; mutateGlobalSettings(draft => { draft.trustedProjects = ['/writer']; fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); }, { homeDir: ${JSON.stringify(homeDir)} });`;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const ended = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    try {
      // tsx 加载器冷启动有开销，就绪等待窗口放宽到 4s，避免慢机器上误判子进程失败。
      for (let i = 0; i < 400 && !fs.existsSync(ready); i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fs.existsSync(ready), stderr).toBe(true);
      expect(() => settingsModule.mutateGlobalSettings(() => {}, { homeDir })).toThrow(
        /SETTINGS_BUSY/,
      );
      expect(await ended, stderr).toBe(0);
      settingsModule.mutateGlobalSettings(
        (draft) => {
          draft.modelRouting = { fast: 'next' };
        },
        { homeDir },
      );
      expect(settingsModule.loadGlobalSettingsForWrite({ homeDir })).toMatchObject({
        trustedProjects: ['/writer'],
        modelRouting: { fast: 'next' },
      });
    } finally {
      child.kill();
      await ended;
    }
  });
});
