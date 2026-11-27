import type { ViewExternalConfigChoice, ViewExternalConfigOption } from '../../view-model/index.js';

/** 跨驱动统一的推理强度（Reasoning Effort / Thinking Level / Variant）标准排序。 */
export const CANONICAL_THOUGHT_LEVEL_ORDER = [
  'default',
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;

const THOUGHT_LEVEL_LABELS: Readonly<Record<string, string>> = {
  default: 'Default',
  off: 'Off',
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  extra_high: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
};

/**
 * 将底层协议推理档位枚举值映射为人类可读展示标签（如 `xhigh -> Extra High`）。
 * 未知自定义档位保留首字母大写清洗结果，绝不静默丢弃。
 */
export function formatThoughtLevelLabel(level: string): string {
  const trimmed = level.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (Object.hasOwn(THOUGHT_LEVEL_LABELS, lower)) {
    return THOUGHT_LEVEL_LABELS[lower]!;
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** 按从低到高的标准强度次序对候选档位去重排序；未知扩展档位保序排在末尾。 */
export function orderThoughtLevels(levels: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const raw of levels) {
    const trimmed = raw.trim();
    if (trimmed) seen.add(trimmed);
  }
  const ordered: string[] = [];
  for (const std of CANONICAL_THOUGHT_LEVEL_ORDER) {
    if (seen.has(std)) {
      ordered.push(std);
      seen.delete(std);
    }
  }
  for (const rest of seen) {
    ordered.push(rest);
  }
  return ordered;
}

/** 根据有序或无序推理档位集合构造标准 `thought_level` 配置项；空集合返回 `undefined`。 */
export function buildThoughtLevelConfigOption(
  levels: Iterable<string>,
  currentValue?: string,
  id = 'thought_level',
): ViewExternalConfigOption | undefined {
  const ordered = orderThoughtLevels(levels);
  if (ordered.length === 0) return undefined;
  const options: ViewExternalConfigChoice[] = ordered.map((value) => ({
    value,
    name: formatThoughtLevelLabel(value),
  }));
  const resolvedCurrent = currentValue && ordered.includes(currentValue) ? currentValue : undefined;
  return {
    id,
    name: '推理强度',
    category: 'thought_level',
    ...(resolvedCurrent ? { currentValue: resolvedCurrent } : {}),
    options,
  };
}
