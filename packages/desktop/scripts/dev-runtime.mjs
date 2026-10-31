import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * macOS 菜单栏与 Dock 取应用包名称，而不是 Electron 的 app.setName。
 * 为开发启动创建独立的签名副本；不修改 pnpm 缓存或依赖，其他平台沿用原运行时。
 * 缓存按运行时身份隔离，并通过临时目录发布，避免中途失败留下可启动的不完整副本。
 */
export function developmentExecutable(executable, cacheRoot, platform = process.platform) {
  if (platform !== 'darwin') return executable;
  const source = path.resolve(executable, '../../..');
  if (path.basename(source) !== 'Electron.app') throw new Error('ELECTRON_APP_REQUIRED');
  const plist = path.join(source, 'Contents/Info.plist');
  const stat = fs.statSync(executable);
  const identity = createHash('sha256')
    .update(fs.realpathSync.native(executable))
    .update(fs.readFileSync(plist))
    .update(`${stat.size}:${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 20);
  const target = path.join(cacheRoot, identity);
  const bundle = path.join(target, 'Kapibala.app');
  const result = path.join(bundle, 'Contents/MacOS/Electron');
  if (fs.existsSync(result)) return result;
  fs.mkdirSync(cacheRoot, { recursive: true });
  const staging = path.join(cacheRoot, `.building-${randomUUID()}`);
  try {
    fs.mkdirSync(staging);
    const copy = path.join(staging, 'Kapibala.app');
    // macOS clonefile 优先复用底层数据，避免每次开发启动复制 250 MB。
    execFileSync('/bin/cp', ['-cR', source, copy]);
    const info = path.join(copy, 'Contents/Info.plist');
    for (const key of ['CFBundleName', 'CFBundleDisplayName'])
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} Kapibala`, info]);
    // 修改 Info.plist 会使外层签名失效；只重签副本的外层，保留框架和辅助进程原签名。
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', copy], { stdio: 'pipe' });
    try {
      fs.renameSync(staging, target);
    } catch (error) {
      // 并发启动时另一个进程可能已经完成同一版本；只接受完整的目标。
      if (!fs.existsSync(result)) throw error;
    }
    return result;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
