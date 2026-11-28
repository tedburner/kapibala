import { useState } from 'react';
import type { Inspection } from '../../../shared/observations.js';
import {
  Badge,
  Button,
  EmptyState,
  MiddleTruncate,
  SettingRow,
  SettingSection,
  Switch,
} from '../../ui/index.js';
import type { McpFormDraft } from './McpServerModal.js';
import type { McpCatalog, McpServerView, SkillsCatalog } from './settings-helpers.js';

/**
 * `McpServerSection` 入参契约：
 * 承载 MCP 服务器列表展示、运行态连接摘要、启动批准与配置摘要失效重批、启停开关与增删改入口。
 */
export interface McpServerSectionProps {
  readonly workspaceId?: string;
  readonly resMcp?: McpCatalog;
  readonly inspection?: Inspection;
  readonly busy: boolean;
  readonly hostDown: boolean;
  readonly onOpenImport: () => void;
  readonly onOpenCreate: () => void;
  readonly onOpenEdit: (draft: McpFormDraft) => void;
  readonly onApprove: (name: string) => void;
  readonly onRevoke: (name: string) => void;
  readonly onToggle: (scope: 'global' | 'project', name: string, enabled: boolean) => void;
  readonly onDelete: (scope: 'global' | 'project', name: string) => void;
}

/**
 * 资源管理页上半区：MCP 服务器单层分组与动作栏。
 */
export function McpServerSection({
  workspaceId,
  resMcp,
  inspection,
  busy,
  hostDown,
  onOpenImport,
  onOpenCreate,
  onOpenEdit,
  onApprove,
  onRevoke,
  onToggle,
  onDelete,
}: McpServerSectionProps) {
  const [confirmDeleteName, setConfirmDeleteName] = useState<string>();
  const servers = resMcp?.servers ?? [];

  return (
    <SettingSection
      title="MCP 服务器"
      description="全局配置位于 ~/.kapibala/mcp.json；项目级声明仅在受信工作区可编辑。实时连接状态在打开会话后显示。"
      actions={
        <div className="kpbl-row-title-line">
          <Button
            variant="outline"
            size="xs"
            aria-label="从其它工具导入 MCP"
            disabled={!workspaceId || busy || hostDown}
            onClick={onOpenImport}
          >
            从其它工具导入
          </Button>
          <Button
            variant="solid"
            size="xs"
            leadingIcon="plus"
            disabled={!workspaceId || busy || hostDown}
            onClick={onOpenCreate}
          >
            新增服务器
          </Button>
        </div>
      }
    >
      {servers.length === 0 ? (
        <EmptyState
          icon="plugs-connected"
          title="未配置任何 MCP 服务器。"
          description="点击右上角「新增服务器」手动登记，或从本机已有工具导入。"
        />
      ) : (
        servers.map((server: McpServerView) => {
          const editable = server.source === 'global' || Boolean(resMcp?.projectTrusted);
          const runtime = inspection?.mcp.servers.find((item) => item.name === server.name);
          const digestChanged = Boolean(
            server.approval && !server.approval.approved && server.approval.approvedAt,
          );
          return (
            <SettingRow
              key={`${server.source}:${server.name}`}
              title={
                <span className="kpbl-row-title-line">
                  <span>{server.name}</span>
                  <Badge outline>
                    {server.source === 'project'
                      ? editable
                        ? '项目级'
                        : '项目级（只读）'
                      : '全局'}
                  </Badge>
                  <Badge>{server.type === 'http' ? 'HTTP' : 'stdio'}</Badge>
                  {server.approval ? (
                    <Badge tone={server.approval.approved ? 'success' : 'warning'}>
                      {server.approval.approved
                        ? '启动已批准'
                        : digestChanged
                          ? '配置摘要已变化 · 待重批'
                          : '待启动批准'}
                    </Badge>
                  ) : null}
                </span>
              }
              description={
                <span className="kpbl-row-subline">
                  <MiddleTruncate mono maxChars={56} text={server.target || '（无目标）'} />
                  {runtime ? (
                    <span>
                      · 连接: {runtime.state} · 工具: {runtime.toolsState ?? '未知'}（
                      {runtime.toolCount ?? 0} 个）
                      {runtime.error ? ` · ${runtime.error}` : ''}
                    </span>
                  ) : null}
                </span>
              }
              control={
                editable ? (
                  <>
                    {server.approval ? (
                      server.approval.approved ? (
                        <Button
                          variant="ghost"
                          size="xs"
                          aria-label={`撤销批准 ${server.name}`}
                          disabled={busy || hostDown}
                          onClick={() => onRevoke(server.name)}
                        >
                          撤销批准
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="xs"
                          aria-label={`批准 ${server.name}`}
                          disabled={busy || hostDown}
                          onClick={() => onApprove(server.name)}
                        >
                          批准
                        </Button>
                      )
                    ) : null}
                    <Button
                      variant="ghost"
                      size="xs"
                      aria-label={`编辑 ${server.name}`}
                      disabled={busy || hostDown}
                      onClick={() =>
                        onOpenEdit({
                          editName: server.name,
                          scope: server.source,
                          name: server.name,
                          type: server.type === 'http' ? 'http' : 'stdio',
                          command: server.edit?.command ?? '',
                          args: server.edit?.args?.join(' ') ?? '',
                          url: server.edit?.url ?? '',
                          keepTransport: !server.edit,
                        })
                      }
                    >
                      编辑
                    </Button>
                    {confirmDeleteName === server.name ? (
                      <Button
                        variant="danger"
                        size="xs"
                        disabled={busy || hostDown}
                        onClick={() => {
                          setConfirmDeleteName(undefined);
                          onDelete(server.source, server.name);
                        }}
                      >
                        确认删除
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="xs"
                        aria-label={`删除 ${server.name}`}
                        disabled={busy || hostDown}
                        onClick={() => setConfirmDeleteName(server.name)}
                      >
                        删除
                      </Button>
                    )}
                    <Switch
                      size="sm"
                      checked={server.enabled}
                      disabled={busy || hostDown}
                      aria-label={`启用 ${server.name}`}
                      onCheckedChange={(checked) => onToggle(server.source, server.name, checked)}
                    />
                  </>
                ) : undefined
              }
            >
              {server.hasSecretSurface || server.diagnostics.length > 0 ? (
                <div className="kpbl-dialog-stack">
                  {server.hasSecretSurface ? (
                    <p className="kpbl-field-hint">
                      包含环境变量或请求头声明（凭证不回显，面板编辑保留原文）。
                    </p>
                  ) : null}
                  {server.diagnostics.map((d) => (
                    <p key={`${d.code}:${d.message}`} className="kpbl-field-hint">
                      [{d.severity}] [{d.code}] {d.message}
                    </p>
                  ))}
                </div>
              ) : null}
            </SettingRow>
          );
        })
      )}
    </SettingSection>
  );
}

/**
 * `SkillsSection` 入参契约：
 * 承载全局与项目技能功能总开关、逐技能启停状态、不可用原因及解析诊断列表。
 */
export interface SkillsSectionProps {
  readonly workspaceId?: string;
  readonly resSkills?: SkillsCatalog;
  readonly busy: boolean;
  readonly hostDown: boolean;
  readonly onOpenImport: () => void;
  readonly onToggleMaster: (enabled: boolean) => void;
  readonly onToggleSkill: (name: string, enabled: boolean) => void;
}

/**
 * 资源管理页下半区：技能生命周期与跨工具导入入口。
 */
export function SkillsSection({
  workspaceId,
  resSkills,
  busy,
  hostDown,
  onOpenImport,
  onToggleMaster,
  onToggleSkill,
}: SkillsSectionProps) {
  const skills = resSkills?.skills ?? [];

  return (
    <SettingSection
      title="技能（Skills）"
      description="管理全局与工作区技能包的启停状态与解析诊断，支持从外部编码工具一次性导入。"
      actions={
        <Button
          variant="outline"
          size="xs"
          disabled={!workspaceId || busy || hostDown}
          onClick={onOpenImport}
        >
          从其它工具导入
        </Button>
      }
    >
      <SettingRow
        title="启用技能功能"
        description="关闭后新建会话不再向模型注册技能工具；运行中的会话保持不变。"
        control={
          <Switch
            size="sm"
            checked={resSkills?.enabled ?? true}
            disabled={busy || hostDown}
            aria-label="启用技能功能"
            onCheckedChange={onToggleMaster}
          />
        }
      />
      {skills.map((skill) => (
        <SettingRow
          key={skill.name}
          title={
            <span className="kpbl-row-title-line">
              <span>{skill.name}</span>
              <Badge outline>{skill.scope}</Badge>
              {skill.disabled ? (
                <Badge>已禁用</Badge>
              ) : !skill.available ? (
                <Badge tone="warning">不可用</Badge>
              ) : null}
            </span>
          }
          description={
            !skill.available && skill.unavailableReason
              ? `${skill.description || skill.filePath} · 原因：${skill.unavailableReason}`
              : skill.description || skill.filePath || '目录中暂无同名技能'
          }
          control={
            <Switch
              size="sm"
              checked={!skill.disabled}
              disabled={busy || hostDown}
              aria-label={`启用 ${skill.name}`}
              onCheckedChange={(checked) => onToggleSkill(skill.name, checked)}
            />
          }
        />
      ))}
      {(resSkills?.diagnostics ?? []).map((diag) => (
        <SettingRow
          key={`${diag.code}:${diag.path}:${diag.message}`}
          title={`[${diag.code}] ${diag.message}`}
          description={<MiddleTruncate mono maxChars={60} text={diag.path} />}
        />
      ))}
    </SettingSection>
  );
}
