import { Button, InputArea, LayerDialog } from '@cloudflare/kumo';
import { SlidersHorizontalIcon, TerminalWindowIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import type { Output, Workspace } from '../shared/contracts.js';

type HarnessItem = Output<'external.harnesses'>['harnesses'][number];

function transportLabel(transport: HarnessItem['transport']): string {
  if (transport === 'acp') return '原生 ACP';
  if (transport === 'claude-cli') return '原生 CLI 直连';
  if (transport === 'pi-rpc') return 'Pi 原生直连';
  return '原生 App-Server';
}

/**
 * 新建外部代理任务轻量选择弹窗。
 *
 * 前置约束与体验边界：
 * - 仅列出当前已启用的外部代理；若全部停用或尚未配置，提供一键跳转「设置 -> 外部代理」入口；
 * - 首轮任务输入为可选项：填写则创建后立即投递首轮，留空则创建空闲外部会话进入工作台。
 */
export function NewExternalDialog({
  space,
  preferredHarnessId,
  busy,
  onClose,
  onOpenSettings,
  onCreate,
}: {
  readonly space?: Workspace;
  readonly preferredHarnessId?: string;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onOpenSettings: () => void;
  readonly onCreate: (params: {
    space: Workspace;
    harnessId: string;
    prompt?: string;
  }) => void;
}) {
  const [harnesses, setHarnesses] = useState<readonly HarnessItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
    if (!space) return undefined;
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    setPrompt('');
    void window.kapibala.external
      .harnesses(space.id)
      .then((result) => {
        if (cancelled) return;
        const enabled = result.harnesses.filter((item) => item.enabled);
        setHarnesses(enabled);
        const preferred =
          preferredHarnessId && enabled.some((item) => item.id === preferredHarnessId)
            ? preferredHarnessId
            : (enabled[0]?.id ?? '');
        setSelectedId(preferred);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : '加载外部代理列表失败。');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [space, preferredHarnessId]);

  return (
    <LayerDialog
      open={Boolean(space)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <LayerDialog.Content size="base" closeLabel="关闭新建外部代理任务">
        <LayerDialog.Title>
          <span data-kapibala-modal="true">新建外部代理任务{space ? ` · ${space.name}` : ''}</span>
        </LayerDialog.Title>
        <LayerDialog.Description>
          外部代理运行于独立子进程，直接复用该工具自有权限模型与登录态。
        </LayerDialog.Description>
        <LayerDialog.Body>
          <div className="space-y-4">
            {loadError && (
              <p role="alert" className="text-xs text-kumo-danger">
                {loadError}
              </p>
            )}

            {loading ? (
              <p className="text-sm text-kumo-subtle">正在读取可用外部代理…</p>
            ) : harnesses.length === 0 ? (
              <div className="space-y-3 rounded-lg border border-kumo-line bg-kumo-recessed p-4 text-sm">
                <p className="text-kumo-default">当前没有已启用的外部代理。</p>
                <p className="text-xs text-kumo-subtle">
                  可在设置页开启内置代理（Claude Code、Codex、Pi、Antigravity、OpenCode
                  等）或添加自定义 ACP 命令。
                </p>
                <Button
                  className="kapibala-action"
                  variant="primary"
                  size="sm"
                  onClick={onOpenSettings}
                >
                  <SlidersHorizontalIcon size={15} />
                  打开设置配置外部代理
                </Button>
              </div>
            ) : (
              <>
                <div className="space-y-1.5" role="radiogroup" aria-label="选择外部代理">
                  {harnesses.map((item) => {
                    const selected = item.id === selectedId;
                    return (
                      <Button
                        key={item.id}
                        variant="ghost"
                        aria-pressed={selected}
                        className={`kapibala-action flex h-auto w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left font-normal ${
                          selected ? 'border-kumo-brand bg-kumo-recessed' : 'border-kumo-line'
                        }`}
                        onClick={() => setSelectedId(item.id)}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <TerminalWindowIcon size={16} className="shrink-0 text-kumo-brand" />
                          <span className="truncate text-sm font-medium text-kumo-default">
                            {item.name}
                          </span>
                        </span>
                        <span className="shrink-0 rounded bg-kumo-recessed px-2 py-0.5 text-xs text-kumo-subtle">
                          {transportLabel(item.transport)}
                        </span>
                      </Button>
                    );
                  })}
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="new-external-initial-prompt"
                    className="block text-xs font-medium text-kumo-subtle"
                  >
                    首轮任务说明（可选）
                  </label>
                  <InputArea
                    id="new-external-initial-prompt"
                    className="w-full"
                    aria-label="外部代理首轮任务"
                    minRows={2}
                    maxRows={5}
                    placeholder="描述要交给该外部代理执行的任务，或留空先进入会话…"
                    value={prompt}
                    onValueChange={setPrompt}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        if (space && selectedId && !busy) {
                          onCreate({
                            space,
                            harnessId: selectedId,
                            prompt: prompt.trim() || undefined,
                          });
                        }
                      }
                    }}
                  />
                </div>
              </>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <Button
                className="kapibala-action"
                variant="ghost"
                size="sm"
                onClick={onOpenSettings}
              >
                <SlidersHorizontalIcon size={14} />
                管理外部代理
              </Button>
              <div className="flex items-center gap-2">
                <Button className="kapibala-action" variant="secondary" size="sm" onClick={onClose}>
                  取消
                </Button>
                {harnesses.length > 0 && (
                  <Button
                    className="kapibala-action"
                    variant="primary"
                    size="sm"
                    disabled={!space || !selectedId || busy}
                    onClick={() => {
                      if (!space || !selectedId) return;
                      onCreate({
                        space,
                        harnessId: selectedId,
                        prompt: prompt.trim() || undefined,
                      });
                    }}
                  >
                    创建外部任务
                  </Button>
                )}
              </div>
            </div>
          </div>
        </LayerDialog.Body>
      </LayerDialog.Content>
    </LayerDialog>
  );
}
