import { describe, expect, it } from 'vitest';
import { TerminalEditor, layoutEditor } from '../src/tui/editor.js';

const measure = (text: string) =>
  [...text].reduce((sum, ch) => sum + (ch === '中' || ch === '文' ? 2 : 1), 0);

describe('terminal multiline editor', () => {
  it('moves and deletes complete graphemes without breaking emoji or combining characters', () => {
    const editor = new TerminalEditor();
    editor.insert('中e\u0301👨‍👩‍👧‍👦');
    editor.backspace();
    expect(editor.snapshot()).toEqual({ text: '中e\u0301', cursor: 3 });
    editor.move(-1);
    expect(editor.snapshot().cursor).toBe(1);
    editor.deleteForward();
    expect(editor.snapshot()).toEqual({ text: '中', cursor: 1 });
    editor.move(-1);
    editor.move(-1);
    editor.backspace();
    expect(editor.snapshot()).toEqual({ text: '中', cursor: 0 });
  });

  it('normalizes pasted CRLF without submitting and preserves Windows paths', () => {
    const editor = new TerminalEditor();
    editor.insert('F:\\Project\\kapibala\r\n/exit\r1\x03');
    expect(editor.snapshot().text).toBe('F:\\Project\\kapibala\n/exit\n1\x03');
    expect(editor.historyPrevious()).toBe(false);
    expect(editor.submit()).toBe('F:\\Project\\kapibala\n/exit\n1\x03');
    expect(editor.snapshot()).toEqual({ text: '', cursor: 0 });
  });

  it('retains an unfinished draft when navigating submitted input history', () => {
    const editor = new TerminalEditor();
    editor.insert('one');
    editor.submit();
    editor.insert('two\nlines');
    editor.submit();
    editor.insert('draft');
    editor.move(-1);
    expect(editor.historyPrevious()).toBe(true);
    expect(editor.snapshot().text).toBe('two\nlines');
    editor.historyPrevious();
    expect(editor.snapshot().text).toBe('one');
    editor.historyNext();
    editor.historyNext();
    expect(editor.snapshot()).toEqual({ text: 'draft', cursor: 4 });
    expect(editor.historyNext()).toBe(false);
  });

  it('moves within logical lines and clamps offsets at grapheme boundaries', () => {
    const editor = new TerminalEditor();
    editor.replace({ text: '中e\u0301\nabc', cursor: 2 });
    expect(editor.snapshot().cursor).toBe(1);
    editor.lineEnd();
    expect(editor.snapshot().cursor).toBe(3);
    editor.lineStart();
    expect(editor.snapshot().cursor).toBe(0);
    editor.lineEnd();
    editor.insert('\n');
    expect(editor.snapshot().text).toBe('中e\u0301\n\nabc');
  });

  it('wraps wide input before the physical edge and keeps the caret in the visible row window', () => {
    const editor = new TerminalEditor();
    editor.insert('中文abc\nsecond\nthird');
    const view = layoutEditor(editor.snapshot(), 6, 2, measure);
    expect(view.lines).toHaveLength(2);
    expect(view.totalRows).toBeGreaterThan(2);
    expect(view.cursor.row).toBe(1);
    expect(view.cursor.column).toBeLessThan(6);
    expect(view.firstRow).toBe(view.totalRows - 2);
    editor.replace({ text: '中文', cursor: 1 });
    expect(layoutEditor(editor.snapshot(), 4, 3, measure).cursor).toEqual({ row: 0, column: 2 });
    expect(layoutEditor({ text: '中文', cursor: 1 }, 2, 3, measure).cursor).toEqual({
      row: 1,
      column: 0,
    });
  });

  it('renders pasted terminal controls visibly without sending escape or BEL to output', () => {
    const view = layoutEditor({ text: 'a\x1b[2J\x07b', cursor: 8 }, 30, 3, measure);
    expect(view.lines.join('\n')).not.toContain('\x1b');
    expect(view.lines.join('\n')).not.toContain('\x07');
    expect(view.lines.join('\n')).toContain('␛[2J␇b');
  });

  it('keeps the caret legal when deletion merges graphemes or a wide character wraps', () => {
    const editor = new TerminalEditor();
    editor.replace({ text: 'e\n\u0301', cursor: 2 });
    editor.backspace();
    expect(editor.snapshot()).toEqual({ text: 'e\u0301', cursor: 2 });
    expect(layoutEditor({ text: 'a中', cursor: 1 }, 2, 3, measure).cursor).toEqual({
      row: 1,
      column: 0,
    });
    editor.replace({ text: '\nabc', cursor: 0 });
    editor.lineStart();
    expect(editor.snapshot().cursor).toBe(0);
  });

  it('maps restored CRLF source offsets into the normalized draft', () => {
    const editor = new TerminalEditor();
    editor.replace({ text: 'ab\r\nc', cursor: 4 });
    expect(editor.snapshot()).toEqual({ text: 'ab\nc', cursor: 3 });
  });

  it('makes C1 and directional controls inspectable while preserving the original draft', () => {
    const editor = new TerminalEditor();
    editor.insert('a\u009b2J\u202eb');
    const view = layoutEditor(editor.snapshot(), 80, 3, measure);
    expect(view.lines.join('')).toBe('a\\u009b2J\\u202eb');
    expect(editor.snapshot().text).toBe('a\u009b2J\u202eb');
  });
});
