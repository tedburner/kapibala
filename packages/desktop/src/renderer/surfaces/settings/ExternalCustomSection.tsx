import { useState } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  MiddleTruncate,
  SettingRow,
  SettingSection,
  StatusDot,
  Switch,
  TextArea,
  TextField,
} from '../../ui/index.js';
import {
  type CustomHarnessDraft,
  type ExternalHarnessItem,
  type ExternalProbeResult,
  type ExternalTemplateItem,
  describeHarnessCache,
  probeStatusPresentation,
  suggestHarnessId,
} from './external-helpers.js';
import { copyTextSafe } from './settings-helpers.js';

/**
 * `ExternalCustomSection` 入参契约：
 * 承载官方 ACP 目录模板快填、自定义 `Local ACP Command` 保存前握手表单与已登记自定义代理列表。
 */
export interface ExternalCustomSectionProps {
  readonly allHarnessIds: ReadonlySet<string>;
  readonly customHarnesses: readonly ExternalHarnessItem[];
  readonly templates: readonly ExternalTemplateItem[];
  readonly probes: Readonly<Record<string, ExternalProbeResult>>;
  readonly customDraft?: CustomHarnessDraft;
  readonly draftProbe?: ExternalProbeResult;
  readonly testingDraft: boolean;
  readonly testingId?: string;
  readonly refreshingCacheId?: string;
  readonly refreshingAllCaches: boolean;
  readonly busy: boolean;
  readonly hostDown: boolean;
  readonly onChangeDraft: (draft: CustomHarnessDraft | undefined) => void;
  readonly onApplyTemplate: (template: ExternalTemplateItem) => void;
  readonly onStartBlankCustom: () => void;
  readonly onEditCustom: (item: ExternalHarnessItem) => void;
  readonly onProbeDraft: () => void;
  readonly onSaveDraft: () => void;
  readonly onRunProbe: (item: ExternalHarnessItem) => void;
  readonly onRefreshCache: (item: ExternalHarnessItem) => void;
  readonly onToggleEnabled: (item: ExternalHarnessItem, enabled: boolean) => void;
  readonly onRemoveCustom: (item: ExternalHarnessItem) => void;
}

/**
 * 外部代理设置页下半区：社区/官方 ACP 模板回填与自定义 `Local ACP Command` 增删改查。
 */
export function ExternalCustomSection({
  allHarnessIds,
  customHarnesses,
  templates,
  probes,
  customDraft,
  draftProbe,
  testingDraft,
  testingId,
  refreshingCacheId,
  refreshingAllCaches,
  busy,
  hostDown,
  onChangeDraft,
  onApplyTemplate,
  onStartBlankCustom,
  onEditCustom,
  onProbeDraft,
  onSaveDraft,
  onRunProbe,
  onRefreshCache,
  onToggleEnabled,
  onRemoveCustom,
}: ExternalCustomSectionProps) {
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>();
  const [copiedTemplateId, setCopiedTemplateId] = useState<string>();

  return (
    <SettingSection
      title="自定义与社区 ACP 代理"
      description="通过标准输入输出（stdio NDJSON）接入任意兼容 Agent Client Protocol 的本机命令。"
      actions={
        <div className="kpbl-row-title-line">
          <Button
            variant="outline"
            size="sm"
            leadingIcon="sparkle"
            disabled={hostDown}
            onClick={() => setTemplatesOpen((prev) => !prev)}
          >
            从 ACP 目录选择模板
          </Button>
          <Button
            variant="solid"
            size="sm"
            leadingIcon="plus"
            disabled={hostDown}
            onClick={onStartBlankCustom}
          >
            添加自定义 ACP 代理
          </Button>
        </div>
      }
    >
      {templatesOpen ? (
        <SettingRow
          align="start"
          title="官方与社区 ACP 模板"
          description="点击「选用模板」自动回填下方表单，仍可按本机可执行路径调整。"
          control={
            <Button variant="ghost" size="xs" onClick={() => setTemplatesOpen(false)}>
              关闭模板列表
            </Button>
          }
        >
          <div className="kpbl-template-grid">
            {templates.map((template) => {
              const commandText = [template.command, ...template.args].join(' ');
              return (
                <div key={template.registryId} className="kpbl-template-item">
                  <div>
                    <div className="kpbl-row-title-line">
                      <span className="kpbl-setting-row-title">{template.name}</span>
                      <code className="kpbl-mono-inline">{commandText}</code>
                    </div>
                    <p className="kpbl-setting-row-desc">{template.description}</p>
                  </div>
                  <div className="kpbl-row-title-line">
                    <Button
                      variant="ghost"
                      size="xs"
                      leadingIcon="copy"
                      onClick={() => {
                        void copyTextSafe(template.installHint).then((ok) => {
                          if (ok) setCopiedTemplateId(template.registryId);
                        });
                      }}
                    >
                      {copiedTemplateId === template.registryId ? '已复制' : '复制安装命令'}
                    </Button>
                    <Button
                      variant="outline"
                      size="xs"
                      aria-label={`选用 ${template.name} 模板`}
                      onClick={() => {
                        setTemplatesOpen(false);
                        onApplyTemplate(template);
                      }}
                    >
                      选用模板
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </SettingRow>
      ) : null}

      {customDraft ? (
        <SettingRow
          align="start"
          title={
            customDraft.idLocked ? `编辑自定义代理 · ${customDraft.id}` : '新建自定义 ACP 代理'
          }
          description="支持保存前直接拉起真实 ACP 握手测试，核验对端名称、版本与跨进程恢复能力。"
        >
          <div className="kpbl-accordion-form">
            <div className="kpbl-form-grid-2">
              <TextField
                label="显示名称"
                aria-label="自定义代理显示名称"
                placeholder="例如 Cline CLI"
                value={customDraft.name}
                onValueChange={(value) =>
                  onChangeDraft({
                    ...customDraft,
                    name: value,
                    id:
                      customDraft.idLocked || customDraft.idTouched
                        ? customDraft.id
                        : suggestHarnessId(value, allHarnessIds),
                  })
                }
              />
              <TextField
                mono
                label="代理标识 ID"
                aria-label="自定义代理标识 ID"
                placeholder="例如 cline-acp"
                disabled={customDraft.idLocked}
                value={customDraft.id}
                onValueChange={(value) =>
                  onChangeDraft({
                    ...customDraft,
                    id: value.toLowerCase(),
                    idTouched: true,
                  })
                }
              />
            </div>
            <TextField
              mono
              label="可执行命令或绝对路径"
              aria-label="自定义代理可执行命令"
              placeholder="例如 cline 或 /usr/local/bin/my-acp-agent"
              value={customDraft.command}
              onValueChange={(value) => onChangeDraft({ ...customDraft, command: value })}
            />
            <TextArea
              mono
              rows={2}
              label="启动参数（每行作为独立参数原样传递，不经 Shell 解析）"
              aria-label="自定义代理启动参数"
              placeholder="acp"
              value={customDraft.argsText}
              onValueChange={(value) => onChangeDraft({ ...customDraft, argsText: value })}
            />
            <TextField
              mono
              label="转发环境变量名（可选，仅保存变量名，不保存密钥值）"
              aria-label="自定义代理转发环境变量名"
              placeholder="例如 OPENAI_API_KEY, ANTHROPIC_API_KEY"
              value={customDraft.envFromText}
              onValueChange={(value) => onChangeDraft({ ...customDraft, envFromText: value })}
            />

            {draftProbe ? (
              <output
                role={draftProbe.available ? 'status' : 'alert'}
                className={draftProbe.available ? 'kpbl-field-hint' : 'kpbl-field-error'}
              >
                {draftProbe.available
                  ? `握手成功：${draftProbe.agentName ?? 'ACP Agent'}${
                      draftProbe.version ? ` · ${draftProbe.version}` : ''
                    }（${draftProbe.loadSupported ? '支持跨进程会话恢复' : '仅保留只读展示快照'}）`
                  : `未就绪（${probeStatusPresentation(draftProbe).label}）${
                      draftProbe.reason ? `：${draftProbe.reason}` : ''
                    }`}
              </output>
            ) : null}

            <div className="kpbl-form-actions">
              <Button variant="ghost" size="sm" onClick={() => onChangeDraft(undefined)}>
                取消编辑
              </Button>
              <Button
                variant="outline"
                size="sm"
                leadingIcon="plugs-connected"
                loading={testingDraft}
                disabled={hostDown}
                onClick={onProbeDraft}
              >
                {testingDraft ? '握手中…' : '测试握手'}
              </Button>
              <Button
                variant="solid"
                size="sm"
                loading={busy}
                disabled={hostDown}
                onClick={onSaveDraft}
              >
                保存代理
              </Button>
            </div>
          </div>
        </SettingRow>
      ) : null}

      {customHarnesses.length === 0 && !customDraft ? (
        <EmptyState
          icon="terminal"
          title="尚未添加自定义 ACP 代理"
          description="点击上方「添加自定义 ACP 代理」手动配置，或从官方 ACP 目录选用模板。"
        />
      ) : (
        customHarnesses.map((item) => {
          const probe = probes[item.id] ?? item.probe;
          const status = probeStatusPresentation(probe);
          const cacheInfo = describeHarnessCache(item);
          const commandPreview = [
            item.command,
            ...item.args,
            ...(item.envFrom.length > 0 ? [`· 透传变量：${item.envFrom.join(', ')}`] : []),
          ].join(' ');
          const confirmingDelete = confirmDeleteId === item.id;
          const rowBusy =
            hostDown ||
            testingId === item.id ||
            refreshingCacheId === item.id ||
            refreshingAllCaches;

          return (
            <SettingRow
              key={item.id}
              title={
                <span className="kpbl-row-title-line">
                  <span>{item.name}</span>
                  <Badge outline>{item.id}</Badge>
                  <StatusDot status={status.dotState} label={status.label} showLabel />
                </span>
              }
              description={
                <span className="kpbl-row-subline">
                  <MiddleTruncate mono maxChars={58} text={commandPreview} />
                  <span>· {cacheInfo.summary}</span>
                </span>
              }
              control={
                <>
                  <Button
                    variant="outline"
                    size="xs"
                    aria-label={`检测 ${item.name} 连接`}
                    loading={testingId === item.id}
                    disabled={rowBusy}
                    onClick={() => onRunProbe(item)}
                  >
                    {testingId === item.id ? '检测中…' : '检测连接'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    leadingIcon="arrows-clockwise"
                    aria-label={`刷新 ${item.name} 模型缓存`}
                    loading={refreshingCacheId === item.id}
                    disabled={rowBusy}
                    onClick={() => onRefreshCache(item)}
                  >
                    {refreshingCacheId === item.id
                      ? '刷新中…'
                      : cacheInfo.cached
                        ? '刷新缓存'
                        : '拉取缓存'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    aria-label={`编辑 ${item.name}`}
                    disabled={hostDown || busy}
                    onClick={() => onEditCustom(item)}
                  >
                    编辑
                  </Button>
                  {confirmingDelete ? (
                    <>
                      <Button
                        variant="danger"
                        size="xs"
                        aria-label={`确认删除 ${item.name}`}
                        disabled={hostDown || busy}
                        onClick={() => {
                          setConfirmDeleteId(undefined);
                          onRemoveCustom(item);
                        }}
                      >
                        确认删除
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setConfirmDeleteId(undefined)}
                      >
                        取消
                      </Button>
                    </>
                  ) : (
                    <IconButton
                      size="xs"
                      icon="trash"
                      aria-label={`删除 ${item.name}`}
                      disabled={hostDown || busy}
                      onClick={() => setConfirmDeleteId(item.id)}
                    />
                  )}
                  <Switch
                    size="sm"
                    checked={item.enabled}
                    disabled={hostDown || busy}
                    aria-label={`启用 ${item.name}`}
                    onCheckedChange={(checked) => onToggleEnabled(item, checked)}
                  />
                </>
              }
            >
              {probe?.reason && !probe.available ? (
                <p className="kpbl-field-error">{probe.reason}</p>
              ) : null}
            </SettingRow>
          );
        })
      )}
    </SettingSection>
  );
}
