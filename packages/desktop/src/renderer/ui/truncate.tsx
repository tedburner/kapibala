import type { HTMLAttributes } from 'react';

/** `truncateMiddle` 结构化裁剪结果。 */
export interface MiddleTruncateParts {
  readonly truncated: boolean;
  readonly display: string;
  readonly head: string;
  readonly tail: string;
}

/**
 * 按 Unicode 码点执行路径与长命令中段省略，优先完整保留末尾文件名或最后一段参数（如 `/WorkbenchStage.tsx`）；
 * 严禁使用 UTF-16 下标硬切以免截断代理对字符或 Emoji。
 */
export function truncateMiddle(
  value: string,
  maxChars = 48,
  minTailChars = 16,
): MiddleTruncateParts {
  const glyphs = Array.from(value);
  const safeMax = Math.max(8, maxChars);
  if (glyphs.length <= safeMax) {
    return { truncated: false, display: value, head: value, tail: '' };
  }

  const lastSlash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  let tailGlyphs: string[];
  if (lastSlash > 0) {
    const segmentGlyphs = Array.from(value.slice(lastSlash));
    if (segmentGlyphs.length <= safeMax - 4) {
      tailGlyphs = segmentGlyphs;
    } else {
      const clampedTail = Math.min(Math.max(4, minTailChars), safeMax - 4);
      tailGlyphs = glyphs.slice(glyphs.length - clampedTail);
    }
  } else {
    const clampedTail = Math.min(Math.max(4, minTailChars), Math.floor((safeMax - 1) / 2));
    tailGlyphs = glyphs.slice(glyphs.length - clampedTail);
  }

  const headBudget = Math.max(3, safeMax - tailGlyphs.length - 1);
  const head = glyphs.slice(0, headBudget).join('');
  const tail = tailGlyphs.join('');
  return {
    truncated: true,
    display: `${head}…${tail}`,
    head,
    tail,
  };
}

/**
 * `MiddleTruncate` 入参契约：面向工作区文件路径、外部代理启动命令行与分支名展示；
 * 发生字符级截断或开启 `alwaysTooltip` 时挂载原生延迟 `title` 提示完整原文。
 */
export interface MiddleTruncateProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  readonly text: string;
  readonly maxChars?: number;
  readonly mono?: boolean;
  readonly alwaysTooltip?: boolean;
}

/**
 * 中段省略文本原语：兼具确定性字符预算裁剪与双段 Flex 弹性收缩（首段溢出省略、尾段文件名刚性保留）。
 */
export function MiddleTruncate({
  text,
  maxChars = 48,
  mono = false,
  alwaysTooltip = false,
  title,
  className,
  ...rest
}: MiddleTruncateProps) {
  const parts = truncateMiddle(text, maxChars);
  const resolvedTitle = title ?? (parts.truncated || alwaysTooltip ? text : undefined);

  return (
    <span
      title={resolvedTitle}
      aria-label={parts.truncated ? text : undefined}
      data-mono={mono ? 'true' : undefined}
      className={className ? `kpbl-middle-truncate ${className}` : 'kpbl-middle-truncate'}
      {...rest}
    >
      {parts.truncated ? (
        <>
          <span className="kpbl-middle-truncate-head">{parts.head}…</span>
          <span className="kpbl-middle-truncate-tail">{parts.tail}</span>
        </>
      ) : (
        <span className="kpbl-middle-truncate-head">{text}</span>
      )}
    </span>
  );
}
