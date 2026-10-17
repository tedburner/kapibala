/**
 * 宿主提供的候选展示事实；不扫描来源、读取正文或据此授予执行权限。
 * 每个规范动作使用唯一稳定 ID，命令别名合并在 aliases；同名跨来源保持不同 ID。
 * Skill ID 由宿主编码发现身份，不能放入原始路径；执行引用也仅为宿主可解释的不透明字符串。
 */
export type CommandCandidate = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly sourceLabel: string;
  readonly argumentHint?: string;
  /** 当前参数下由宿主计算的展示状态，执行前仍须重新裁决。 */
  readonly availability?: { readonly enabled: boolean; readonly reason?: string };
  readonly executionRef?: string;
} & (
  | {
      readonly kind: 'command';
      /** 策划目录次序，不得使用异步到达顺序或使用频率。 */
      readonly baseOrder: number;
      readonly aliases?: readonly string[];
    }
  | { readonly kind: 'skill' }
  | {
      readonly kind: 'prompt';
      readonly server: string;
      readonly promptName: string;
    }
);

/** 名称匹配等级；all 仅表示空查询，不能把可见候选当成已获准执行。 */
export type CommandMatchKind = 'all' | 'exact' | 'prefix' | 'substring' | 'fuzzy';

/** 匹配保留规范候选身份；matchedName 可为命令别名，展示与执行仍引用同一动作。 */
export interface CommandMatch {
  readonly candidate: CommandCandidate;
  readonly match: CommandMatchKind;
  readonly matchedName: string;
}

/**
 * 完整匹配集合上的可见切片；selectedIndex 始终索引原集合，空集时为 -1。
 * remainingCount 统计窗口上下所有未显示项，不能用切片替换完整结果集合。
 */
export interface CommandWindow {
  readonly selectedIndex: number;
  readonly startIndex: number;
  readonly visible: readonly CommandMatch[];
  readonly remainingCount: number;
  readonly moreLabel: string | undefined;
}

const matchKinds: readonly Exclude<CommandMatchKind, 'all'>[] = [
  'exact',
  'prefix',
  'substring',
  'fuzzy',
];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 来源按命令、Skill、Prompt 分组，所有平局均由稳定身份消除，不依赖输入到达次序。 */
function compareCandidates(left: CommandCandidate, right: CommandCandidate): number {
  const kinds = { command: 0, skill: 1, prompt: 2 };
  const kindOrder = kinds[left.kind] - kinds[right.kind];
  if (kindOrder !== 0) return kindOrder;
  if (left.kind === 'command' && right.kind === 'command') {
    const baseOrder = left.baseOrder - right.baseOrder;
    if (Number.isFinite(baseOrder) && baseOrder !== 0) return baseOrder;
  }
  if (left.kind === 'prompt' && right.kind === 'prompt') {
    const promptOrder =
      compareText(left.server, right.server) || compareText(left.promptName, right.promptName);
    if (promptOrder !== 0) return promptOrder;
  }
  return compareText(left.id, right.id);
}

function normalizeName(value: string): string {
  return value.trim().replace(/^\//, '').toLowerCase();
}

/** 模糊匹配仅要求查询字符依序出现，不读取正文，也不以编辑距离改变同级基础序。 */
function matchRank(name: string, query: string): number {
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  let offset = 0;
  for (const character of query) {
    const found = name.indexOf(character, offset);
    if (found === -1) return -1;
    offset = found + character.length;
  }
  return 3;
}

/**
 * 对调用方提供的三类元数据按名称或命令别名匹配，支持可选前导 Slash 和大小写归一。
 * 精确、前缀、子串、子序列模糊依次优先，同级保持稳定基础序；描述和来源不独立引入候选或覆盖基础序。
 * 空查询先按策划命令序，再按 Skill 稳定 ID、Prompt server/name 排序；相同 ID 只保留一个规范动作。
 * 调用方须保证相同 ID 的元数据一致；本函数不修改输入，也不筛掉宿主标记不可用的展示项。
 */
export function matchCommandCandidates(
  candidates: readonly CommandCandidate[],
  query: string,
): readonly CommandMatch[] {
  const normalizedQuery = normalizeName(query);
  const seen = new Set<string>();
  const matches: { value: CommandMatch; rank: number }[] = [];
  for (const candidate of [...candidates].sort(compareCandidates)) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    if (normalizedQuery === '') {
      matches.push({ value: { candidate, match: 'all', matchedName: candidate.name }, rank: -1 });
      continue;
    }
    const names = [
      candidate.name,
      ...(candidate.kind === 'command' ? (candidate.aliases ?? []) : []),
    ];
    let bestRank = Number.POSITIVE_INFINITY;
    let matchedName = candidate.name;
    for (const name of names) {
      const rank = matchRank(normalizeName(name), normalizedQuery);
      if (rank >= 0 && rank < bestRank) {
        bestRank = rank;
        matchedName = name;
      }
    }
    if (Number.isFinite(bestRank)) {
      matches.push({
        value: { candidate, match: matchKinds[bestRank], matchedName },
        rank: bestRank,
      });
    }
  }
  return matches.sort((left, right) => left.rank - right.rank).map(({ value }) => value);
}

function integer(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/**
 * 在完整集合中移动选择并夹紧两端，不循环跳转、不按三行窗口截断；空集返回 -1。
 * 非有限数值按零处理，过期索引先夹紧，调用方负责焦点与按键只消费一次。
 */
export function moveCommandSelection(count: number, selectedIndex: number, delta: number): number {
  const length = Math.max(0, integer(count, 0));
  if (length === 0) return -1;
  const index = Math.max(0, Math.min(length - 1, integer(selectedIndex, 0)));
  return Math.max(0, Math.min(length - 1, index + integer(delta, 0)));
}

/**
 * 默认显示三条，沿用旧窗口起点直到选择离开窗口，再最小滚动以保持选中项可见。
 * 只返回切片，不裁剪调用方的完整集合；空集、列表缩短和过期数值均安全夹紧。
 * 自定义窗口至少一条，非有限窗口大小退回三条；此函数不处理终端行高或渲染布局。
 */
export function selectCommandWindow(
  matches: readonly CommandMatch[],
  selectedIndex = 0,
  startIndex = 0,
  windowSize = 3,
): CommandWindow {
  const size = Math.max(1, integer(windowSize, 3));
  const selected = moveCommandSelection(matches.length, selectedIndex, 0);
  let start = Math.max(0, Math.min(Math.max(0, matches.length - size), integer(startIndex, 0)));
  if (selected >= 0 && selected < start) start = selected;
  if (selected >= start + size) start = selected - size + 1;
  const visible = matches.slice(start, start + size);
  const remainingCount = matches.length - visible.length;
  return {
    selectedIndex: selected,
    startIndex: start,
    visible,
    remainingCount,
    moreLabel: remainingCount > 0 ? `+${remainingCount} more` : undefined,
  };
}
