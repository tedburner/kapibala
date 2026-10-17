import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

// 编辑/光标/缩放准入原型，不连接真实用户设置、模型、命令或工具。
const directory = path.resolve(process.argv[2] ?? '');
const load = (relative) => import(pathToFileURL(path.join(directory, relative)).href);
const React = (await load('node_modules/react/index.js')).default;
const { render, Box, Text, useInput, useCursor } = await load('node_modules/ink/build/index.js');
const measure = (await load('node_modules/string-width/index.js')).default;
const { TerminalEditor, layoutEditor } = await load('build/editor.js');
const { TerminalInputStream } = await load('build/input-stream.js');
const { TerminalModeGuard } = await load('build/terminal.js');
const interactive = process.argv.includes('--interactive');
const editor = new TerminalEditor();
const messages = Array.from({ length: 100 }, (_, index) => `message ${index} 中文`);
let scroll = 0;
let refresh = () => {};
let latestView;
let closing = false;
let terminal;
const pause = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

class Input extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(value) {
    this.isRaw = value;
  }
  ref() {}
  unref() {}
}
const source = interactive ? process.stdin : new Input();
let output = process.stdout;
if (!interactive) {
  const xterm = await load('node_modules/@xterm/headless/lib-headless/xterm-headless.js');
  terminal = new xterm.default.Terminal({ cols: 40, rows: 12, allowProposedApi: true });
  output = new Writable({
    write(chunk, _encoding, next) {
      terminal.write(chunk.toString(), next);
    },
  });
  Object.assign(output, { isTTY: true, columns: 40, rows: 12 });
}
const input = new TerminalInputStream(source, {
  onPaste: (text) => {
    editor.insert(text);
    refresh();
  },
});
const guard = new TerminalModeGuard({
  input: source,
  output,
  writeSync: (text) => output.write(text),
});
async function close() {
  if (closing) return;
  closing = true;
  app.unmount();
  await app.waitUntilExit();
  app.cleanup();
  input.destroy();
  guard.restore();
  source.off('end', close);
  process.off('SIGTERM', close);
  if (interactive) {
    process.stdout.write(
      `EDITOR_ADMISSION_CLOSED ${JSON.stringify({
        draftLength: editor.snapshot().text.length,
        cursor: editor.snapshot().cursor,
        logicalLines: editor.snapshot().text.split('\n').length,
        columns: output.columns,
        rows: output.rows,
        scroll,
      })}\n`,
    );
  }
}

function Probe() {
  const [, update] = React.useReducer((value) => value + 1, 0);
  const [inputReady, setInputReady] = React.useState(false);
  refresh = update;
  React.useEffect(() => {
    output.on('resize', update);
    return () => output.off('resize', update);
  }, []);
  useInput((text, key) => {
    if (key.ctrl && text === 'c') {
      void close();
      return;
    }
    if (key.pageUp) scroll = Math.min(messages.length - 1, scroll + 5);
    else if (key.pageDown) scroll = Math.max(0, scroll - 5);
    else if (key.leftArrow) editor.move(-1);
    else if (key.rightArrow) editor.move(1);
    else if (key.backspace) editor.backspace();
    else if (key.delete) editor.deleteForward();
    else if (key.home) editor.lineStart();
    else if (key.end) editor.lineEnd();
    else if (key.upArrow) editor.historyPrevious();
    else if (key.downArrow) editor.historyNext();
    else if (key.return && key.shift) editor.insert('\n');
    else if (key.return) {
      messages.push(editor.submit());
      scroll = 0;
    } else if (!key.ctrl && !key.meta && text) editor.insert(text);
    update();
  });
  React.useEffect(() => {
    setInputReady(true);
  }, []);
  const columns = output.columns;
  // Ink 6.8 全高输出不附换行，useCursor 却按换行后的锚点回移，导致 Y 偏一行。
  // 保留一个底部物理行，让 Ink 使用普通换行锚点，不叠加另一套 ANSI 光标写屏。
  const rows = Math.max(1, output.rows - 1);
  const reserved = rows >= 3 ? 2 : 0;
  const view = layoutEditor(
    editor.snapshot(),
    Math.max(1, columns - 2),
    Math.min(5, rows - reserved),
    measure,
  );
  const messageHeight = Math.max(0, rows - reserved - view.lines.length);
  const end = Math.max(0, messages.length - scroll);
  const visible = messages.slice(Math.max(0, end - messageHeight), end);
  while (visible.length < messageHeight) visible.unshift('');
  const { setCursorPosition } = useCursor();
  const cursor = {
    x: Math.min(columns - 1, 2 + view.cursor.column),
    y: (reserved ? 1 : 0) + messageHeight + view.cursor.row,
  };
  setCursorPosition(cursor);
  latestView = { cursor, view, visible, columns, rows };
  const children = [];
  if (reserved)
    children.push(
      React.createElement(Text, { key: 'title', wrap: 'truncate' }, 'Kapibala editor admission'),
    );
  if (messageHeight)
    children.push(
      React.createElement(
        Box,
        { key: 'messages', height: messageHeight, overflow: 'hidden' },
        React.createElement(Text, { wrap: 'truncate' }, visible.join('\n')),
      ),
    );
  children.push(
    React.createElement(Text, { key: 'editor' }, view.lines.map((line) => `> ${line}`).join('\n')),
  );
  if (reserved)
    children.push(
      React.createElement(
        Text,
        { key: 'footer', wrap: 'truncate' },
        `scroll=${scroll} ready=${inputReady} Shift+Enter=newline Ctrl+C=exit`,
      ),
    );
  return React.createElement(
    Box,
    { flexDirection: 'column', width: columns, height: rows },
    ...children,
  );
}

source.on('end', close);
process.on('SIGTERM', close);
guard.enter();
guard.enableBracketedPaste();
const app = render(React.createElement(Probe), {
  stdin: input,
  stdout: output,
  stderr: output,
  exitOnCtrlC: false,
  patchConsole: false,
  maxFps: 30,
});
await pause();
if (!interactive) {
  async function flush() {
    await pause();
    await new Promise((resolve) => terminal.write('', resolve));
  }
  async function send(text) {
    source.write(text);
    await flush();
  }
  function checkCursor() {
    assert.equal(terminal.buffer.active.cursorX, latestView.cursor.x, 'physical cursor X');
    assert.equal(terminal.buffer.active.cursorY, latestView.cursor.y, 'physical cursor Y');
  }
  try {
    await send('中文e\u0301');
    checkCursor();
    await send('\x1b[D');
    checkCursor();
    assert.equal(editor.snapshot().cursor, 2);
    assert.equal(latestView.cursor.x, 6);
    await send('\x1b[200~F:\\Project\\kapibala\r\n/exit\x03\x1b[201~');
    assert.equal(messages.length, 100, 'paste must not submit');
    assert(editor.snapshot().text.includes('F:\\Project\\kapibala\n/exit\x03'));
    checkCursor();
    source.write('\x1b');
    await pause(10);
    source.write('[13;');
    await pause(10);
    source.write('2u');
    await flush();
    checkCursor();
    assert(editor.snapshot().text.includes('\x03\n'));
    const before = [...latestView.visible];
    await send('\x1b[5~');
    assert.notDeepEqual(latestView.visible, before);
    const scrolled = [...latestView.visible];
    messages.push('new background message');
    scroll++;
    refresh();
    await flush();
    assert.equal(scroll, 6, 'new output must retain the visible historical anchor');
    assert.deepEqual(latestView.visible, scrolled, 'new output changed the browsed history');
    for (const [columns, rows] of [
      [20, 8],
      [80, 70],
      [12, 6],
      [40, 12],
    ]) {
      terminal.resize(columns, rows);
      Object.assign(output, { columns, rows });
      output.emit('resize');
      await flush();
      checkCursor();
      assert(latestView.view.lines.length + (rows >= 3 ? 2 : 0) <= rows);
      if (rows === 70)
        assert(latestView.visible.length > 30, 'tall viewport must retain visible messages');
    }
    process.stdout.write(
      `${JSON.stringify({
        node: process.version,
        platform: process.platform,
        checks:
          'Chinese/combining/multiline/paste/fragmented-shift-enter/cursor/scroll/resize passed',
        actualIme: 'not exercised; run --interactive with target IME',
        sizes: 4,
      })}\n`,
    );
  } finally {
    await close();
    terminal.dispose();
  }
}
