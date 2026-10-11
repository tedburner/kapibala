import type { CanonicalMessage } from '../../types/index.js';
import { isSkillName } from './frontmatter.js';
import { skillDigest } from './scanner.js';
import type { SkillContentSource } from './types.js';

/** 技能正文在实际投影中的状态；来源只关联事实，present 不代表当前运行获得授权。 */
export interface SkillContextState {
  source: SkillContentSource;
  messageId: string;
  state: 'present' | 'requires_reload';
}

/** 旧格式和未知版本按普通文本保留，不据不完整或被篡改的元数据推断有效技能正文。 */
function validSource(
  source: SkillContentSource | undefined,
  text: string,
): source is SkillContentSource {
  return (
    !!source &&
    source.version === 1 &&
    typeof source.name === 'string' &&
    isSkillName(source.name) &&
    ['project', 'global', 'builtin'].includes(source.scope) &&
    ['user', 'model'].includes(source.caller) &&
    typeof source.filePath === 'string' &&
    typeof source.baseDir === 'string' &&
    typeof source.runId === 'string' &&
    typeof source.invocationId === 'string' &&
    /^[a-f0-9]{64}$/.test(source.contentDigest) &&
    skillDigest(text) === source.renderedDigest
  );
}

/** 查找真实投影中的完整正文来源；字段缺失、未知版本或文本摘要不匹配不用于去重。 */
export function findSkillContent(
  history: readonly CanonicalMessage[],
  source: SkillContentSource,
): { messageId: string; source: SkillContentSource } | undefined {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]!;
    for (const block of message.content) {
      if (block.type !== 'text' && block.type !== 'tool_result') continue;
      const found = block.skillSource;
      if (
        validSource(found, block.type === 'text' ? block.text : block.content) &&
        found.name === source.name &&
        found.filePath === source.filePath &&
        found.contentDigest === source.contentDigest &&
        found.renderedDigest === source.renderedDigest
      )
        return { messageId: message.id ?? '', source: found };
    }
  }
  return undefined;
}

/** 比较原始来源与真实投影，以最后一次相同文件/版本正文为准；不恢复旧授权或执行动作。 */
export function inspectSkillContent(
  raw: readonly CanonicalMessage[],
  projected: readonly CanonicalMessage[],
): SkillContextState[] {
  const sources = new Map<string, SkillContextState>();
  for (const message of raw)
    for (const block of message.content) {
      if (block.type !== 'text' && block.type !== 'tool_result') continue;
      const source = block.skillSource;
      if (!validSource(source, block.type === 'text' ? block.text : block.content)) continue;
      sources.set(JSON.stringify([source.name, source.filePath, source.contentDigest]), {
        source: structuredClone(source),
        messageId: message.id ?? '',
        state: findSkillContent(projected, source) ? 'present' : 'requires_reload',
      });
    }
  return [...sources.values()];
}

/** 将离开投影的旧正文表示为有界重载事实；最多50条，遗漏数明确，不把历史包装成当前指令。 */
export function renderSkillReloads(covered: readonly CanonicalMessage[]): string {
  const states = inspectSkillContent(covered, []);
  if (!states.length) return '';
  return `\n[Historical skill bodies removed; reactivate through the current loader before use]\n${JSON.stringify(
    {
      skills: states.slice(-50).map(({ source, messageId }) => ({
        name: source.name,
        contentDigest: source.contentDigest,
        renderedDigest: source.renderedDigest,
        sourceMessageId: messageId,
        invocationId: source.invocationId,
        state: 'requires_reload',
      })),
      omitted: Math.max(0, states.length - 50),
    },
  )}`;
}
