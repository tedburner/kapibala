/** 普通聊天草稿快照；cursor 为 UTF-16 边界，秘密问答不得使用此历史模型。 */
export interface EditorSnapshot {
  text: string;
  cursor: number;
}

/** 终端可见输入窗口；坐标只属于 TUI，不进入跨端 ViewModel 或 canonical。 */
export interface EditorLayout {
  lines: readonly string[];
  cursor: { row: number; column: number };
  firstRow: number;
  totalRows: number;
}

const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const normalize = (text: string) => text.replace(/\r\n?/g, '\n');

function boundaries(text: string): number[] {
  return [...segmenter.segment(text)].map((part) => part.index).concat(text.length);
}

/** 普通输入的多行编辑与有界历史；只保存明确提交的聊天，不自动执行粘贴或命令。 */
export class TerminalEditor {
  private value: EditorSnapshot = { text: '', cursor: 0 };
  private history: string[] = [];
  private historyIndex = 0;
  private unfinished: EditorSnapshot | undefined;

  /** 返回独立快照，调用方修改返回值不能绕过光标的 grapheme 边界约束。 */
  snapshot(): EditorSnapshot {
    return { ...this.value };
  }

  /** 恢复普通草稿并把光标向前夹到合法字符簇边界，不用于恢复秘密值。 */
  replace(value: EditorSnapshot): void {
    const text = normalize(value.text);
    const requested = normalize(value.text.slice(0, Math.max(0, value.cursor))).length;
    const cursor =
      boundaries(text)
        .filter((offset) => offset <= requested)
        .at(-1) ?? 0;
    this.value = { text, cursor };
  }

  /** 插入已提交的终端文字或整个粘贴，统一换行且从不触发发送/审批。 */
  insert(text: string): void {
    const normalized = normalize(text);
    const { text: previous, cursor } = this.value;
    const next = previous.slice(0, cursor) + normalized + previous.slice(cursor);
    // 新输入可能把相邻码点组合为同一个字簇，光标不能停在其内部。
    const target = cursor + normalized.length;
    this.value = {
      text: next,
      cursor: boundaries(next).find((offset) => offset >= target) ?? next.length,
    };
  }

  /** 按完整字簇左右移动，家庭 emoji、组合重音和代理对均不拆开。 */
  move(direction: -1 | 1): void {
    const offsets = boundaries(this.value.text);
    const index = offsets.indexOf(this.value.cursor);
    this.value.cursor = offsets[Math.max(0, Math.min(offsets.length - 1, index + direction))];
  }

  /** 删除光标前完整字簇；处于输入开头时保持草稿。 */
  backspace(): void {
    const end = this.value.cursor;
    if (end === 0) return;
    this.move(-1);
    this.value.text = this.value.text.slice(0, this.value.cursor) + this.value.text.slice(end);
    this.value.cursor =
      boundaries(this.value.text).find((offset) => offset >= this.value.cursor) ??
      this.value.text.length;
  }

  /** 删除光标后完整字簇，不改变前面的文字和光标位置。 */
  deleteForward(): void {
    const start = this.value.cursor;
    this.move(1);
    const end = this.value.cursor;
    this.value = {
      text: this.value.text.slice(0, start) + this.value.text.slice(end),
      cursor: start,
    };
    this.value.cursor =
      boundaries(this.value.text).find((offset) => offset >= start) ?? this.value.text.length;
  }

  /** Home 移到当前逻辑行开头；不把屏幕折行误当作源文本换行。 */
  lineStart(): void {
    this.value.cursor =
      this.value.cursor === 0 ? 0 : this.value.text.lastIndexOf('\n', this.value.cursor - 1) + 1;
  }

  /** End 移到当前逻辑行结尾，保留其他行和后续草稿。 */
  lineEnd(): void {
    const end = this.value.text.indexOf('\n', this.value.cursor);
    this.value.cursor = end < 0 ? this.value.text.length : end;
  }

  /** 显式提交才加入最多 100 条普通输入历史；空白与连续重复项不增加历史。 */
  submit(): string {
    const text = this.value.text;
    if (text.trim() && this.history.at(-1) !== text) this.history.push(text);
    this.history = this.history.slice(-100);
    this.historyIndex = this.history.length;
    this.unfinished = undefined;
    this.value = { text: '', cursor: 0 };
    return text;
  }

  /** 浏览较早的已提交输入；首次浏览先保留当前未提交草稿及光标。 */
  historyPrevious(): boolean {
    if (this.historyIndex <= 0) return false;
    if (this.historyIndex === this.history.length) this.unfinished = this.snapshot();
    const text = this.history[--this.historyIndex];
    this.value = { text, cursor: text.length };
    return true;
  }

  /** 浏览较新的历史；越过最新项时恢复此前未提交草稿而非丢弃它。 */
  historyNext(): boolean {
    if (this.historyIndex >= this.history.length) return false;
    this.historyIndex++;
    if (this.historyIndex === this.history.length)
      this.value = this.unfinished ?? { text: '', cursor: 0 };
    else {
      const text = this.history[this.historyIndex];
      this.value = { text, cursor: text.length };
    }
    return true;
  }
}

/**
 * 将普通输入按宿主提供的真实终端字簇宽度换行，返回包含光标的有限行窗口。
 * 控制字符显示为控制图形，不能直接写屏；原始草稿保持完整。宽度函数必须与渲染器一致，
 * 不使用 String.length 估算中文/emoji 列宽。极窄屏容不下的单字簇仅在显示时用替代符。
 */
export function layoutEditor(
  snapshot: EditorSnapshot,
  columns: number,
  maxRows: number,
  measure: (text: string) => number,
): EditorLayout {
  const width = Math.max(1, Math.floor(columns));
  const height = Math.max(1, Math.floor(maxRows));
  const rows = [''];
  let column = 0;
  let caret = { row: 0, column: 0 };
  for (const part of segmenter.segment(snapshot.text)) {
    if (part.segment === '\n') {
      if (part.index === snapshot.cursor) {
        caret =
          column === width ? { row: rows.length, column: 0 } : { row: rows.length - 1, column };
      }
      rows.push('');
      column = 0;
      continue;
    }
    let visible = [...part.segment]
      .map((char) => {
        const code = char.codePointAt(0) ?? 0;
        if (char === '\t') return '  ';
        if (code < 32) return String.fromCodePoint(0x2400 + code);
        if (code === 127) return '␡';
        if (
          (code >= 128 && code <= 159) ||
          (code >= 0x202a && code <= 0x202e) ||
          (code >= 0x2066 && code <= 0x2069) ||
          code === 0x200e ||
          code === 0x200f
        ) {
          return `\\u${code.toString(16).padStart(4, '0')}`;
        }
        return char;
      })
      .join('');
    let cells = Math.max(0, measure(visible));
    if (cells > width) {
      visible = '�';
      cells = 1;
    }
    if (column + cells > width || column === width) {
      rows.push('');
      column = 0;
    }
    if (part.index === snapshot.cursor) caret = { row: rows.length - 1, column };
    rows[rows.length - 1] += visible;
    column += cells;
  }
  if (snapshot.cursor >= snapshot.text.length) {
    caret = column === width ? { row: rows.length, column: 0 } : { row: rows.length - 1, column };
  }
  if (caret.row >= rows.length) rows.push('');
  const firstRow = Math.max(0, Math.min(caret.row - height + 1, rows.length - height));
  return {
    lines: rows.slice(firstRow, firstRow + height),
    cursor: { row: caret.row - firstRow, column: caret.column },
    firstRow,
    totalRows: rows.length,
  };
}
