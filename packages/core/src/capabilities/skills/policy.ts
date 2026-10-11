import type { Tool } from '../tools/index.js';
import { skillFailure } from './scanner.js';
import type { SkillActivation, SkillDefinition } from './types.js';

const aliases: Readonly<Record<string, string>> = {
  Read: 'read_file',
  Write: 'write_file',
  Glob: 'glob',
  Grep: 'grep',
  Bash: 'run_command',
};

/** 归一化技能白名单；参数模式/未知名称不得退化成宽泛命令授权。 */
export function normalizeSkillTools(
  skill: SkillDefinition,
  tools: readonly Tool[],
): ReadonlySet<string> | undefined {
  if (skill.allowedTools === undefined) return undefined;
  const names = new Set(tools.map((tool) => tool.name));
  const normalized = new Set<string>();
  for (const raw of skill.allowedTools) {
    const mapped = aliases[raw] ?? raw;
    if (/[*?()]/.test(raw) || (!aliases[raw] && !names.has(mapped)))
      throw skillFailure(
        'SKILL_UNSUPPORTED',
        '技能声明了未知工具或参数模式，请迁移为宿主精确权限规则',
      );
    normalized.add(mapped);
  }
  return normalized;
}

/** 多活动技能白名单取交集；未声明不参与，空集合不等于无限制。 */
export function intersectSkillTools(
  activations: Iterable<Pick<SkillActivation, 'allowedTools'>>,
): ReadonlySet<string> | undefined {
  let allowed: Set<string> | undefined;
  for (const item of activations) {
    if (item.allowedTools === undefined) continue;
    allowed =
      allowed === undefined
        ? new Set(item.allowedTools)
        : new Set([...allowed].filter((name) => item.allowedTools!.has(name)));
  }
  return allowed;
}
