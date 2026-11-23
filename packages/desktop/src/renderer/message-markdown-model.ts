import { HTML_PREVIEW_LIMIT } from './html-preview-model.js';

/** LaTeX 显式语法标记：反斜杠命令、上下标或分组括号命中即视为数学意图。 */
const LATEX_MARKER = /[\\^_{}]/;

/** 显式 LaTeX 反斜杠命令（如 `\text`、`\mathrm`）：含中日韩字符时必须有显式命令才算公式。 */
const EXPLICIT_LATEX_COMMAND = /\\[a-zA-Z]+/;

/** 数学算符（含常用 Unicode 数学符号）：用于区分含空格的数学表达式与多词自然语言。 */
const MATH_OPERATOR = /[=+\-*/<>()[\]|~,]|[≈≤≥≠±×÷→←↑↓↔∀∃∈∉⊂⊆∪∩∑∏∫√∞°′″πΠα-ωΑ-Ω∇∂]/u;

/** 中日韩文字、假名、谚文与全角标点：未包裹在 `\text{...}` 等命令中时视为自然语言或货币文案。 */
const NATURAL_LANGUAGE =
  /[\u2e80-\u9fff\u3000-\u303f\u3040-\u30ff\uac00-\ud7af\uff01-\uff60\uffe0-\uffe6]/;

/** 紧凑价格或数值区间前缀（如 `$5-$10`、`$10~$20` 中的 `5-`）。 */
const COMPACT_CURRENCY_PREFIX = /^(?:\d[\d,]*(?:\.\d+)?|\.\d+)[+\-*/~]$/;

/** 紧跟在第二个 `$` 后的金额起始字符。 */
const CURRENCY_AMOUNT_START = /^(?:\d|\.\d)/;

/** Shell 环境变量拼接或枚举前缀（如 `$HOME/$USER`、`$OPENAI_API_KEY,$ANTHROPIC_API_KEY`）。 */
const SHELL_VAR_PAIR_PREFIX = /^[A-Z_][A-Z0-9_]*(?:[/:,;|&]+|\s+[/:,;|&]*)$/;

/** 代码围栏起始/闭合行匹配（最多 3 个前导空格 + 至少 3 个反引号或波浪号）。 */
const MARKDOWN_FENCE = /^(?: {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * 判断单美元符 `$...$` 内部文本是否具备行内数学公式特征。
 *
 * 约束与边界：
 * - 首尾不得含空白、不得跨行（遵循 Pandoc / GitHub 单美元公式紧贴规则，`$ 5 $` 不算公式）；
 * - 出现中日韩文字或全角标点时，必须包含 `\text{...}` 等显式反斜杠命令才放行，防止 `$OPENAI_API_KEY、$ANTHROPIC_API_KEY`
 *   因内部下划线触发 KaTeX 双重下标解析错误；
 * - 含 `\`、`^`、`_`、`{}` 等 LaTeX 记号直接放行；
 * - 含空格但没有任何数学算符（如 `5 and 10`）判为多词自然语言而非公式。
 */
export function looksLikeInlineMath(content: string): boolean {
  if (!content || content !== content.trim() || /[\r\n]/.test(content)) return false;
  if (NATURAL_LANGUAGE.test(content)) return EXPLICIT_LATEX_COMMAND.test(content);
  if (LATEX_MARKER.test(content)) return true;
  if (/\s/.test(content) && !MATH_OPERATOR.test(content)) return false;
  return true;
}

/**
 * 将模型常见的 `\( ... \)` 与 `\[ ... \]` 分隔符转换为 `remark-math` 识别的 `$...$` / `$$...$$`。
 *
 * 只改写渲染副本，调用方复制原文仍取消息块的原始文本；围栏代码块、缩进代码行、行内反引号与已有
 * 美元公式优先匹配并原样保留，未闭合的流式代码围栏同样受保护，避免把代码里的正则转义误当成公式。
 */
export function normalizeMathDelimiters(text: string): string {
  if (!text.includes('\\(') && !text.includes('\\[')) return text;
  const fence =
    /^(?: {0,3})(`{3,})[^`\n]*\n[\s\S]*?(?:^ {0,3}\1`*[ \t]*(?=\r?$)|(?![\s\S]))|^(?: {0,3})(~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\2~*[ \t]*(?=\r?$)|(?![\s\S]))/;
  const protectedOrMath =
    /^(?: {4}|\t)[^\n]*|(`+)[\s\S]*?\3(?!`)|(?<!\\)\$\$(?!\$)[\s\S]*?(?<!\\)\$\$(?!\$)|(?<!\\)\$(?!\$)[^\n$]+?(?<!\\)\$(?!\$)|\\\\|\\\(([^\n]*?)\\\)|\\\[([\s\S]*?)\\\]/;
  const tokens = new RegExp(`${fence.source}|${protectedOrMath.source}`, 'gm');
  return text.replace(
    tokens,
    (
      match: string,
      _backtickFence: string | undefined,
      _tildeFence: string | undefined,
      _inlineCode: string | undefined,
      inline: string | undefined,
      display: string | undefined,
      offset: number,
      source: string,
    ) => {
      if (inline !== undefined) {
        const trimmed = inline.trim();
        return trimmed ? `$${trimmed}$` : match;
      }
      if (display !== undefined) {
        const trimmed = display.trim();
        const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
        const lineEnd = source.indexOf('\n', offset + match.length);
        const fullLine = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
        // 引用行（`>`）与 GFM 表格单元格（含 `|`）内注入裸换行会拆碎块级结构，改用同行 `$$...$$`。
        if (/^\s*>/.test(fullLine) || (!display.includes('\n') && fullLine.includes('|'))) {
          return `$$${trimmed}$$`;
        }
        // 普通段落块级公式两端补换行，确保 `$$` 独占行，不把紧随其后的正文吞进公式块。
        return `\n$$\n${trimmed}\n$$\n`;
      }
      return match;
    },
  );
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) slashes++;
  return slashes % 2 === 1;
}

function isSingleDollar(text: string, index: number): boolean {
  return (
    text[index] === '$' &&
    text[index - 1] !== '$' &&
    text[index + 1] !== '$' &&
    !isEscaped(text, index)
  );
}

function findClosingSingleDollar(text: string, startIndex: number): number {
  for (let index = startIndex; index < text.length; index++) {
    if (isSingleDollar(text, index)) return index;
  }
  return -1;
}

function isFalsePositivePair(line: string, closingIndex: number, content: string): boolean {
  const after = line.slice(closingIndex + 1);
  if (COMPACT_CURRENCY_PREFIX.test(content) && CURRENCY_AMOUNT_START.test(after)) return true;
  if (SHELL_VAR_PAIR_PREFIX.test(content) && /^[A-Z_]/.test(after)) return true;
  return !looksLikeInlineMath(content);
}

function guardSingleDollarInText(segment: string, hasNewlineAfter: boolean): string {
  if (!segment.includes('$')) return segment;
  let output = '';
  for (let index = 0; index < segment.length; index++) {
    if (!isSingleDollar(segment, index)) {
      output += segment[index];
      continue;
    }
    const closing = findClosingSingleDollar(segment, index + 1);
    if (closing === -1) {
      // 已换行结束的单行内不存在配对单 `$`，不可能构成合法行内公式；转义可防止 remark-math 跨软换行把两行价格配成公式。
      output += hasNewlineAfter ? '\\$' : segment[index];
      continue;
    }
    const content = segment.slice(index + 1, closing);
    if (isFalsePositivePair(segment, closing, content)) {
      // 只转义当前左 `$` 并继续向右扫描：像 `花费 $5 购买 $x^2 + 1$ 个` 这样前面带货币、
      // 后面跟真公式的同段混排，转义第一个 `$` 后真公式仍能正常成对解析。
      output += '\\$';
      continue;
    }
    output += segment.slice(index, closing + 1);
    index = closing;
  }
  return output;
}

function guardLineOutsideInlineCode(line: string, hasNewlineAfter: boolean): string {
  if (!line.includes('$')) return line;
  let output = '';
  let cursor = 0;
  while (cursor < line.length) {
    const codeStart = line.indexOf('`', cursor);
    if (codeStart === -1) {
      output += guardSingleDollarInText(line.slice(cursor), hasNewlineAfter);
      break;
    }
    output += guardSingleDollarInText(line.slice(cursor, codeStart), true);
    let ticksEnd = codeStart + 1;
    while (line[ticksEnd] === '`') ticksEnd++;
    const marker = line.slice(codeStart, ticksEnd);
    const codeEnd = line.indexOf(marker, ticksEnd);
    if (codeEnd === -1) {
      // 流式输出中尚未闭合的行内反引号：内部按代码对待，不改写其中的 `$`。
      output += line.slice(codeStart);
      break;
    }
    output += line.slice(codeStart, codeEnd + marker.length);
    cursor = codeEnd + marker.length;
  }
  return output;
}

function parseFenceLine(line: string): { char: string; length: number; info: string } | null {
  const match = MARKDOWN_FENCE.exec(line);
  if (!match) return null;
  const ticks = match[1] ?? '';
  const info = match[2] ?? '';
  // CommonMark 规则：反引号围栏的 info string 不得再包含反引号（那属于同一行的行内代码）。
  if (ticks[0] === '`' && info.includes('`')) return null;
  return { char: ticks[0] ?? '`', length: ticks.length, info: info.trim() };
}

/**
 * 在进入 `remark-math`（开启 `singleDollarTextMath`）前保护非公式单美元符。
 *
 * 跳过代码围栏与行内反引号；对普通正文中的价格（`$5 ... $10`、`$5-$10`）、中文夹杂（`$5 元 ... $6 元`）
 * 与环境变量（`$HOME/$USER`）把左 `$` 转义为 `\$`，既避免 KaTeX 乱码与控制台告警，也不抢占后续真公式的定界符。
 */
export function normalizeSingleDollarMath(markdown: string): string {
  if (!markdown.includes('$')) return markdown;
  let output = '';
  let cursor = 0;
  let activeFence: { char: string; length: number } | null = null;
  while (cursor < markdown.length) {
    const newlineAt = markdown.indexOf('\n', cursor);
    const lineEnd = newlineAt === -1 ? markdown.length : newlineAt;
    const line = markdown.slice(cursor, lineEnd);
    const ending = newlineAt === -1 ? '' : '\n';
    const fence = parseFenceLine(line);
    if (activeFence) {
      output += line + ending;
      if (
        fence &&
        fence.char === activeFence.char &&
        fence.length >= activeFence.length &&
        !fence.info
      )
        activeFence = null;
    } else if (fence) {
      activeFence = { char: fence.char, length: fence.length };
      output += line + ending;
    } else {
      output += guardLineOutsideInlineCode(line, newlineAt !== -1) + ending;
    }
    cursor = lineEnd + ending.length;
  }
  return output;
}

/**
 * 正文进入 Streamdown 前的纯文本预处理管线：先守护非公式单美元符，再归一 `\( ... \)` / `\[ ... \]` 分隔符。
 *
 * 先守护单美元符可防止前文的孤立价格（如 `$5`）跨行吞掉后文的 `\(O(n)\)`，也不会干扰后续由 `\( ... \)`
 * 转出的带空格行内公式。仅作用于渲染输入，不修改会话存储或「复制正文 / 复制原文」使用的源字符串。
 */
export function prepareMarkdownText(text: string): string {
  return normalizeMathDelimiters(normalizeSingleDollarMath(text));
}

/**
 * 判定代码围栏是否允许挂载沙箱预览开关。
 *
 * 紧凑模式（思考过程）与超过 {@link HTML_PREVIEW_LIMIT} 的文档不提供预览入口，
 * 避免在折叠推理块内塞入高高度 iframe 或把超大字符串复制进预览通道。
 */
export function codePreviewKind(
  language: string,
  codeLength: number,
  compact = false,
): 'HTML' | 'SVG' | undefined {
  if (compact || codeLength > HTML_PREVIEW_LIMIT) return undefined;
  const normalized = language.trim().toLowerCase();
  if (normalized === 'html') return 'HTML';
  if (normalized === 'svg') return 'SVG';
  return undefined;
}
