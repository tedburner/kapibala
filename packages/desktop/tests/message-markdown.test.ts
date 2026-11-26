import { describe, expect, it } from 'vitest';
import { HTML_PREVIEW_LIMIT } from '../src/renderer/html-preview-model.js';
import {
  codePreviewKind,
  looksLikeInlineMath,
  normalizeMathDelimiters,
  normalizeSingleDollarMath,
  prepareMarkdownText,
} from '../src/renderer/message-markdown-model.js';
import { aggregateTurnUsage } from '../src/renderer/turn-usage.js';

describe('行内公式特征判别', () => {
  it('识别标准数学表达式、单符号变量与显式 LaTeX 命令', () => {
    expect(looksLikeInlineMath('E = mc^2')).toBe(true);
    expect(looksLikeInlineMath('x')).toBe(true);
    expect(looksLikeInlineMath('\\frac{a}{b}')).toBe(true);
    expect(looksLikeInlineMath('\\text{中文下标}_1')).toBe(true);
    expect(looksLikeInlineMath('a + b \\le c')).toBe(true);
  });

  it('拒绝首尾含空白、跨行、中日韩货币短语与无算符自然语言', () => {
    expect(looksLikeInlineMath('')).toBe(false);
    expect(looksLikeInlineMath(' x ')).toBe(false);
    expect(looksLikeInlineMath('a\nb')).toBe(false);
    expect(looksLikeInlineMath('5 元，含税 ')).toBe(false);
    expect(looksLikeInlineMath('5 and 10')).toBe(false);
  });
});

describe('LaTeX 括号定界符归一', () => {
  it('转换正文中的 \\( ... \\) 与 \\[ ... \\]，但不触碰围栏与行内代码', () => {
    const input = [
      '复杂度为 \\(O(n \\log n)\\)，满足：',
      '\\[\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\\]',
      '代码 `const re = /\\(a\\)/;` 保持不变：',
      '```ts',
      'const raw = "\\\\[not_math\\\\]";',
      '```',
    ].join('\n');
    const normalized = normalizeMathDelimiters(input);
    expect(normalized).toContain('$O(n \\log n)$');
    expect(normalized).toContain('\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$\n');
    expect(normalized).toContain('`const re = /\\(a\\)/;`');
    expect(normalized).toContain('const raw = "\\\\[not_math\\\\]";');
  });

  it('裁剪 \\( ... \\) 首尾空格，并在引用与表格单元格内将 \\[ ... \\] 保持单行', () => {
    expect(prepareMarkdownText('内含空格 \\( x + 1 \\) 仍应渲染为公式')).toBe(
      '内含空格 $x + 1$ 仍应渲染为公式',
    );
    expect(prepareMarkdownText('单行三反引号 ```inline``` 之后\n\\(a + b\\)')).toBe(
      '单行三反引号 ```inline``` 之后\n$a + b$',
    );
    expect(prepareMarkdownText('> 推导结论：\\[ E = mc^2 \\]')).toBe('> 推导结论：$$E = mc^2$$');
    expect(prepareMarkdownText('| 名称 | 公式 |\n| --- | --- |\n| 质能 | \\[ E = mc^2 \\] |')).toBe(
      '| 名称 | 公式 |\n| --- | --- |\n| 质能 | $$E = mc^2$$ |',
    );
  });
});

describe('单美元符非公式守卫', () => {
  it('转义中文价格、紧凑价格区间与环境变量，同时保留同行的真实公式', () => {
    expect(normalizeSingleDollarMath('报价 $5 元，含税 $6 元')).toBe('报价 \\$5 元，含税 $6 元');
    expect(normalizeSingleDollarMath('区间 $5-$10')).toBe('区间 \\$5-$10');
    expect(normalizeSingleDollarMath('区间 $5-$10 或 $10~$20')).toBe(
      '区间 \\$5-\\$10 或 \\$10~$20',
    );
    expect(normalizeSingleDollarMath('路径 $HOME/$USER 配置')).toBe('路径 \\$HOME/$USER 配置');
    expect(normalizeSingleDollarMath('请配置 $OPENAI_API_KEY、$ANTHROPIC_API_KEY 环境变量')).toBe(
      '请配置 \\$OPENAI_API_KEY、$ANTHROPIC_API_KEY 环境变量',
    );
    expect(normalizeSingleDollarMath('花费 $5 购买 $x^2 + 1$ 个')).toBe(
      '花费 \\$5 购买 $x^2 + 1$ 个',
    );
    expect(prepareMarkdownText('从 $5\n涨到 $10，复杂度 \\(O(n)\\)')).toBe(
      '从 \\$5\n涨到 $10，复杂度 $O(n)$',
    );
  });

  it('不改写双美元块级公式、行内代码与代码围栏内的美元符', () => {
    const markdown = [
      '$$E = mc^2$$',
      '命令 `echo $HOME && echo $PATH`',
      '```bash',
      'echo "$5 元 $6 元"',
      '```',
    ].join('\n');
    expect(prepareMarkdownText(markdown)).toBe(markdown);
  });
});

describe('代码围栏沙箱预览资格', () => {
  it('仅在正式正文、预算上限内且语言为 html/svg 时开放对应预览', () => {
    expect(codePreviewKind('html', 120)).toBe('HTML');
    expect(codePreviewKind('SVG', 120)).toBe('SVG');
    expect(codePreviewKind('tsx', 120)).toBeUndefined();
    expect(codePreviewKind('html', 120, true)).toBeUndefined();
    expect(codePreviewKind('html', HTML_PREVIEW_LIMIT + 1)).toBeUndefined();
  });
});

describe('多步助手回合 Token 用量聚合', () => {
  it('累加同一视觉回合内多条消息的 usage，整轮缺失时返回 undefined', () => {
    expect(aggregateTurnUsage([{}, {}])).toBeUndefined();
    expect(
      aggregateTurnUsage([
        { usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } },
        {},
        { usage: { promptTokens: 180, completionTokens: 45, totalTokens: 225 } },
      ]),
    ).toEqual({
      promptTokens: 280,
      completionTokens: 65,
      totalTokens: 345,
    });
  });
});
