import { Button } from '@cloudflare/kumo';

/**
 * 输入框下方的只读状态条：`本地 · <空间名> · <分支> · 上下文 N%`。
 *
 * 约束与边界：
 * - 只消费宿主已净化的 `StatusFacts`（gitBranch / contextUsage），不自行探测环境或发请求；
 * - 第一段以空间名优先，无空间时回退「本地」；分支与上下文缺失时对应段不占位；
 * - 整行可点击，打开详情抽屉的「运行事实」，与抽屉同一数据源；
 * - 窄窗口整行截断不换行，不把输入区撑高。
 */
export function ComposerStatusBar({
  spaceName,
  branch,
  contextPercent,
  onOpen,
}: {
  spaceName?: string;
  branch?: string;
  contextPercent?: number;
  onOpen: () => void;
}) {
  const segments = [spaceName?.trim() || '本地'];
  if (branch) segments.push(branch);
  if (contextPercent !== undefined) segments.push(`上下文 ${contextPercent}%`);

  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label="运行事实与状态"
      className="mx-auto flex h-auto w-full max-w-[var(--kapibala-content-max)] items-center justify-start overflow-hidden px-1 py-0 text-xs font-normal text-kumo-subtle"
      onClick={onOpen}
    >
      <span className="truncate">{segments.join(' · ')}</span>
    </Button>
  );
}
