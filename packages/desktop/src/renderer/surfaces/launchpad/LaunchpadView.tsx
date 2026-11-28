import type { ReactNode } from 'react';
import { KapibalaHomeMascot } from '../../home-mascot.js';
import { useI18n } from '../../i18n.js';
import type { WorkspaceSpace } from '../../stores/index.js';
import { Badge, Button, Icon, type IconName, Select, TextArea, TextField } from '../../ui/index.js';

/** 启动台底部三列场景/外部代理快捷起手卡描述。 */
export interface LaunchpadStarterCard {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
  readonly harnessId?: string;
  readonly badge?: string;
  readonly icon?: IconName;
}

/** 默认三张高频工程起手卡：仅填入输入框草稿而不自动发送，保留用户补充上下文的主动权。 */
export const DEFAULT_LAUNCHPAD_STARTERS: readonly LaunchpadStarterCard[] = [
  {
    id: 'architecture',
    title: '梳理仓库架构',
    description: '扫描核心包职责边界、入口链路与构建门禁',
    prompt: '梳理当前仓库的目录结构、模块边界与验证门禁命令。',
    icon: 'squares-four',
  },
  {
    id: 'review-diff',
    title: '审查未提交改动',
    description: '核查潜在回归风险、边界条件与测试覆盖缺口',
    prompt: '检查当前工作区最近的改动是否存在回归风险或遗漏的边界情况。',
    icon: 'git-diff',
  },
  {
    id: 'hunt-bug',
    title: '定位报错与补测',
    description: '追踪异常根因并给出最小可验证修复与单测',
    prompt: '帮我定位当前失败用例或报错的根因，并补齐回归测试。',
    icon: 'pulse',
  },
];

/**
 * `LaunchpadView` 入参契约（017 §6.6）：
 * - 将 `BrandMark`、`20px` 简短问候、`OmniComposer` 插槽（或内置轻量草稿卡，含空间选择与 Git Worktree 隔离胶囊）及 3 张起手卡聚为单一黄金视觉中心组，彻底消除旧版中部 `300px` 空白断层；
 * - 阶段 3 完成后可直接通过 `composerSlot` 注入完整 `OmniComposer`，保持启动台零重写。
 */
export interface LaunchpadViewProps {
  readonly spaces: readonly WorkspaceSpace[];
  readonly activeWorkspaceId?: string | null;
  readonly greeting?: string;
  readonly draft?: string;
  readonly worktreeEnabled?: boolean;
  readonly worktreeBranchDraft?: string;
  readonly composerSlot?: ReactNode;
  readonly starters?: readonly LaunchpadStarterCard[];
  readonly onSelectWorkspace?: (workspaceId: string) => void;
  readonly onDraftChange?: (draft: string) => void;
  readonly onSubmitDraft?: (draft: string) => void;
  readonly onWorktreeEnabledChange?: (enabled: boolean) => void;
  readonly onWorktreeBranchChange?: (branch: string) => void;
  readonly onSelectStarter?: (starter: LaunchpadStarterCard) => void;
}

/**
 * 新会话居中启动台（`LaunchpadView`）。
 */
export function LaunchpadView({
  spaces,
  activeWorkspaceId,
  greeting,
  draft = '',
  worktreeEnabled = false,
  worktreeBranchDraft = '',
  composerSlot,
  starters,
  onSelectWorkspace,
  onDraftChange,
  onSubmitDraft,
  onWorktreeEnabledChange,
  onWorktreeBranchChange,
  onSelectStarter,
}: LaunchpadViewProps) {
  const { locale, t } = useI18n();
  const activeSpace = spaces.find((s) => s.id === activeWorkspaceId) ?? spaces[0];
  const resolvedGreeting =
    greeting ??
    (activeSpace
      ? t('launchpad.greetingWorkspace', { name: activeSpace.name })
      : t('launchpad.greetingDefault'));
  const showWorktreeToggle = Boolean(activeSpace && activeSpace.kind === 'project');
  const localizedStarters: readonly LaunchpadStarterCard[] =
    starters ??
    (locale === 'en'
      ? [
          {
            ...DEFAULT_LAUNCHPAD_STARTERS[0]!,
            title: t('launchpad.starterArchTitle'),
            description: t('launchpad.starterArchDesc'),
            prompt: t('launchpad.starterArchPrompt'),
          },
          {
            ...DEFAULT_LAUNCHPAD_STARTERS[1]!,
            title: t('launchpad.starterDiffTitle'),
            description: t('launchpad.starterDiffDesc'),
            prompt: t('launchpad.starterDiffPrompt'),
          },
          {
            ...DEFAULT_LAUNCHPAD_STARTERS[2]!,
            title: t('launchpad.starterBugTitle'),
            description: t('launchpad.starterBugDesc'),
            prompt: t('launchpad.starterBugPrompt'),
          },
        ]
      : DEFAULT_LAUNCHPAD_STARTERS);

  return (
    <section aria-label={t('launchpad.landmark')} className="kpbl-launchpad">
      <div className="kpbl-launchpad-cluster">
        <header className="kpbl-launchpad-hero">
          <KapibalaHomeMascot typing={Boolean(draft.trim())} />
          <h1 className="kpbl-launchpad-title">{resolvedGreeting}</h1>
        </header>

        <div className="flex flex-col gap-2">
          {!composerSlot ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              {spaces.length > 0 ? (
                <Select
                  size="sm"
                  aria-label={
                    activeSpace
                      ? t('composer.spaceAria', { name: activeSpace.name })
                      : t('composer.selectSpace')
                  }
                  value={activeSpace?.id ?? ''}
                  onValueChange={(id) => onSelectWorkspace?.(id)}
                  options={spaces.map((space) => ({
                    value: space.id,
                    label: space.name,
                    description: space.trusted ? undefined : t('launchpad.needTrust'),
                  }))}
                />
              ) : null}

              {showWorktreeToggle ? (
                <div className="inline-flex items-center gap-2">
                  <Button
                    size="xs"
                    variant={worktreeEnabled ? 'solid' : 'outline'}
                    leadingIcon="git-branch"
                    aria-pressed={worktreeEnabled}
                    onClick={() => onWorktreeEnabledChange?.(!worktreeEnabled)}
                  >
                    {t('composer.worktreeToggle')}
                  </Button>
                  {worktreeEnabled ? (
                    <TextField
                      mono
                      aria-label={t('composer.worktreeBranchAria')}
                      placeholder={t('composer.worktreeBranchPlaceholder')}
                      value={worktreeBranchDraft}
                      onValueChange={(val) => onWorktreeBranchChange?.(val)}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {composerSlot ?? (
            <div className="kpbl-launchpad-composer-card">
              <TextArea
                autoGrow
                rows={3}
                aria-label={t('composer.sendAria')}
                placeholder={t('composer.placeholderNew')}
                value={draft}
                onValueChange={(val) => onDraftChange?.(val)}
              />
              <div className="flex items-center justify-end gap-2">
                <Button
                  size="sm"
                  variant="solid"
                  trailingIcon="arrow-up"
                  aria-label={t('composer.sendBtn')}
                  disabled={!draft.trim()}
                  onClick={() => {
                    if (draft.trim()) onSubmitDraft?.(draft);
                  }}
                >
                  {t('composer.sendBtn')}
                </Button>
              </div>
            </div>
          )}
        </div>

        {localizedStarters.length > 0 ? (
          <div className="kpbl-launchpad-starters">
            {localizedStarters.slice(0, 3).map((card) => (
              <button
                key={card.id}
                type="button"
                className="kpbl-starter-card"
                onClick={() => {
                  onDraftChange?.(card.prompt);
                  onSelectStarter?.(card);
                }}
              >
                <span className="inline-flex w-full items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-sm font-medium">
                    {card.icon ? <Icon name={card.icon} size={15} /> : null}
                    <span>{card.title}</span>
                  </span>
                  {card.badge ? <Badge>{card.badge}</Badge> : null}
                </span>
                <span className="text-xs opacity-75">{card.description}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
