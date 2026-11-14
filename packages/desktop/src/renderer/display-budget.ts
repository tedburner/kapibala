import { LIMITS } from '../shared/contracts.js';

/**
 * 高亮语言清单：锁定版本 @cloudflare/kumo@2.15.0 的 BUNDLED_LANGS 规范名全集
 * （含此前遗漏的 shell）。ShikiProvider 会对清单自行 normalize 与去重；
 * 渲染层只对 normalizeLanguage 可识别的语言调用高亮，清单缺失时走纯文本回退。
 * 放在纯模块中以便用导出的 normalizeLanguage 做规范名单测。
 */
export const HIGHLIGHT_LANGUAGES = [
  'javascript',
  'typescript',
  'jsx',
  'tsx',
  'json',
  'jsonc',
  'html',
  'css',
  'python',
  'yaml',
  'markdown',
  'graphql',
  'sql',
  'bash',
  'shell',
  'diff',
  'toml',
  'hcl',
] as const;

/**
 * 展示预算裁剪结果；预算内原样返回，超限只保留前 maximum 个 UTF-16 单元。
 * 裁剪只影响界面渲染，不改写投影或落盘数据，调用方必须同时展示截断提示。
 */
export interface DisplayClip {
  text: string;
  truncated: boolean;
}

/**
 * 统一的文本展示预算入口：消息代码块、工具参数与结果共用同一上限。
 * 按 UTF-16 length 计数与 DOM 文本节点成本同量级；不接受页面或调用方私自放大。
 */
export function clipForDisplay(text: string, maximum: number = LIMITS.displayBudget): DisplayClip {
  if (!Number.isSafeInteger(maximum) || maximum <= 0)
    throw new Error('Display budget must be a positive safe integer');
  return text.length > maximum
    ? { text: text.slice(0, maximum), truncated: true }
    : { text, truncated: false };
}
