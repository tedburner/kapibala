import type { Output } from '../../../shared/contracts.js';
import { Badge, Button, MiddleTruncate, Select, SettingRow, Switch } from '../../ui/index.js';

/** 跨工具 MCP 导入扫描结果投影。 */
export type McpImportScanView = Output<'resources.inspectMcpImport'>;

/** 跨工具 MCP 导入执行结果投影。 */
export type McpImportResultView = Output<'resources.importMcp'>;

/** 跨工具技能导入扫描结果投影。 */
export type SkillImportScanView = Output<'resources.inspectSkills'>;

/** 跨工具技能导入执行结果投影。 */
export type SkillImportResultView = Output<'resources.importSkills'>;

/** 候选导入项唯一复合键（同名资源可来自不同外部工具，必须包含 `harness` 前缀）。 */
export function resourceImportKey(item: {
  readonly harness: string;
  readonly name: string;
}): string {
  return `${item.harness}:${item.name}`;
}

/** `McpImportPanel` 入参契约。 */
export interface McpImportPanelProps {
  readonly projectTrusted: boolean;
  readonly scope: 'global' | 'project';
  readonly overwrite: boolean;
  readonly busy: boolean;
  readonly error?: string;
  readonly scan?: McpImportScanView;
  readonly selectedKeys: ReadonlySet<string>;
  readonly result?: McpImportResultView;
  readonly onClose: () => void;
  readonly onScopeChange: (scope: 'global' | 'project') => void;
  readonly onOverwriteChange: (overwrite: boolean) => void;
  readonly onToggleKey: (key: string) => void;
  readonly onSelectAll: () => void;
  readonly onClearSelection: () => void;
  readonly onRunImport: (singleKey?: string) => void;
}

/**
 * 跨工具一次性导入 MCP 服务器折叠面板（`region[name="从其它工具导入 MCP 服务器"]`）。
 */
export function McpImportPanel({
  projectTrusted,
  scope,
  overwrite,
  busy,
  error,
  scan,
  selectedKeys,
  result,
  onClose,
  onScopeChange,
  onOverwriteChange,
  onToggleKey,
  onSelectAll,
  onClearSelection,
  onRunImport,
}: McpImportPanelProps) {
  return (
    <section aria-label="从其它工具导入 MCP 服务器" className="kpbl-setting-section">
      <div className="kpbl-setting-box">
        <SettingRow
          title="从其它工具导入 MCP 服务器"
          description="扫描 Claude Desktop、Claude Code 与 Cursor 的声明文件，一次性复制至 Kapibala。"
          control={
            <Button variant="ghost" size="xs" disabled={busy} onClick={onClose}>
              关闭导入
            </Button>
          }
        />
        <SettingRow
          title="导入到"
          description="切换目标位置后自动重新比对同名冲突。"
          control={
            <Select
              aria-label="导入到"
              size="sm"
              value={scope}
              disabled={busy}
              options={
                projectTrusted
                  ? [
                      { value: 'global', label: '全局' },
                      { value: 'project', label: '项目（需信任）' },
                    ]
                  : [{ value: 'global', label: '全局' }]
              }
              onValueChange={onScopeChange}
            />
          }
        />
        <SettingRow
          title="覆盖同名服务器"
          description="默认跳过已存在的同名服务器；开启后以来源声明替换目标配置。"
          control={
            <Switch
              size="sm"
              checked={overwrite}
              disabled={busy}
              aria-label="覆盖同名 MCP 服务器"
              onCheckedChange={onOverwriteChange}
            />
          }
        />

        {error ? (
          <SettingRow
            title={
              <span role="alert" className="kpbl-field-error">
                {error}
              </span>
            }
          />
        ) : null}

        {busy && !scan ? <SettingRow title="正在扫描外部工具配置来源…" /> : null}

        {scan ? (
          <>
            <SettingRow
              title={`发现候选服务器 ${scan.candidates.length} 个`}
              description={scan.sources
                .map((src) =>
                  src.files.length === 0
                    ? `${src.label}：未发现配置文件`
                    : `${src.label}（${src.candidates} 个）`,
                )
                .join(' · ')}
              control={
                <>
                  <Button variant="ghost" size="xs" disabled={busy} onClick={onSelectAll}>
                    全选
                  </Button>
                  <Button variant="ghost" size="xs" disabled={busy} onClick={onClearSelection}>
                    全不选
                  </Button>
                  <Button
                    variant="solid"
                    size="xs"
                    aria-label="开始导入 MCP 服务器"
                    loading={busy}
                    disabled={selectedKeys.size === 0}
                    onClick={() => onRunImport()}
                  >
                    开始导入
                  </Button>
                </>
              }
            />
            {scan.candidates.map((candidate) => {
              const key = resourceImportKey(candidate);
              return (
                <SettingRow
                  key={key}
                  title={
                    <span className="kpbl-row-title-line">
                      <span>{candidate.name}</span>
                      <Badge>{candidate.harness}</Badge>
                      <Badge outline>{candidate.transport}</Badge>
                      {candidate.conflict !== 'none' ? (
                        <Badge tone="warning">
                          {candidate.conflict === 'exists-disabled'
                            ? '目标已存在（已停用）'
                            : '目标已存在（将跳过）'}
                        </Badge>
                      ) : null}
                    </span>
                  }
                  description={
                    <MiddleTruncate
                      mono
                      maxChars={58}
                      text={candidate.target || '（无传输摘要）'}
                    />
                  }
                  control={
                    <>
                      <Button
                        variant="ghost"
                        size="xs"
                        aria-label={`单独导入 ${candidate.name}`}
                        disabled={busy || Boolean(candidate.nameProblem)}
                        onClick={() => onRunImport(key)}
                      >
                        导入此项
                      </Button>
                      <Switch
                        size="sm"
                        checked={selectedKeys.has(key)}
                        disabled={busy}
                        aria-label={`选择导入 ${candidate.name}`}
                        onCheckedChange={() => onToggleKey(key)}
                      />
                    </>
                  }
                />
              );
            })}
          </>
        ) : null}

        {result ? (
          <SettingRow
            title={`导入结果：导入 ${result.imported} · 未变 ${result.unchanged} · 跳过 ${result.skippedConflict} · 失败 ${result.failed}`}
            description={result.items
              .map(
                (item) =>
                  `${item.name} [${item.harness}] ${item.status}${item.message ? ` (${item.message})` : ''}`,
              )
              .join('；')}
          />
        ) : null}
      </div>
    </section>
  );
}

/** `SkillImportPanel` 入参契约。 */
export interface SkillImportPanelProps {
  readonly projectTrusted: boolean;
  readonly scope: 'global' | 'project';
  readonly busy: boolean;
  readonly error?: string;
  readonly scan?: SkillImportScanView;
  readonly selectedKeys: ReadonlySet<string>;
  readonly result?: SkillImportResultView;
  readonly onClose: () => void;
  readonly onScopeChange: (scope: 'global' | 'project') => void;
  readonly onToggleKey: (key: string) => void;
  readonly onSelectAll: () => void;
  readonly onClearSelection: () => void;
  readonly onRunImport: (singleKey?: string) => void;
}

/**
 * 跨工具一次性导入技能折叠面板（严格保持 `region[name="从其它工具导入技能"]` 与 `目标作用域` 选择器契约）。
 */
export function SkillImportPanel({
  projectTrusted,
  scope,
  busy,
  error,
  scan,
  selectedKeys,
  result,
  onClose,
  onScopeChange,
  onToggleKey,
  onSelectAll,
  onClearSelection,
  onRunImport,
}: SkillImportPanelProps) {
  return (
    <section aria-label="从其它工具导入技能" className="kpbl-setting-section">
      <div className="kpbl-setting-box">
        <SettingRow
          title="从其它工具导入技能"
          description="从 Claude Code、Codex、Cursor 或 OpenCode 技能目录执行一次性拷贝。"
          control={
            <Button variant="ghost" size="xs" disabled={busy} onClick={onClose}>
              关闭导入
            </Button>
          }
        />
        <SettingRow
          title="目标作用域"
          description="切换目标目录后自动重新核验同名技能冲突。"
          control={
            <Select
              aria-label="目标作用域"
              size="sm"
              value={scope}
              disabled={busy || !projectTrusted}
              options={[
                { value: 'global', label: '全局' },
                { value: 'project', label: '项目（需信任）' },
              ]}
              onValueChange={onScopeChange}
            />
          }
        />

        {error ? (
          <SettingRow
            title={
              <span role="alert" className="kpbl-field-error">
                {error}
              </span>
            }
          />
        ) : null}

        {busy && !scan ? <SettingRow title="正在扫描来源…" /> : null}

        {scan ? (
          <>
            <SettingRow
              title={`候选 ${scan.candidates.length} 个`}
              description={scan.sources
                .map((src) => `${src.label}（${src.candidates} 个）`)
                .join(' · ')}
              control={
                <>
                  <Button variant="ghost" size="xs" disabled={busy} onClick={onSelectAll}>
                    全选
                  </Button>
                  <Button variant="ghost" size="xs" disabled={busy} onClick={onClearSelection}>
                    全不选
                  </Button>
                  <Button
                    variant="solid"
                    size="xs"
                    loading={busy}
                    disabled={selectedKeys.size === 0}
                    onClick={() => onRunImport()}
                  >
                    开始导入
                  </Button>
                </>
              }
            />
            {scan.candidates.map((candidate) => {
              const key = resourceImportKey(candidate);
              const conflictText = candidate.conflict === 'none' ? '' : ' · 已存在（将跳过）';
              return (
                <SettingRow
                  key={key}
                  title={
                    <span className="kpbl-row-title-line">
                      <span>{candidate.name}</span>
                      <span className="kpbl-field-hint">
                        [{candidate.harness}] {candidate.files} 文件
                        {candidate.hasScripts ? ' · 含 scripts' : ''}
                        {conflictText}
                      </span>
                    </span>
                  }
                  description={candidate.description || candidate.sourceRef}
                  control={
                    <>
                      <Button
                        variant="ghost"
                        size="xs"
                        aria-label={`单独导入技能 ${candidate.name}`}
                        disabled={busy}
                        onClick={() => onRunImport(key)}
                      >
                        导入此项
                      </Button>
                      <Switch
                        size="sm"
                        checked={selectedKeys.has(key)}
                        disabled={busy}
                        aria-label={`选择导入 ${candidate.name}`}
                        onCheckedChange={() => onToggleKey(key)}
                      />
                    </>
                  }
                />
              );
            })}
          </>
        ) : null}

        {result ? (
          <SettingRow
            title={`导入结果：导入 ${result.imported} · 未变 ${result.unchanged} · 跳过 ${result.skippedConflict + result.skippedLimit} · 失败 ${result.failed}`}
            description={result.items
              .map(
                (item) =>
                  `${item.name} [${item.harness}] ${item.status}${item.message ? ` (${item.message})` : ''}`,
              )
              .join('；')}
          />
        ) : null}
      </div>
    </section>
  );
}
