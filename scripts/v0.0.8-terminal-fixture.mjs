import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 仅验证终端适配和进程生命周期；这里的模拟操作不充当 Core 工具事务验收。
const directory = path.resolve(process.argv[2] ?? '');
assert(process.stdin.isTTY && process.stdout.isTTY, 'fixture requires a real TTY');
const load = (relative) => import(pathToFileURL(path.join(directory, relative)).href);
const React = (await load('node_modules/react/index.js')).default;
const { render, Box, Text, useInput } = await load('node_modules/ink/build/index.js');
const { TerminalInputStream } = await load('build/input-stream.js');
const { TerminalModeGuard } = await load('build/terminal.js');
const originalRaw = Boolean(process.stdin.isRaw);
const guard = new TerminalModeGuard({ input: process.stdin, output: process.stdout });
let update = () => {};
let phase = 'idle';
let operation;
let settle;
let closing = false;
let renderer;
let pasteCount = 0;
const input = new TerminalInputStream(process.stdin, {
  onPaste: () => {
    pasteCount++;
    update();
  },
  onDiscard: () => update(),
});
function interrupt() {
  if (phase !== 'running') return;
  phase = 'cancelling';
  update();
  // 故意延迟清理，验证取消时不能提前卸载终端。
  setTimeout(() => {
    phase = 'idle';
    settle();
    operation = undefined;
    update();
  }, 100);
}
async function close(code = 0) {
  if (closing) return;
  closing = true;
  interrupt();
  await operation;
  renderer.unmount();
  await renderer.waitUntilExit();
  renderer.cleanup();
  input.destroy();
  guard.restore();
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', onTerminate);
  clearTimeout(deadline);
  assert.equal(Boolean(process.stdin.isRaw), originalRaw);
  assert.equal(process.stdin.listenerCount('readable'), 0);
  process.exitCode = code;
  process.stdout.write(
    `ADMISSION_CLOSED ${JSON.stringify({ phase, pasteCount, restoredRaw: originalRaw })}\n`,
  );
}
const onTerminate = () => void close(143);
function Probe() {
  const [, refresh] = React.useReducer((value) => value + 1, 0);
  update = refresh;
  useInput((text, key) => {
    if (closing) return;
    if (key.ctrl && text === 'c') interrupt();
    else if (text === 'r' && !operation) {
      phase = 'running';
      operation = new Promise((resolve) => {
        settle = resolve;
      });
      update();
    } else if (text === 'q') void close();
    else if (text === 'f')
      setImmediate(() => {
        throw new Error('ADMISSION_FATAL');
      });
  });
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Text, null, 'Kapibala admission 中文 e\u0301 🦫'),
    React.createElement(Text, null, `phase=${phase} paste=${pasteCount}`),
    React.createElement(
      Text,
      null,
      'r=start, Ctrl+C=cancel, q=close, f=fatal; paste never invokes keys',
    ),
  );
}
process.on('SIGINT', interrupt);
process.on('SIGTERM', onTerminate);
guard.enter();
guard.enableBracketedPaste();
try {
  renderer = render(React.createElement(Probe), {
    stdin: input,
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: 30,
  });
} catch (error) {
  input.destroy();
  guard.restore();
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', onTerminate);
  throw error;
}
const deadline = setTimeout(() => void close(124), 120_000);
