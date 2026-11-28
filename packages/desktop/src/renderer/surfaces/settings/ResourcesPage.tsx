import { useCallback, useEffect, useState } from 'react';
import type { Inspection } from '../../../shared/observations.js';
import { EmptyState } from '../../ui/index.js';
import { type McpFormDraft, McpServerModal } from './McpServerModal.js';
import { McpServerSection, SkillsSection } from './McpServerSection.js';
import {
  McpImportPanel,
  type McpImportResultView,
  type McpImportScanView,
  SkillImportPanel,
  type SkillImportResultView,
  type SkillImportScanView,
  resourceImportKey,
} from './ResourceImportPanels.js';
import { type McpCatalog, type SkillsCatalog, withSettingsWatchdog } from './settings-helpers.js';

/**
 * `ResourcesPage` 入参契约（017 §6.7 & §7）：
 * 统一承载 MCP 服务器管理（启停、新建/编辑、启动批准与配置摘要核验、跨工具导入）及技能生命周期管理。
 */
export interface ResourcesPageProps {
  readonly active?: boolean;
  readonly workspaceId?: string;
  readonly inspection?: Inspection;
  readonly hostDown?: boolean;
  readonly report?: (message: string) => void;
  readonly initialMcp?: McpCatalog;
  readonly initialSkills?: SkillsCatalog;
}

/**
 * 壳内设置中心「资源管理」页面。
 */
export function ResourcesPage({
  active = true,
  workspaceId,
  inspection,
  hostDown = false,
  report,
  initialMcp,
  initialSkills,
}: ResourcesPageProps) {
  const [resMcp, setResMcp] = useState<McpCatalog | undefined>(initialMcp);
  const [resSkills, setResSkills] = useState<SkillsCatalog | undefined>(initialSkills);
  const [mcpDraft, setMcpDraft] = useState<McpFormDraft>();
  const [resBusy, setResBusy] = useState(false);
  const [resError, setResError] = useState('');

  const [mcpImportOpen, setMcpImportOpen] = useState(false);
  const [mcpImportScope, setMcpImportScope] = useState<'global' | 'project'>('global');
  const [mcpImportOverwrite, setMcpImportOverwrite] = useState(false);
  const [mcpImportBusy, setMcpImportBusy] = useState(false);
  const [mcpImportError, setMcpImportError] = useState('');
  const [mcpImportScan, setMcpImportScan] = useState<McpImportScanView>();
  const [mcpImportSelected, setMcpImportSelected] = useState<ReadonlySet<string>>(new Set());
  const [mcpImportResult, setMcpImportResult] = useState<McpImportResultView>();

  const [skillImportOpen, setSkillImportOpen] = useState(false);
  const [skillImportScope, setSkillImportScope] = useState<'global' | 'project'>('global');
  const [skillImportBusy, setSkillImportBusy] = useState(false);
  const [skillImportError, setSkillImportError] = useState('');
  const [skillImportScan, setSkillImportScan] = useState<SkillImportScanView>();
  const [skillImportSelected, setSkillImportSelected] = useState<ReadonlySet<string>>(new Set());
  const [skillImportResult, setSkillImportResult] = useState<SkillImportResultView>();

  const loadResources = useCallback(() => {
    if (!workspaceId || hostDown || typeof window === 'undefined' || !window.kapibala) return;
    void window.kapibala.resources
      .readMcp(workspaceId)
      .then(setResMcp)
      .catch((err: unknown) => report?.(err instanceof Error ? err.message : '读取 MCP 失败。'));
    void window.kapibala.resources
      .readSkills(workspaceId)
      .then(setResSkills)
      .catch((err: unknown) => report?.(err instanceof Error ? err.message : '读取技能失败。'));
  }, [hostDown, report, workspaceId]);

  useEffect(() => {
    if (active) loadResources();
  }, [active, loadResources]);

  function runResourceAction(action: (wsId: string) => Promise<unknown>): void {
    if (!workspaceId || resBusy || hostDown) return;
    setResBusy(true);
    setResError('');
    void action(workspaceId)
      .then(() => loadResources())
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : '资源操作失败。';
        setResError(msg);
        report?.(msg);
      })
      .finally(() => setResBusy(false));
  }

  const scanMcpImport = useCallback(
    (scope: 'global' | 'project') => {
      if (!workspaceId || typeof window === 'undefined' || !window.kapibala) return;
      setMcpImportScan(undefined);
      setMcpImportResult(undefined);
      setMcpImportError('');
      setMcpImportBusy(true);
      void withSettingsWatchdog(
        window.kapibala.resources.inspectMcpImport({ workspaceId, scope }),
        'MCP 来源扫描超时',
        30_000,
      )
        .then((scan) => {
          setMcpImportScan(scan);
          setMcpImportSelected(new Set(scan.candidates.map(resourceImportKey)));
        })
        .catch((err: unknown) =>
          setMcpImportError(err instanceof Error ? err.message : '扫描 MCP 失败。'),
        )
        .finally(() => setMcpImportBusy(false));
    },
    [workspaceId],
  );

  function executeMcpImport(singleKey?: string): void {
    if (!workspaceId || !mcpImportScan || mcpImportBusy) return;
    if (typeof window === 'undefined' || !window.kapibala) return;
    const picked = mcpImportScan.candidates
      .filter((item) =>
        singleKey
          ? resourceImportKey(item) === singleKey
          : mcpImportSelected.has(resourceImportKey(item)),
      )
      .map((item) => ({
        harness: item.harness,
        name: item.name,
        expectedSourceRef: item.sourceRef,
      }));
    if (picked.length === 0) {
      setMcpImportError('请至少选择一个候选服务器。');
      return;
    }
    setMcpImportBusy(true);
    setMcpImportError('');
    void withSettingsWatchdog(
      window.kapibala.resources.importMcp({
        workspaceId,
        scope: mcpImportScope,
        items: picked,
        ...(mcpImportOverwrite ? { overwrite: true } : {}),
      }),
      'MCP 导入超时',
      30_000,
    )
      .then((result) => {
        setMcpImportResult(result);
        loadResources();
      })
      .catch((err: unknown) =>
        setMcpImportError(err instanceof Error ? err.message : '导入 MCP 失败。'),
      )
      .finally(() => setMcpImportBusy(false));
  }

  const scanSkillImport = useCallback(
    (scope: 'global' | 'project') => {
      if (!workspaceId || typeof window === 'undefined' || !window.kapibala) return;
      setSkillImportScan(undefined);
      setSkillImportResult(undefined);
      setSkillImportError('');
      setSkillImportBusy(true);
      void withSettingsWatchdog(
        window.kapibala.resources.inspectSkills(workspaceId, scope),
        '技能来源扫描超时',
        30_000,
      )
        .then((scan) => {
          setSkillImportScan(scan);
          setSkillImportSelected(new Set(scan.candidates.map(resourceImportKey)));
        })
        .catch((err: unknown) =>
          setSkillImportError(err instanceof Error ? err.message : '扫描技能失败。'),
        )
        .finally(() => setSkillImportBusy(false));
    },
    [workspaceId],
  );

  function executeSkillImport(singleKey?: string): void {
    if (!workspaceId || !skillImportScan || skillImportBusy) return;
    if (typeof window === 'undefined' || !window.kapibala) return;
    const picked = skillImportScan.candidates
      .filter((item) =>
        singleKey
          ? resourceImportKey(item) === singleKey
          : skillImportSelected.has(resourceImportKey(item)),
      )
      .map((item) => ({
        harness: item.harness,
        name: item.name,
        expectedSourceRef: item.sourceRef,
      }));
    if (picked.length === 0) {
      setSkillImportError('请至少选择一个候选技能。');
      return;
    }
    setSkillImportBusy(true);
    setSkillImportError('');
    void withSettingsWatchdog(
      window.kapibala.resources.importSkills({
        workspaceId,
        scope: skillImportScope,
        items: picked,
      }),
      '技能导入超时',
      30_000,
    )
      .then((result) => {
        setSkillImportResult(result);
        loadResources();
      })
      .catch((err: unknown) =>
        setSkillImportError(err instanceof Error ? err.message : '导入技能失败。'),
      )
      .finally(() => setSkillImportBusy(false));
  }

  return (
    <div className="kpbl-settings-stack">
      {!workspaceId ? (
        <EmptyState
          icon="package"
          title="暂无可用工作区上下文"
          description="请先打开默认空间或受信项目工作区以读取 MCP 与技能清单。"
        />
      ) : null}

      {resError && !mcpDraft ? (
        <div role="alert" className="kpbl-settings-banner" data-tone="danger">
          <span>{resError}</span>
        </div>
      ) : null}

      <McpServerSection
        workspaceId={workspaceId}
        resMcp={resMcp}
        inspection={inspection}
        busy={resBusy}
        hostDown={hostDown}
        onOpenImport={() => {
          setMcpImportOpen(true);
          setMcpImportScope('global');
          setMcpImportOverwrite(false);
          scanMcpImport('global');
        }}
        onOpenCreate={() =>
          setMcpDraft({ scope: 'global', name: '', type: 'stdio', command: '', args: '', url: '' })
        }
        onOpenEdit={setMcpDraft}
        onApprove={(name) =>
          runResourceAction((wsId) =>
            window.kapibala.resources.approveMcpServer({ workspaceId: wsId, name }),
          )
        }
        onRevoke={(name) =>
          runResourceAction((wsId) =>
            window.kapibala.resources.revokeMcpServer({ workspaceId: wsId, name }),
          )
        }
        onToggle={(scope, name, enabled) =>
          runResourceAction((wsId) =>
            window.kapibala.resources.toggleMcpServer({ workspaceId: wsId, scope, name, enabled }),
          )
        }
        onDelete={(scope, name) =>
          runResourceAction((wsId) =>
            window.kapibala.resources.deleteMcpServer({ workspaceId: wsId, scope, name }),
          )
        }
      />

      {mcpImportOpen ? (
        <McpImportPanel
          projectTrusted={Boolean(resMcp?.projectTrusted)}
          scope={mcpImportScope}
          overwrite={mcpImportOverwrite}
          busy={mcpImportBusy}
          error={mcpImportError || undefined}
          scan={mcpImportScan}
          selectedKeys={mcpImportSelected}
          result={mcpImportResult}
          onClose={() => setMcpImportOpen(false)}
          onScopeChange={(next) => {
            setMcpImportScope(next);
            scanMcpImport(next);
          }}
          onOverwriteChange={setMcpImportOverwrite}
          onToggleKey={(key) =>
            setMcpImportSelected((curr) => {
              const next = new Set(curr);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            })
          }
          onSelectAll={() => {
            if (mcpImportScan) {
              setMcpImportSelected(new Set(mcpImportScan.candidates.map(resourceImportKey)));
            }
          }}
          onClearSelection={() => setMcpImportSelected(new Set())}
          onRunImport={executeMcpImport}
        />
      ) : null}

      <SkillsSection
        workspaceId={workspaceId}
        resSkills={resSkills}
        busy={resBusy}
        hostDown={hostDown}
        onOpenImport={() => {
          setSkillImportOpen(true);
          setSkillImportScope('global');
          scanSkillImport('global');
        }}
        onToggleMaster={(checked) =>
          runResourceAction((wsId) =>
            window.kapibala.resources.setSkillsEnabled({ workspaceId: wsId, enabled: checked }),
          )
        }
        onToggleSkill={(name, checked) =>
          runResourceAction((wsId) =>
            window.kapibala.resources.setSkillDisabled({
              workspaceId: wsId,
              name,
              disabled: !checked,
            }),
          )
        }
      />

      {skillImportOpen ? (
        <SkillImportPanel
          projectTrusted={Boolean(resMcp?.projectTrusted)}
          scope={skillImportScope}
          busy={skillImportBusy}
          error={skillImportError || undefined}
          scan={skillImportScan}
          selectedKeys={skillImportSelected}
          result={skillImportResult}
          onClose={() => setSkillImportOpen(false)}
          onScopeChange={(next) => {
            setSkillImportScope(next);
            scanSkillImport(next);
          }}
          onToggleKey={(key) =>
            setSkillImportSelected((curr) => {
              const next = new Set(curr);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            })
          }
          onSelectAll={() => {
            if (skillImportScan) {
              setSkillImportSelected(new Set(skillImportScan.candidates.map(resourceImportKey)));
            }
          }}
          onClearSelection={() => setSkillImportSelected(new Set())}
          onRunImport={executeSkillImport}
        />
      ) : null}

      <McpServerModal
        draft={mcpDraft}
        projectTrusted={Boolean(resMcp?.projectTrusted)}
        busy={resBusy}
        error={resError || undefined}
        onChangeDraft={setMcpDraft}
        onClearError={() => setResError('')}
        onSubmit={(submitted) => {
          const payload = {
            name: submitted.name.trim(),
            type: submitted.type,
            ...(submitted.keepTransport
              ? {}
              : submitted.type === 'stdio'
                ? { command: submitted.command.trim() }
                : { url: submitted.url.trim() }),
            ...(submitted.type === 'stdio' && !submitted.keepTransport && submitted.args.trim()
              ? { args: submitted.args.trim().split(/\s+/) }
              : {}),
          };
          runResourceAction((wsId) =>
            window.kapibala.resources
              .saveMcpServer({
                workspaceId: wsId,
                scope: submitted.scope,
                editName: submitted.editName,
                ...(submitted.keepTransport ? { keepTransport: true } : {}),
                draft: payload,
              })
              .then((snapshot) => {
                setResMcp(snapshot);
                setMcpDraft(undefined);
              }),
          );
        }}
      />
    </div>
  );
}
