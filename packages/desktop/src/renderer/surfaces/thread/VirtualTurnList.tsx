import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  UnifiedPreviewableCodeBlock,
  UnifiedThreadViewModel,
  UnifiedTurn,
  UnifiedWorkbenchTarget,
} from '../../adapters/index.js';
import { useI18n } from '../../i18n.js';
import { Button, Icon, StatusDot } from '../../ui/index.js';
import { TurnItem } from './TurnItem.js';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * `VirtualTurnList` 入参契约（017 §6.3）：
 * - 基于 `@tanstack/react-virtual` 虚拟化长历史对话轮次，提供 `initialRect` 确保 SSR 与首帧零空白闪烁；
 * - 流式生成时自动贴底跟随；一旦用户主动上滚偏离底部（`>= 64px`）立即解除自动跟随并浮现 `28px` 高 `↓ 返回底部` 胶囊按钮。
 */
export interface VirtualTurnListProps {
  readonly sessionKey: string;
  readonly turns: readonly UnifiedTurn[];
  readonly phase: UnifiedThreadViewModel['phase'];
  readonly harnessKind?: 'native' | 'external';
  readonly harnessLabel?: string;
  readonly workspaceRoot?: string;
  readonly latestErrorText?: string;
  readonly defaultShowScrollToBottom?: boolean;
  readonly onOpenWorkbenchTarget?: (target: UnifiedWorkbenchTarget) => void;
  readonly onOpenCodePreview?: (block: UnifiedPreviewableCodeBlock) => void;
  readonly onRegenerate?: (turn: UnifiedTurn) => void;
  readonly onRestoreAndRetry?: (turn: UnifiedTurn) => void;
  readonly onRestoreCheckpoint?: (turn: UnifiedTurn) => void;
  readonly onEditUserMessage?: (text: string) => void;
  readonly onThinkingExpandedChange?: (stepId: string, expanded: boolean) => void;
  readonly onContinue?: () => void;
  readonly onReport?: (message: string) => void;
}

/**
 * 虚拟化统一对话与过程流列表（`VirtualTurnList`）。
 */
export function VirtualTurnList({
  sessionKey,
  turns,
  phase,
  harnessKind = 'native',
  harnessLabel,
  workspaceRoot,
  latestErrorText,
  defaultShowScrollToBottom = false,
  onOpenWorkbenchTarget,
  onOpenCodePreview,
  onRegenerate,
  onRestoreAndRetry,
  onRestoreCheckpoint,
  onEditUserMessage,
  onThinkingExpandedChange,
  onContinue,
  onReport,
}: VirtualTurnListProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followingRef = useRef(!defaultShowScrollToBottom);
  const userScrolledRef = useRef(false);
  const rafRef = useRef<number | undefined>(undefined);
  const [atBottom, setAtBottom] = useState(!defaultShowScrollToBottom);
  const [trackedSessionKey, setTrackedSessionKey] = useState(sessionKey);

  if (trackedSessionKey !== sessionKey) {
    setTrackedSessionKey(sessionKey);
    followingRef.current = !defaultShowScrollToBottom;
    userScrolledRef.current = false;
    setAtBottom(!defaultShowScrollToBottom);
  }

  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 180,
    overscan: 5,
    initialRect: { width: 760, height: 800 },
    getItemKey: (index) => turns[index]?.id ?? index,
    onChange(instance, sync) {
      if (
        !sync &&
        followingRef.current &&
        rafRef.current === undefined &&
        turns.length > 0 &&
        typeof window !== 'undefined'
      ) {
        rafRef.current = window.requestAnimationFrame(() => {
          rafRef.current = undefined;
          if (followingRef.current && turns.length > 0) {
            instance.scrollToIndex(turns.length - 1, { align: 'end' });
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }
        });
      }
    },
  });

  const isStreamingPhase =
    phase === 'starting' ||
    phase === 'running' ||
    phase === 'waiting_approval' ||
    phase === 'cancelling';

  const lastTurnRevision = turns.at(-1)?.proseBlocks.at(-1)?.text.length ?? 0;

  useIsomorphicLayoutEffect(() => {
    if (!followingRef.current || turns.length === 0) return;
    virtualizer.scrollToIndex(turns.length - 1, { align: 'end' });
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, isStreamingPhase, lastTurnRevision, virtualizer]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== undefined && typeof window !== 'undefined') {
        window.cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  const scrollToBottom = () => {
    followingRef.current = true;
    userScrolledRef.current = false;
    setAtBottom(true);
    if (turns.length > 0) {
      virtualizer.scrollToIndex(turns.length - 1, { align: 'end' });
    }
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="kpbl-turn-viewport-wrap">
      <div
        ref={scrollRef}
        role="log"
        aria-label={t('thread.logAria')}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: 可滚动对话阅读区需支持键盘翻页及虚拟行卸载后的焦点锚定。
        tabIndex={0}
        className="kpbl-turn-scroll"
        onWheel={(event) => {
          userScrolledRef.current = true;
          if (event.deltaY < 0) {
            followingRef.current = false;
            setAtBottom(false);
          }
        }}
        onPointerDown={() => {
          userScrolledRef.current = true;
        }}
        onKeyDown={(event) => {
          if (['PageUp', 'Home', 'ArrowUp', 'PageDown', 'End', 'ArrowDown'].includes(event.key)) {
            userScrolledRef.current = true;
          }
        }}
        onScroll={(event) => {
          const el = event.currentTarget;
          const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
          if (nearBottom || userScrolledRef.current) {
            followingRef.current = nearBottom;
            setAtBottom(nearBottom);
          }
        }}
      >
        <div className="kpbl-turn-column">
          {turns.length === 0 && !isStreamingPhase ? (
            <p className="py-12 text-center text-sm" style={{ color: 'var(--kpbl-ink-subtle)' }}>
              {t('thread.readyEmpty')}
            </p>
          ) : null}

          <div
            style={{
              position: 'relative',
              width: '100%',
              height: `${virtualizer.getTotalSize()}px`,
            }}
          >
            {virtualItems.map((row) => {
              const turn = turns[row.index];
              if (!turn) return null;
              return (
                <div
                  key={row.key}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  className="kpbl-virtual-row"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  <TurnItem
                    turn={turn}
                    harnessKind={harnessKind}
                    harnessLabel={harnessLabel}
                    workspaceRoot={workspaceRoot}
                    onOpenWorkbenchTarget={onOpenWorkbenchTarget}
                    onOpenCodePreview={onOpenCodePreview}
                    onRegenerate={onRegenerate}
                    onRestoreAndRetry={onRestoreAndRetry}
                    onRestoreCheckpoint={onRestoreCheckpoint}
                    onEditUserMessage={onEditUserMessage}
                    onThinkingExpandedChange={onThinkingExpandedChange}
                    onReport={onReport}
                  />
                </div>
              );
            })}
          </div>

          {isStreamingPhase ? (
            <output aria-live="polite" className="inline-flex items-center gap-2 py-2 text-xs">
              <StatusDot
                status={phase === 'waiting_approval' ? 'waiting_approval' : 'running'}
                showLabel
                label={
                  phase === 'waiting_approval'
                    ? t('thread.phaseWaitingApproval')
                    : phase === 'cancelling'
                      ? t('thread.phaseCancelling')
                      : phase === 'starting'
                        ? t('thread.phaseStarting')
                        : t('thread.phaseRunning')
                }
              />
            </output>
          ) : null}

          {phase === 'failed' && turns.length > 0 ? (
            <output className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-xs kpbl-tone-warning">
              <span className="inline-flex min-w-0 flex-1 items-center gap-2">
                <Icon name="warning" size={14} />
                <span className="truncate">{latestErrorText || t('thread.failedFallback')}</span>
              </span>
              {onContinue ? (
                <Button size="xs" variant="outline" onClick={onContinue}>
                  {t('thread.continueBtn')}
                </Button>
              ) : null}
            </output>
          ) : null}
        </div>
      </div>

      {!atBottom ? (
        <button
          type="button"
          aria-label={t('thread.scrollToBottom')}
          className="kpbl-scroll-bottom-pill"
          onClick={scrollToBottom}
        >
          <span aria-hidden="true">↓</span>
          <span>{t('thread.scrollToBottom')}</span>
        </button>
      ) : null}
    </div>
  );
}
