import { useEffect, useMemo, useState } from 'react';
import { rankFileMatches } from '../../file-completion.js';
import type { ReferenceChip } from '../../stores/index.js';
import { Badge, Icon } from '../../ui/index.js';

/** 斜杠命令候选目录项。 */
export interface SlashCommandOption {
  readonly name: string;
  readonly description: string;
  readonly usage?: string;
}

/** 技能候选目录项。 */
export interface SkillCatalogOption {
  readonly name: string;
  readonly description: string;
  readonly scope?: 'global' | 'project' | 'builtin';
}

/** 同空间可引用历史会话候选（`reference.candidates`）。 */
export interface ReferenceSessionCandidate {
  readonly sessionId: string;
  readonly title: string;
  readonly lastActivityAt: number;
  readonly messageCount: number;
  readonly isDelegation?: boolean;
}

/** 同空间历史消息全文检索命中项（`reference.search`）。 */
export interface ReferenceMessageHit {
  readonly sessionId: string;
  readonly title: string;
  readonly recordId: string;
  readonly branchId: string;
  readonly role: 'user' | 'assistant' | 'branch_summary';
  readonly snippet: string;
  readonly timestamp: number;
}

/** 输入框共享的命令、技能、文件与跨会话引用候选数据源契约。 */
export interface ComposerCompletionCatalogProps {
  readonly commands?: readonly SlashCommandOption[];
  readonly skills?: readonly SkillCatalogOption[];
  readonly skillsInstalled?: boolean;
  readonly files?: readonly string[];
  readonly filesTruncated?: boolean;
  readonly referenceCandidates?: readonly ReferenceSessionCandidate[];
  readonly referenceHits?: readonly ReferenceMessageHit[];
  readonly onLoadReferenceCandidates?: (
    ws: string,
  ) => Promise<readonly ReferenceSessionCandidate[]>;
  readonly onSearchReferences?: (ws: string, q: string) => Promise<readonly ReferenceMessageHit[]>;
}

/** `@` 双模引用弹层的二级标签枚举（R3.3）。 */
export type AtReferenceTab = 'files' | 'sessions';

/** 统一键盘与鼠标可选补全扁平项。 */
export type ComposerCompletionEntry =
  | {
      readonly kind: 'command' | 'skill';
      readonly key: string;
      readonly label: string;
      readonly detail: string;
      readonly insertText: string;
    }
  | {
      readonly kind: 'file';
      readonly key: string;
      readonly label: string;
      readonly insertText: string;
    }
  | {
      readonly kind: 'session_ref';
      readonly key: string;
      readonly label: string;
      readonly detail: string;
      readonly chip: ReferenceChip;
    };

/** 解析当前输入框草稿末尾激活的 `/` 或 `@` 触发器状态（纯函数，无副作用）。 */
export function resolveActiveTrigger(
  draft: string,
  allowSlashCommands: boolean,
):
  | { readonly mode: 'slash'; readonly query: string; readonly skillNameOnly: boolean }
  | { readonly mode: 'at'; readonly atIndex: number; readonly query: string }
  | null {
  if (allowSlashCommands) {
    const skillTail = /^\/skill\s+(\S*)$/.exec(draft);
    if (skillTail) {
      return { mode: 'slash', query: (skillTail[1] ?? '').toLowerCase(), skillNameOnly: true };
    }
    if (draft.startsWith('/') && !/\s/.test(draft)) {
      return { mode: 'slash', query: draft.slice(1).toLowerCase(), skillNameOnly: false };
    }
  }
  const atIndex = draft.lastIndexOf('@');
  if (atIndex >= 0 && (atIndex === 0 || /\s/.test(draft[atIndex - 1] ?? ''))) {
    const afterAt = draft.slice(atIndex + 1);
    if (!/\s/.test(afterAt)) return { mode: 'at', atIndex, query: afterAt };
  }
  return null;
}

const toSkillEntry = (s: SkillCatalogOption): ComposerCompletionEntry => ({
  kind: 'skill',
  key: `skill:${s.name}`,
  label: `/skill ${s.name}`,
  detail: s.description,
  insertText: `/skill ${s.name} `,
});

/** 根据激活触发器与数据源构建保序候选数组。 */
export function buildCompletionEntries(params: {
  readonly trigger: ReturnType<typeof resolveActiveTrigger>;
  readonly atTab: AtReferenceTab;
  readonly commands: readonly SlashCommandOption[];
  readonly skills: readonly SkillCatalogOption[];
  readonly files: readonly string[];
  readonly sessionCandidates: readonly ReferenceSessionCandidate[];
  readonly messageHits: readonly ReferenceMessageHit[];
}): ComposerCompletionEntry[] {
  const { trigger, atTab, commands, skills, files, sessionCandidates, messageHits } = params;
  if (!trigger) return [];
  if (trigger.mode === 'slash') {
    if (trigger.skillNameOnly) {
      return skills
        .filter((s) => s.name.toLowerCase().startsWith(trigger.query))
        .slice(0, 8)
        .map(toSkillEntry);
    }
    const cmds: ComposerCompletionEntry[] = commands
      .filter((c) => c.name.toLowerCase().startsWith(trigger.query))
      .slice(0, 8)
      .map((c) => ({
        kind: 'command',
        key: `cmd:${c.name}`,
        label: `/${c.name}`,
        detail: c.description,
        insertText: `/${c.name} `,
      }));
    const sks = skills
      .filter(
        (s) =>
          s.name.toLowerCase().startsWith(trigger.query) ||
          s.description.toLowerCase().includes(trigger.query),
      )
      .slice(0, 8)
      .map(toSkillEntry);
    return [...cmds, ...sks];
  }
  if (atTab === 'files') {
    return rankFileMatches(files, trigger.query.toLowerCase(), 8).map((item) => ({
      kind: 'file' as const,
      key: `file:${item.label}`,
      label: item.label,
      insertText: item.insert,
    }));
  }
  const q = trigger.query.trim().toLowerCase();
  const sessItems: ComposerCompletionEntry[] = sessionCandidates
    .filter((c) => !q || c.title.toLowerCase().includes(q))
    .slice(0, 6)
    .map((c) => {
      const title = c.title || `会话 ${c.sessionId.slice(0, 8)}`;
      return {
        kind: 'session_ref' as const,
        key: `ref-sess:${c.sessionId}`,
        label: title,
        detail: `${c.isDelegation ? '↳ 委派 · ' : ''}${c.messageCount} 条消息`,
        chip: { id: `session:${c.sessionId}`, kind: 'session', label: title, target: c.sessionId },
      };
    });
  const hitItems: ComposerCompletionEntry[] = messageHits.slice(0, 6).map((hit) => ({
    kind: 'session_ref' as const,
    key: `ref-hit:${hit.sessionId}:${hit.recordId}`,
    label: `${hit.title || '会话'} · ${hit.role === 'user' ? '提问' : '回复'}`,
    detail: hit.snippet,
    chip: {
      id: `record:${hit.sessionId}:${hit.recordId}`,
      kind: 'session',
      label: `${hit.title || '会话'} #${hit.recordId.slice(0, 6)}`,
      target: `${hit.sessionId}#${hit.recordId}@${hit.branchId}`,
      preview: hit.snippet,
    },
  }));
  return [...sessItems, ...hitItems];
}

/** 管理 `/` 与 `@` 补全状态及异步跨会话引用检索的内聚 Hook。 */
export function useCompletionPopoverState(
  catalog: ComposerCompletionCatalogProps,
  draft: string,
  workspaceId: string | null | undefined,
  allowSlash: boolean,
) {
  const [atTab, setAtTab] = useState<AtReferenceTab>('files');
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [dismissedText, setDismissedText] = useState<string | null>(null);
  const [loadedCands, setLoadedCands] = useState<readonly ReferenceSessionCandidate[]>([]);
  const [searchedHits, setSearchedHits] = useState<readonly ReferenceMessageHit[]>([]);
  const [loadingRefs, setLoadingRefs] = useState(false);

  const rawTrigger = useMemo(() => resolveActiveTrigger(draft, allowSlash), [allowSlash, draft]);
  const activeTrigger = dismissedText === draft ? null : rawTrigger;

  useEffect(() => {
    if (dismissedText !== null && dismissedText !== draft) setDismissedText(null);
  }, [dismissedText, draft]);

  const { onLoadReferenceCandidates, onSearchReferences, skills = [] } = catalog;
  useEffect(() => {
    if (activeTrigger?.mode !== 'at' || atTab !== 'sessions' || !workspaceId) return;
    let dead = false;
    setLoadingRefs(true);
    const q = activeTrigger.query.trim();
    if (!q || !onSearchReferences) setSearchedHits([]);
    const p1 = onLoadReferenceCandidates
      ? onLoadReferenceCandidates(workspaceId).then((r) => {
          if (!dead) setLoadedCands(r);
        })
      : null;
    const p2 =
      q && onSearchReferences
        ? onSearchReferences(workspaceId, q).then((r) => {
            if (!dead) setSearchedHits(r);
          })
        : null;
    void Promise.allSettled([p1, p2]).finally(() => {
      if (!dead) setLoadingRefs(false);
    });
    return () => {
      dead = true;
    };
  }, [activeTrigger, atTab, workspaceId, onLoadReferenceCandidates, onSearchReferences]);

  const entries = buildCompletionEntries({
    trigger: activeTrigger,
    atTab,
    commands: catalog.commands ?? [],
    skills,
    files: catalog.files ?? [],
    sessionCandidates: catalog.referenceCandidates ?? loadedCands,
    messageHits: catalog.referenceHits ?? searchedHits,
  });
  const clampedIdx = Math.min(highlightIdx, Math.max(0, entries.length - 1));
  const showPopover = Boolean(activeTrigger);
  const popoverProps =
    showPopover && activeTrigger
      ? {
          mode: activeTrigger.mode,
          atTab,
          entries,
          activeIndex: clampedIdx,
          filesTruncated: catalog.filesTruncated,
          skillsInstalled: catalog.skillsInstalled,
          skillsEmptyUnfiltered:
            activeTrigger.mode === 'slash' &&
            skills.length === 0 &&
            (draft === '/' || /^\/skill\s*$/.test(draft)),
          loadingReferences: loadingRefs,
          onAtTabChange: (tab: AtReferenceTab) => {
            setAtTab(tab);
            setHighlightIdx(0);
          },
        }
      : null;

  return {
    highlightIdx: clampedIdx,
    setHighlightIdx,
    dismissTrigger: () => setDismissedText(draft),
    activeTrigger,
    entries,
    popoverProps,
  };
}

/** `ReferencePopover` 入参契约（017 §6.4.3 & 018 §5.3 R3.3）。 */
export interface ReferencePopoverProps {
  readonly mode: 'slash' | 'at';
  readonly atTab: AtReferenceTab;
  readonly entries: readonly ComposerCompletionEntry[];
  readonly activeIndex: number;
  readonly filesTruncated?: boolean;
  readonly skillsInstalled?: boolean;
  readonly skillsEmptyUnfiltered?: boolean;
  readonly loadingReferences?: boolean;
  readonly onAtTabChange: (tab: AtReferenceTab) => void;
  readonly onAcceptIndex: (index: number) => void;
}

const preventAnd = (fn: () => void) => (e: { preventDefault: () => void }) => {
  e.preventDefault();
  fn();
};

/** `/` 斜杠命令补全与 `@` 双模跨会话/文件引用浮层（`ReferencePopover`）。 */
export function ReferencePopover(props: ReferencePopoverProps) {
  const { mode, atTab, entries, activeIndex, onAtTabChange, onAcceptIndex } = props;
  if (mode === 'slash') {
    const cmds = entries.flatMap((entry, idx) =>
      entry.kind === 'command' ? [{ entry, idx }] : [],
    );
    const sks = entries.flatMap((entry, idx) => (entry.kind === 'skill' ? [{ entry, idx }] : []));
    return (
      <section className="kpbl-completion-popover" aria-label="命令与技能补全">
        {entries.length === 0 ? (
          <p className="kpbl-field-hint px-2 py-1.5">无匹配的命令或技能；继续输入可缩小范围。</p>
        ) : (
          <>
            {[
              { title: '命令', items: cmds },
              { title: '技能', items: sks },
            ].map(({ title, items }) =>
              items.length === 0 ? null : (
                <div key={title}>
                  <div className="kpbl-option-group">
                    {title}（{items.length}）
                  </div>
                  {items.map(({ entry, idx }) => (
                    <button
                      key={entry.key}
                      type="button"
                      data-highlighted={idx === activeIndex ? 'true' : undefined}
                      className="kpbl-option"
                      onMouseDown={preventAnd(() => onAcceptIndex(idx))}
                      onClick={() => onAcceptIndex(idx)}
                    >
                      <span className="w-40 shrink-0 truncate font-mono text-xs">
                        {entry.label}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-right text-xs opacity-75">
                        {entry.detail}
                      </span>
                    </button>
                  ))}
                </div>
              ),
            )}
            {props.skillsEmptyUnfiltered ? (
              <p className="kpbl-field-hint px-2 py-1">
                {props.skillsInstalled
                  ? '技能已全部禁用或当前不可调用；可在「设置 → 资源管理」调整。'
                  : '没有已安装的技能；全局技能目录见「设置 → 资源管理」。'}
              </p>
            ) : null}
            <p className="kpbl-field-hint px-2 pt-1">↑↓ 切换 · Tab/Enter 补全 · Esc 关闭</p>
          </>
        )}
      </section>
    );
  }

  return (
    <section className="kpbl-completion-popover" aria-label="引用补全">
      <div className="kpbl-picker-head flex items-center justify-between gap-2">
        <div className="kpbl-segmented">
          {(['files', 'sessions'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              aria-pressed={atTab === tab}
              className="kpbl-segmented-item"
              onMouseDown={preventAnd(() => onAtTabChange(tab))}
              onClick={() => onAtTabChange(tab)}
            >
              <Icon name={tab === 'files' ? 'file-code' : 'file-text'} size={13} />
              <span>{tab === 'files' ? '文件' : '会话与消息'}</span>
            </button>
          ))}
        </div>
        <Badge>@ 引用</Badge>
      </div>

      {atTab === 'files' ? (
        <>
          {props.filesTruncated ? (
            <p className="kpbl-field-hint px-2 py-0.5">
              文件较多，列表未列全；可继续输入路径缩小范围。
            </p>
          ) : null}
          {entries.length === 0 ? (
            <p className="kpbl-field-hint px-2 py-1.5">
              {props.filesTruncated
                ? '已扫描的前 5000 个文件中无匹配项；可直接输入相对路径。'
                : '当前工作区没有匹配的文件。'}
            </p>
          ) : (
            entries.map((entry, idx) => (
              <button
                key={entry.key}
                type="button"
                aria-label={entry.label}
                data-highlighted={idx === activeIndex ? 'true' : undefined}
                className="kpbl-option"
                onMouseDown={preventAnd(() => onAcceptIndex(idx))}
                onClick={() => onAcceptIndex(idx)}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.label}</span>
              </button>
            ))
          )}
        </>
      ) : props.loadingReferences ? (
        <p className="kpbl-field-hint px-2 py-2">正在检索同空间历史会话与消息…</p>
      ) : entries.length === 0 ? (
        <p className="kpbl-field-hint px-2 py-1.5">当前项目暂无匹配的可引用历史会话或消息。</p>
      ) : (
        entries.map((entry, idx) =>
          entry.kind === 'session_ref' ? (
            <button
              key={entry.key}
              type="button"
              data-highlighted={idx === activeIndex ? 'true' : undefined}
              className="kpbl-option"
              onMouseDown={preventAnd(() => onAcceptIndex(idx))}
              onClick={() => onAcceptIndex(idx)}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{entry.label}</span>
                <span className="truncate text-xs opacity-75">{entry.detail}</span>
              </span>
            </button>
          ) : null,
        )
      )}
    </section>
  );
}
