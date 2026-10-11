import { UnicodeTokenEstimator } from '../../context/budget.js';
import { SKILL_LIMITS, type SkillMetadata } from './types.js';

const estimator = new UnicodeTokenEstimator();

/** 使用现有 Unicode 估算器计完整文本，非 ASCII 不按四字符折算。 */
export function estimateSkillTokens(text: string): number {
  return estimator.estimate({ systemPrompt: text, messages: [] }).system;
}

/** 技能元数据的 XML 转义；不把未转义的描述或路径当作目录结构。 */
export function escapeSkillXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 完整目录投影及遗漏统计；text 为空表示最小目录也无法容纳。 */
export interface SkillCatalog {
  text: string;
  included: number;
  omitted: number;
  estimatedTokens: number;
}

/** 生成确定性 L2.5；预算含标题、XML、转义及遗漏提示，只删完整条目。 */
export function formatSkillCatalog(
  skills: readonly SkillMetadata[],
  contextWindow = 32000,
  remainingTokens = Number.POSITIVE_INFINITY,
): SkillCatalog {
  const budget = Math.max(
    0,
    Math.min(SKILL_LIMITS.catalogTokens, Math.floor(contextWindow * 0.01), remainingTokens),
  );
  const prefix =
    '# L2.5 Available Skills\nLoad matching skills with load_skill before following their instructions. Reactivate historical skills in each new run. Use list_skills to search omitted skills.\n<available_skills>\n';
  const entries: string[] = [];
  const render = (count: number) =>
    `${prefix}${entries.join('\n')}\n</available_skills>${skills.length > count ? `\n${skills.length - count} skills omitted; query list_skills.` : ''}`;
  for (const skill of skills) {
    const description = Array.from(skill.description);
    let length = Math.min(description.length, SKILL_LIMITS.descriptionChars);
    while (length > 0) {
      const text = description.slice(0, length).join('');
      const entry = `  <skill><name>${escapeSkillXml(skill.name)}</name><description>${escapeSkillXml(text)}</description></skill>`;
      entries.push(entry);
      if (estimateSkillTokens(render(entries.length)) <= budget) break;
      entries.pop();
      length = length > 24 ? Math.floor(length / 2) : 0;
    }
  }
  const candidate = render(entries.length);
  const text = skills.length && estimateSkillTokens(candidate) <= budget ? candidate : '';
  return {
    text,
    included: text ? entries.length : 0,
    omitted: skills.length - (text ? entries.length : 0),
    estimatedTokens: text ? estimateSkillTokens(text) : 0,
  };
}

/** 模型目录分页输入；游标只定位快照，不提供信任或正文访问授权。 */
export interface SkillQuery {
  query?: string;
  cursor?: string;
  limit?: number;
}
/** 有界模型元数据页；不包含正文，游标按实际返回条目推进。 */
export interface SkillQueryPage {
  skills: { name: string; description: string; scope: string; argumentHint?: string }[];
  total: number;
  nextCursor?: string;
}
