import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

// 准入使用隔离安装目录，避免在候选通过前给产品清单增加依赖。
const directory = process.argv[2];
assert(directory, 'usage: node scripts/v0.0.8-terminal-admission.mjs <isolated-directory>');
if (process.argv.includes('--ci')) process.env.CI = 'true';
const modules = path.resolve(directory, 'node_modules');
const load = (name, file) => import(pathToFileURL(path.join(modules, name, file)).href);
const React = (await load('react', 'index.js')).default;
const { render, Text, useInput } = await load('ink', 'build/index.js');
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

class Input extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(value) {
    this.isRaw = value;
  }
  ref() {}
  unref() {}
}

const source = new Input();
const adapterDirectory = process.argv[3];
const pasted = [];
const adapter = adapterDirectory
  ? await import(pathToFileURL(path.resolve(adapterDirectory, 'input-stream.js')).href)
  : undefined;
const input = adapter
  ? new adapter.TerminalInputStream(source, { onPaste: (text) => pasted.push(text) })
  : source;
const chunks = [];
const output = new Writable({
  write(chunk, _encoding, next) {
    chunks.push(chunk.toString());
    next();
  },
});
Object.assign(output, { isTTY: true, columns: 80, rows: 24 });
const keys = [];
function Probe({ revision = -1 }) {
  useInput((text, key) => keys.push({ text, key }));
  return React.createElement(
    Text,
    null,
    `Kapibala 中文 e\u0301 terminal admission frame=${revision}`,
  );
}

const originalConsole = console.log;
const app = render(React.createElement(Probe), {
  stdin: input,
  stdout: output,
  stderr: output,
  exitOnCtrlC: false,
  patchConsole: false,
  maxFps: 30,
});
await pause(60);
assert.equal(console.log, originalConsole, 'console must remain unpatched');
assert.equal(input.listenerCount('readable'), 1, 'exactly one raw reader');
if (adapter) assert.equal(source.listenerCount('readable'), 1, 'one physical input reader');
assert.equal(input.isRaw, true);

async function sample(parts) {
  keys.length = 0;
  for (const part of parts) {
    source.write(part);
    await pause();
  }
  return structuredClone(keys);
}

const ctrlC = await sample(['\x03', '继续']);
assert(ctrlC.some(({ text, key }) => text === 'c' && key.ctrl));
assert(
  ctrlC.some(({ text }) => text === '继续'),
  'Ctrl+C must leave renderer usable',
);
const completeCsi = await sample(['\x1b[13;2u']);
const fragmentedCsi = await sample(['\x1b', '[13;', '2u']);
const paste = await sample(['\x1b[200~', '/exit\r\n中文', '\x03', '\x1b[201~']);
if (adapter) {
  assert.equal(fragmentedCsi.length, 1, 'fragmented combination must dispatch once');
  assert.equal(fragmentedCsi[0].key.return, true);
  assert.equal(fragmentedCsi[0].key.shift, true);
  assert.deepEqual(paste, [], 'paste must never reach keyboard or approval shortcuts');
  assert.deepEqual(pasted, ['/exit\r\n中文\x03']);
}
const initialWrites = chunks.length;
const burstStart = performance.now();
for (let revision = 0; revision < 90; revision++) {
  app.rerender(React.createElement(Probe, { revision }));
  await pause(2);
}
await pause(80);
const burstMs = performance.now() - burstStart;
const frameWrites = chunks.slice(initialWrites).filter((chunk) => chunk.includes('frame=')).length;
assert(
  frameWrites <= Math.ceil((burstMs * 30) / 1000) + 2,
  'actual writes exceed frame admission budget',
);
app.unmount();
await app.waitUntilExit();
app.cleanup();
assert.equal(input.isRaw, false);
assert.equal(input.listenerCount('readable'), 0);
assert.equal(source.listenerCount('readable'), 0);
if (adapter) input.destroy();
assert(chunks.join('').includes('Kapibala 中文'), 'actual rendered output missing');
assert(chunks.join('').includes('frame=89'), 'last update lost by throttling');
let syncDepth = 0;
let syncFrames = 0;
for (const sequence of chunks.join('').split('\x1b[?2026').slice(1)) {
  if (sequence.startsWith('h')) {
    assert.equal(syncDepth, 0, 'nested synchronized output wrapper');
    syncDepth++;
    syncFrames++;
  } else if (sequence.startsWith('l')) {
    assert.equal(syncDepth, 1, 'unpaired synchronized output end');
    syncDepth--;
  }
}
assert.equal(syncDepth, 0, 'unterminated synchronized output');
if (process.argv.includes('--ci')) assert.equal(syncFrames, 0, 'CI must use unsynchronized output');

const packages = [];
async function scanModules(current) {
  let entries;
  try {
    entries = await readdir(current);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const names = entry.startsWith('@')
      ? (await readdir(path.join(current, entry))).map((name) => `${entry}/${name}`)
      : [entry];
    for (const name of names) {
      const location = path.join(current, name);
      try {
        const manifest = JSON.parse(await readFile(path.join(location, 'package.json'), 'utf8'));
        packages.push({
          name: manifest.name,
          version: manifest.version,
          node: manifest.engines?.node,
          location: path.relative(modules, location).split(path.sep).join('/'),
        });
        await scanModules(path.join(location, 'node_modules'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}
await scanModules(modules);
const report = {
  node: process.version,
  platform: process.platform,
  adapted: Boolean(adapter),
  assertions: 'render/import/raw-owner/console/ctrl-c/unmount passed',
  painting: { frameWrites, burstMs, syncFrames, ci: process.argv.includes('--ci') },
  completeCsi,
  fragmentedCsi,
  paste,
  pasted,
  packages,
};
if (process.argv[4]) await writeFile(process.argv[4], `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
