import { useState } from 'react';
import {
  Badge,
  Button,
  MiddleTruncate,
  SettingRow,
  SettingSection,
  StatusDot,
  Switch,
  TextArea,
  TextField,
} from '../../ui/index.js';
import {
  type BuiltinOverrideDraft,
  type ExternalHarnessItem,
  type ExternalProbeResult,
  describeHarnessCache,
  probeStatusPresentation,
  transportBadgeText,
} from './external-helpers.js';
import { copyTextSafe } from './settings-helpers.js';

/**
 * `ExternalBuiltinSection` 入参契约（017 §6.7）：
 * 渲染 `region[name="内置外部代理"]` 双行左列列表与手风琴覆盖配置区。
 */
export interface ExternalBuiltinSectionProps {
  readonly builtinHarnesses: readonly ExternalHarnessItem[];
  readonly anyEnabled: boolean;
  readonly probes: Readonly<Record<string, ExternalProbeResult>>;
  readonly overrideDraft?: BuiltinOverrideDraft;
  readonly testingId?: string;
  readonly refreshingCacheId?: string;
  readonly refreshingAllCaches: boolean;
  readonly busy: boolean;
  readonly hostDown: boolean;
  readonly onRefreshAllCaches: () => void;
  readonly onRunProbe: (item: ExternalHarnessItem) => void;
  readonly onRefreshCache: (item: ExternalHarnessItem) => void;
  readonly onToggleEnabled: (item: ExternalHarnessItem, enabled: boolean) => void;
  readonly onChangeOverrideDraft: (draft: BuiltinOverrideDraft | undefined) => void;
  readonly onSaveOverride: (item: ExternalHarnessItem) => void;
  readonly onResetBuiltin: (item: ExternalHarnessItem) => void;
}

/**
 * 外部代理设置页上半区：内置 CLI / ACP 预设列表、一键检测连接、模型缓存拉取与路径覆盖手风琴。
 */
export function ExternalBuiltinSection({
  builtinHarnesses,
  anyEnabled,
  probes,
  overrideDraft,
  testingId,
  refreshingCacheId,
  refreshingAllCaches,
  busy,
  hostDown,
  onRefreshAllCaches,
  onRunProbe,
  onRefreshCache,
  onToggleEnabled,
  onChangeOverrideDraft,
  onSaveOverride,
  onResetBuiltin,
}: ExternalBuiltinSectionProps) {
  const [copiedHintKey, setCopiedHintKey] = useState<string>();

  return (
    <SettingSection
      title="内置外部代理"
      description="复用本机已安装的 CLI 工具与自有登录态；模型、推理档位与运行模式缓存在本地。"
      actions={
        <Button
          variant="outline"
          size="sm"
          leadingIcon="arrows-clockwise"
          loading={refreshingAllCaches}
          disabled={
            hostDown || busy || Boolean(testingId) || Boolean(refreshingCacheId) || !anyEnabled
          }
          onClick={onRefreshAllCaches}
        >
          {refreshingAllCaches ? '同步缓存中…' : '刷新已启用缓存'}
        </Button>
      }
    >
      {builtinHarnesses.map((item) => {
        const probe = probes[item.id] ?? item.probe;
        const status = probeStatusPresentation(probe);
        const cacheInfo = describeHarnessCache(item);
        const editing = overrideDraft?.id === item.id;
        const commandPreview = [
          item.command,
          ...item.args,
          ...(item.envFrom.length > 0 ? [`· 透传变量：${item.envFrom.join(', ')}`] : []),
        ].join(' ');
        const rowBusy =
          hostDown || testingId === item.id || refreshingCacheId === item.id || refreshingAllCaches;
        const showProbeHint = Boolean(
          probe && (!probe.available || probe.loginHint || probe.installHint),
        );

        return (
          <SettingRow
            key={item.id}
            title={
              <span className="kpbl-row-title-line">
                <span>{item.name}</span>
                <Badge>{transportBadgeText(item.transport)}</Badge>
                <StatusDot status={status.dotState} label={status.label} showLabel />
                {item.hasOverride ? <Badge tone="info">已覆盖配置</Badge> : null}
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
                  leadingIcon="plugs-connected"
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
                  leadingIcon="sliders"
                  aria-expanded={editing}
                  aria-label={`配置 ${item.name} 覆盖项`}
                  disabled={hostDown}
                  onClick={() =>
                    onChangeOverrideDraft(
                      editing
                        ? undefined
                        : {
                            id: item.id,
                            command: item.command,
                            argsText: item.args.join('\n'),
                            envFromText: item.envFrom.join(', '),
                          },
                    )
                  }
                >
                  配置覆盖
                </Button>
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
            {showProbeHint || editing ? (
              <div className="kpbl-accordion-form">
                {probe && (!probe.available || probe.loginHint || probe.installHint) ? (
                  <div className="kpbl-dialog-stack">
                    {probe.reason ? <p className="kpbl-field-hint">{probe.reason}</p> : null}
                    {probe.loginHint ? (
                      <div className="kpbl-row-title-line">
                        <span className="kpbl-field-hint">终端登录命令：</span>
                        <code className="kpbl-mono-inline">{probe.loginHint}</code>
                        <Button
                          variant="ghost"
                          size="xs"
                          leadingIcon="copy"
                          onClick={() => {
                            void copyTextSafe(probe.loginHint!).then((ok) => {
                              if (ok) setCopiedHintKey(`login:${item.id}`);
                            });
                          }}
                        >
                          {copiedHintKey === `login:${item.id}` ? '已复制' : '复制登录命令'}
                        </Button>
                      </div>
                    ) : null}
                    {probe.installHint && probe.status === 'not_installed' ? (
                      <div className="kpbl-row-title-line">
                        <span className="kpbl-field-hint">安装指引：</span>
                        <code className="kpbl-mono-inline">{probe.installHint}</code>
                        <Button
                          variant="ghost"
                          size="xs"
                          leadingIcon="copy"
                          onClick={() => {
                            void copyTextSafe(probe.installHint!).then((ok) => {
                              if (ok) setCopiedHintKey(`install:${item.id}`);
                            });
                          }}
                        >
                          {copiedHintKey === `install:${item.id}` ? '已复制' : '复制安装指引'}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {editing && overrideDraft ? (
                  <div className="kpbl-accordion-form">
                    <TextField
                      mono
                      label="可执行命令或绝对路径覆盖"
                      aria-label={`${item.name} 可执行路径`}
                      placeholder={item.command}
                      value={overrideDraft.command}
                      onValueChange={(value) =>
                        onChangeOverrideDraft({ ...overrideDraft, command: value })
                      }
                    />
                    <TextArea
                      mono
                      rows={2}
                      label="启动参数（每行作为独立参数原样传递，不经 Shell 解析）"
                      aria-label={`${item.name} 启动参数`}
                      value={overrideDraft.argsText}
                      onValueChange={(value) =>
                        onChangeOverrideDraft({ ...overrideDraft, argsText: value })
                      }
                    />
                    <TextField
                      mono
                      label="转发环境变量名白名单（只保存变量名，不保存密钥明文）"
                      aria-label={`${item.name} 转发环境变量名`}
                      placeholder="例如 DEEPSEEK_API_KEY, HTTPS_PROXY"
                      value={overrideDraft.envFromText}
                      onValueChange={(value) =>
                        onChangeOverrideDraft({ ...overrideDraft, envFromText: value })
                      }
                    />
                    <div className="kpbl-form-actions">
                      {item.hasOverride ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy || hostDown}
                          onClick={() => onResetBuiltin(item)}
                        >
                          恢复默认
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onChangeOverrideDraft(undefined)}
                      >
                        收起
                      </Button>
                      <Button
                        variant="solid"
                        size="sm"
                        loading={busy}
                        disabled={hostDown}
                        onClick={() => onSaveOverride(item)}
                      >
                        保存覆盖
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </SettingRow>
        );
      })}
    </SettingSection>
  );
}
