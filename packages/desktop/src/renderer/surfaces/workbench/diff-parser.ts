import type { ViewFileDiff } from '@kiturone/kapibala-host/view-model';

/**
 * Unified Git Patch 纯函数解析器与并排（Split）行对齐模型。
 *
 * 架构边界：
 * - 0 React / DOM / Node 依赖，既可由 `DiffTab` 直接渲染，也可在纯 Node 单测中静态加载校验；
 * - 仅消费宿主已施加 256 KiB 单文件上限的 `ViewFileDiff.patch` 文本，不执行全量字符级 Myers 二次差分以避免阻塞主线程。
 */

/** 单条 Diff 行语义分类：`meta` 表示 `\ No newline at end of file` 等非源码注释行。 */
export type DiffLineKind = 'context' | 'add' | 'del' | 'meta';

/** 解析后的单行 Unified Diff 记录，双侧行号缺失时以 `null` 显式表达。 */
export interface ParsedDiffRow {
  readonly id: string;
  readonly kind: DiffLineKind;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly sign: ' ' | '+' | '-' | '\\';
  readonly content: string;
}

/** 单个 `@@ -oldStart,oldCount +newStart,newCount @@` 块结构。 */
export interface ParsedDiffHunk {
  readonly id: string;
  readonly header: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly sectionHint?: string;
  readonly rows: readonly ParsedDiffRow[];
}

/** 并排对比（Split View）单行左右配对槽位；单侧空缺时为 `null`。 */
export interface SplitDiffPair {
  readonly id: string;
  readonly left: ParsedDiffRow | null;
  readonly right: ParsedDiffRow | null;
}

/** 文件变更状态徽标展示元数据。 */
export interface DiffStatusBadgeMeta {
  readonly label: '新增' | '修改' | '删除' | '重命名' | '二进制';
  readonly tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
}

const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;

/**
 * 解析 `ViewFileDiff` 的状态徽标文案与色调；二进制文件优先展示 `二进制` 以提示不可展开文本对比。
 */
export function resolveDiffStatusBadge(
  file: Pick<ViewFileDiff, 'status' | 'binary'>,
): DiffStatusBadgeMeta {
  if (file.binary) {
    return { label: '二进制', tone: 'neutral' };
  }
  switch (file.status) {
    case 'added':
      return { label: '新增', tone: 'success' };
    case 'deleted':
      return { label: '删除', tone: 'danger' };
    case 'renamed':
      return { label: '重命名', tone: 'info' };
    default:
      return { label: '修改', tone: 'warning' };
  }
}

/**
 * 将标准 Unified Git Patch 字符串解析为带精确新旧行号的 `ParsedDiffHunk` 数组。
 *
 * 边界处理：
 * - 自动忽略首个 `@@` 块之前的 `diff --git`、`index`、`---`、`+++` 文件头；
 * - 兼容单行省略计数的块头（如 `@@ -1 +1 @@`，缺省计数按 `1` 处理）及空文件 `0,0` 块头；
 * - 剥离行尾 `\r` 以防止 Windows CRLF 补丁在 `<pre>` 内渲染多余折行符号。
 */
export function parseUnifiedDiffPatch(patch: string): readonly ParsedDiffHunk[] {
  if (!patch.trim()) return [];
  const rawLines = patch.split('\n');
  if (rawLines.at(-1) === '') {
    rawLines.pop();
  }

  const hunks: ParsedDiffHunk[] = [];
  let currentHunk: {
    id: string;
    header: string;
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    sectionHint?: string;
    rows: ParsedDiffRow[];
  } | null = null;
  let oldCursor = 0;
  let newCursor = 0;

  for (let i = 0; i < rawLines.length; i += 1) {
    const line = (rawLines[i] ?? '').replace(/\r$/, '');
    const headerMatch = HUNK_HEADER_RE.exec(line);
    if (headerMatch) {
      const oldStart = Number(headerMatch[1]);
      const oldCount = headerMatch[2] !== undefined ? Number(headerMatch[2]) : 1;
      const newStart = Number(headerMatch[3]);
      const newCount = headerMatch[4] !== undefined ? Number(headerMatch[4]) : 1;
      const hint = headerMatch[5]?.trim();
      currentHunk = {
        id: `hunk-${hunks.length + 1}`,
        header: line,
        oldStart,
        oldCount,
        newStart,
        newCount,
        ...(hint ? { sectionHint: hint } : {}),
        rows: [],
      };
      hunks.push(currentHunk);
      oldCursor = oldStart;
      newCursor = newStart;
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    const rowId = `${currentHunk.id}:r${currentHunk.rows.length + 1}`;
    const prefix = line[0];
    if (prefix === '+') {
      currentHunk.rows.push({
        id: rowId,
        kind: 'add',
        oldLine: null,
        newLine: newCursor,
        sign: '+',
        content: line.slice(1),
      });
      newCursor += 1;
    } else if (prefix === '-') {
      currentHunk.rows.push({
        id: rowId,
        kind: 'del',
        oldLine: oldCursor,
        newLine: null,
        sign: '-',
        content: line.slice(1),
      });
      oldCursor += 1;
    } else if (prefix === '\\') {
      currentHunk.rows.push({
        id: rowId,
        kind: 'meta',
        oldLine: null,
        newLine: null,
        sign: '\\',
        content: line.slice(1).trimStart(),
      });
    } else {
      const content = prefix === ' ' ? line.slice(1) : line;
      currentHunk.rows.push({
        id: rowId,
        kind: 'context',
        oldLine: oldCursor,
        newLine: newCursor,
        sign: ' ',
        content,
      });
      oldCursor += 1;
      newCursor += 1;
    }
  }

  return hunks;
}

/**
 * 将单个 `ParsedDiffHunk` 转换为左右并排（Split）对齐行数组：
 * 连续删除段与紧邻的新增段按序一一配对展示，上下文行在左右两侧同步对齐。
 */
export function buildSplitDiffRows(hunk: ParsedDiffHunk): readonly SplitDiffPair[] {
  const pairs: SplitDiffPair[] = [];
  let pendingDels: ParsedDiffRow[] = [];
  let pendingAdds: ParsedDiffRow[] = [];

  const flushChanges = () => {
    const maxLen = Math.max(pendingDels.length, pendingAdds.length);
    for (let idx = 0; idx < maxLen; idx += 1) {
      const left = pendingDels[idx] ?? null;
      const right = pendingAdds[idx] ?? null;
      pairs.push({
        id: `${hunk.id}:pair-${pairs.length + 1}`,
        left,
        right,
      });
    }
    pendingDels = [];
    pendingAdds = [];
  };

  for (const row of hunk.rows) {
    if (row.kind === 'del') {
      if (pendingAdds.length > 0) {
        flushChanges();
      }
      pendingDels.push(row);
    } else if (row.kind === 'add') {
      pendingAdds.push(row);
    } else {
      flushChanges();
      pairs.push({
        id: `${hunk.id}:pair-${pairs.length + 1}`,
        left: row,
        right: row.kind === 'meta' ? null : row,
      });
    }
  }
  flushChanges();

  return pairs;
}
