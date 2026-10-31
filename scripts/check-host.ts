import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 在隔离进程检查 Node 宿主入口；禁止导入时创建资源、启动进程、访问终端或注册监听。 */
export function checkHostArtifact(
  root = fileURLToPath(new URL('../packages/cli/', import.meta.url)),
): void {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const entry = manifest.exports?.['./host'];
  if (!entry?.types || !entry?.import)
    throw new Error('Host requires independent import/types exports');
  const target = path.resolve(root, entry.import);
  const source = fs.readFileSync(target, 'utf8');
  if (!fs.existsSync(path.resolve(root, entry.types))) throw new Error('Missing host declarations');
  if (/^#!/m.test(source) || /node:readline|setRawMode|runInteractiveHost/.test(source))
    throw new Error('Host artifact includes terminal or CLI startup code');
  const probe = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const stdout = process.stdout.write.bind(process.stdout);
    const fail = () => { throw new Error('Host import side effect'); };
    for (const method of ['writeFileSync', 'mkdirSync', 'appendFileSync', 'renameSync', 'unlinkSync']) fs[method] = fail;
    for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[method] = fail;
    process.stdout.write = process.stderr.write = fail;
    process.stdin.on = process.stdin.addListener = process.stdin.resume = fail;
    syncBuiltinESMExports();
    const listeners = () => JSON.stringify(process.eventNames().map(name => [String(name), process.listenerCount(name)]).sort());
    const before = listeners();
    const host = await import(${JSON.stringify(pathToFileURL(target).href)});
    assert.equal(typeof host.createManagedSession, 'function');
    assert.equal(typeof host.mutateGlobalSettings, 'function');
    assert.equal(host.createManagedSessionResources, undefined);
    assert.equal(host.saveGlobalSettings, undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(listeners(), before);
    stdout('Host artifact import passed\\n');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0 || result.stderr || result.stdout !== 'Host artifact import passed\n')
    throw new Error(
      `Host artifact import failed: ${result.error ?? result.stderr ?? result.stdout}`,
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkHostArtifact();
  console.log('Node host artifact and import boundary passed');
}
