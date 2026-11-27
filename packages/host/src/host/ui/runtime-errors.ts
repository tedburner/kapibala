/**
 * 运行期错误的展示文案映射。
 * 约束：core 的错误 message 保持英文事实，UI 语言由宿主负责；这里只映射
 * core 运行时固定抛出的已知文案（精确子串匹配），未知错误一律回退原文，
 * 避免误译第三方/provider 动态内容。返回 undefined 表示没有映射，调用方
 * 继续走原有的 sanitize 原文展示路径。
 */
const RUNTIME_ERROR_TEXTS: readonly { readonly match: string; readonly text: string }[] = [
  {
    // core runtime loop：工具结果 retryPolicy 为 after_user_action 时终止本轮并抛出。
    match: 'Tool execution requires user action before continuing',
    text: '已暂停执行：有一个工具操作被拒绝或需要你确认后才能继续。可直接点击下方「继续执行」让模型改用其它方案推进。',
  },
  {
    // core runtime loop：单轮自动执行达到 maxSteps 上限时终止本轮。
    match: 'Reached max steps limit',
    text: '已达到单轮自动执行步数上限，当前任务尚未全部收尾。点击下方「继续执行」或发送「继续」即可接着完成剩余步骤。',
  },
];

/** 映射已知的运行期错误为面向用户的展示文案；未命中返回 undefined。 */
export function describeRuntimeError(raw: string): string | undefined {
  for (const item of RUNTIME_ERROR_TEXTS) if (raw.includes(item.match)) return item.text;
  return undefined;
}
