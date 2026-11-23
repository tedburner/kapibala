import {
  type McpImportCandidate,
  McpServerApprovalStore,
  importMcpServers,
  loadSettings,
  mutateGlobalSettings,
  mutateMcpConfig,
  readMcpApprovalEntries,
  readMcpResourceSnapshot,
  readSkillsResourceSnapshot,
  importSkills as runSkillImport,
  scanImportableMcpServers,
  scanImportableSkills as scanSkillImport,
} from '@kiturone/kapibala-host/internal';
import type { Output, Params } from '../shared/contracts.js';
import type { Workspaces } from './workspaces.js';

/**
 * 资源管理服务：MCP 服务器配置与技能开关/清单的宿主侧投影。
 *
 * 约束与边界：
 * - 全部写操作走宿主层短事务（mutateMcpConfig / mutateGlobalSettings），服务层不自行落盘；
 *   项目级 MCP 写入的信任门由 `mutateMcpConfig` 统一判定，未信任必然失败；
 * - MCP 编辑保留面板外字段（env/headers/required 等原文），密钥类值不进服务层往返；
 * - MCP 导入只向页面返回脱敏投影，候选携带的完整配置（含 env / headers 值）留在宿主进程。
 */
export class ResourceService {
  constructor(private readonly workspaces: Workspaces) {}

  private context(workspaceId: string): {
    root: string;
    trusted: boolean;
    home: string;
  } {
    const workspace = this.workspaces.get(workspaceId);
    return { root: workspace.root, trusted: workspace.trusted, home: this.workspaces.home };
  }

  /** 当前工作区对应的 MCP 配置事务目标；项目级信任门在宿主事务内复核。 */
  private mcpTarget(
    context: { root: string; trusted: boolean; home: string },
    scope: 'global' | 'project' | undefined,
  ): {
    scope?: 'global' | 'project';
    homeDir: string;
    projectRoot: string;
    projectTrusted: boolean;
  } {
    return {
      ...(scope ? { scope } : {}),
      homeDir: context.home,
      projectRoot: context.root,
      projectTrusted: context.trusted,
    };
  }

  /** 全局 + 项目声明的只读投影；诊断已过脱敏管道，并并入逐服务器批准状态。 */
  readMcp(workspaceId: string): Output<'resources.readMcp'> {
    const context = this.context(workspaceId);
    const snapshot = readMcpResourceSnapshot({
      homeDir: context.home,
      projectRoot: context.root,
      isProjectTrusted: context.trusted,
    });
    const entries = readMcpApprovalEntries({
      homeDir: context.home,
      projectRoot: context.root,
      projectTrusted: context.trusted,
    });
    const store = new McpServerApprovalStore({
      homeDir: context.home,
      projectRoot: context.root,
    });
    return {
      projectTrusted: snapshot.projectTrusted,
      servers: snapshot.servers.map((server) => {
        const entry = entries.get(server.name);
        // 未进入条目表（未信任项目声明、配置损坏）不展示批准态：它本来就不会启动。
        if (!entry) return server;
        let approval: { approved: boolean; approvedAt?: string };
        try {
          const status = store.status({
            name: server.name,
            source: entry.source,
            config: entry.config,
          });
          approval = {
            approved: status.approved,
            ...(status.approvedAt ? { approvedAt: status.approvedAt } : {}),
          };
        } catch {
          approval = { approved: false };
        }
        return { ...server, approval };
      }),
      diagnostics: snapshot.diagnostics,
    };
  }

  /**
   * 新增或编辑服务器；编辑保留声明中面板外的字段，改名即移动键位。
   * `keepTransport` 表示原传输声明不满足面板编辑条件（目标串内嵌密钥，快照未提供
   * 未脱敏回填面）：此时保留原 type/command/args/url 原文，仅允许改名与启停，
   * 绝不能用脱敏摘要回写传输字段。
   */
  saveMcpServer(params: Params<'resources.saveMcpServer'>): Output<'resources.readMcp'> {
    const context = this.context(params.workspaceId);
    mutateMcpConfig(
      (file) => {
        file.mcpServers ??= {};
        const sourceName = params.editName ?? params.draft.name;
        const original = (file.mcpServers[sourceName] ?? {}) as Record<string, unknown>;
        if (params.editName && params.editName !== params.draft.name)
          delete file.mcpServers[params.editName];
        const next: Record<string, unknown> = { ...original };
        if (!params.keepTransport && params.draft.type === 'http') {
          next.type = 'http';
          next.url = params.draft.url;
          next.command = undefined;
          next.args = undefined;
        } else if (!params.keepTransport) {
          next.type = 'stdio';
          next.command = params.draft.command;
          if (params.draft.args?.length) next.args = params.draft.args;
          else next.args = undefined;
          next.url = undefined;
        }
        // 编辑不改变启停状态：enabled 是独立开关（resources.toggleMcpServer）；
        // 未显式提供时保留原声明值，新增缺省启用。
        next.enabled =
          params.draft.enabled ?? (typeof original.enabled === 'boolean' ? original.enabled : true);
        file.mcpServers[params.draft.name] = next;
      },
      this.mcpTarget(context, params.scope),
    );
    return this.readMcp(params.workspaceId);
  }

  /** 删除服务器；目标作用域内不存在即拒绝，不跨作用域误删同名声明。 */
  deleteMcpServer(params: Params<'resources.deleteMcpServer'>): Output<'resources.readMcp'> {
    const context = this.context(params.workspaceId);
    mutateMcpConfig(
      (file) => {
        if (file.mcpServers?.[params.name] === undefined)
          throw new Error(
            `MCP_SERVER_NOT_FOUND: '${params.name}' 不在${params.scope === 'project' ? '项目' : '全局'}配置中`,
          );
        delete file.mcpServers[params.name];
      },
      this.mcpTarget(context, params.scope),
    );
    return this.readMcp(params.workspaceId);
  }

  /** 服务器启停（enabled 字段写回目标作用域）；项目级只在受信项目上可写。 */
  toggleMcpServer(params: Params<'resources.toggleMcpServer'>): Output<'resources.readMcp'> {
    const context = this.context(params.workspaceId);
    mutateMcpConfig(
      (file) => {
        const raw = file.mcpServers?.[params.name];
        if (raw === undefined)
          throw new Error(
            `MCP_SERVER_NOT_FOUND: '${params.name}' 不在${params.scope === 'project' ? '项目' : '全局'}配置中`,
          );
        file.mcpServers = file.mcpServers ?? {};
        file.mcpServers[params.name] = {
          ...(raw as Record<string, unknown>),
          enabled: params.enabled,
        };
      },
      this.mcpTarget(context, params.scope),
    );
    return this.readMcp(params.workspaceId);
  }

  /** 批准单个服务器启动：以当前配置摘要落盘，不读取也不回显任何配置值。 */
  approveMcpServer(params: Params<'resources.approveMcpServer'>): Output<'resources.readMcp'> {
    const context = this.context(params.workspaceId);
    const entry = readMcpApprovalEntries({
      homeDir: context.home,
      projectRoot: context.root,
      projectTrusted: context.trusted,
    }).get(params.name);
    if (!entry)
      throw new Error(`MCP_SERVER_NOT_FOUND: '${params.name}' 不在可批准的配置中（检查 mcp.json）`);
    new McpServerApprovalStore({
      homeDir: context.home,
      projectRoot: context.root,
    }).approve({ name: params.name, ...entry });
    return this.readMcp(params.workspaceId);
  }

  /** 撤销批准；条目已不存在时同时尝试两个作用域，避免改名后残留无法清理。 */
  revokeMcpServer(params: Params<'resources.revokeMcpServer'>): Output<'resources.readMcp'> {
    const context = this.context(params.workspaceId);
    const store = new McpServerApprovalStore({
      homeDir: context.home,
      projectRoot: context.root,
    });
    const entry = readMcpApprovalEntries({
      homeDir: context.home,
      projectRoot: context.root,
      projectTrusted: context.trusted,
    }).get(params.name);
    if (entry) store.revoke(params.name, entry.source);
    else {
      store.revoke(params.name, 'global');
      store.revoke(params.name, 'project');
    }
    return this.readMcp(params.workspaceId);
  }

  /** 扫描外部工具的 MCP 声明；返回脱敏投影，配置正文不进入 renderer。 */
  inspectMcpImport(
    params: Params<'resources.inspectMcpImport'>,
  ): Output<'resources.inspectMcpImport'> {
    const context = this.context(params.workspaceId);
    const scope = params.scope ?? 'global';
    this.assertImportScope(context.trusted, scope);
    const scan = scanImportableMcpServers({
      homeDir: context.home,
      projectRoot: context.root,
      projectTrusted: context.trusted,
      scope,
    });
    return {
      sources: scan.sources,
      candidates: scan.candidates.map(projectMcpImportCandidate),
      diagnostics: scan.diagnostics,
    };
  }

  /** 执行导入；冲突默认跳过，`overwrite` 才替换，写入复用宿主配置事务。 */
  importMcp(params: Params<'resources.importMcp'>): Output<'resources.importMcp'> {
    const context = this.context(params.workspaceId);
    this.assertImportScope(context.trusted, params.scope);
    return importMcpServers({
      homeDir: context.home,
      projectRoot: context.root,
      projectTrusted: context.trusted,
      scope: params.scope,
      items: params.items,
      overwrite: params.overwrite,
    });
  }

  /** 项目级导入在未信任项目上直接拒绝，不进入确认流程、不读取仓库来源。 */
  private assertImportScope(trusted: boolean, scope: 'global' | 'project'): void {
    if (scope === 'project' && !trusted)
      throw new Error('MCP_PROJECT_UNTRUSTED: 项目未被信任，拒绝写入项目级 MCP 配置');
  }

  /** 技能清单快照（无会话轻投影，与会话装配同源）。 */
  async readSkills(workspaceId: string): Promise<Output<'resources.readSkills'>> {
    const { root, trusted, home } = this.context(workspaceId);
    const loaded = loadSettings({
      homeDir: home,
      cwd: root,
      includeProject: trusted,
    });
    const snapshot = await readSkillsResourceSnapshot({
      settings: loaded.settings,
      homeDir: home,
      cwd: root,
      projectRoot: root,
    });
    return toSkillsOutput(snapshot);
  }

  /** 全局技能开关；写回后回读清单。 */
  async setSkillsEnabled(
    params: Params<'resources.setSkillsEnabled'>,
  ): Promise<Output<'resources.readSkills'>> {
    const { home } = this.context(params.workspaceId);
    mutateGlobalSettings(
      (draft) => {
        draft.skills = { ...(draft.skills ?? {}), enabled: params.enabled };
      },
      { homeDir: home },
    );
    return await this.readSkills(params.workspaceId);
  }

  /** 逐技能禁用/恢复；未知名称允许登记（目录出现同名技能时继续排除）。 */
  async setSkillDisabled(
    params: Params<'resources.setSkillDisabled'>,
  ): Promise<Output<'resources.readSkills'>> {
    const { home } = this.context(params.workspaceId);
    mutateGlobalSettings(
      (draft) => {
        const list = new Set(draft.skills?.disabled ?? []);
        if (params.disabled) list.add(params.name);
        else list.delete(params.name);
        draft.skills = { ...(draft.skills ?? {}), disabled: [...list] };
      },
      { homeDir: home },
    );
    return await this.readSkills(params.workspaceId);
  }

  /**
   * 扫描外部 Harness 的可导入技能（打开导入抽屉或切换目标作用域时调用）。
   *
   * 边界：未信任项目只扫描全局来源；项目来源目录不读取，避免在用户确认信任前触碰仓库内容。
   */
  async inspectSkills(
    params: Params<'resources.inspectSkills'>,
  ): Promise<Output<'resources.inspectSkills'>> {
    const { root, trusted, home } = this.context(params.workspaceId);
    const loaded = loadSettings({ homeDir: home, cwd: root, includeProject: trusted });
    return await scanSkillImport({
      homeDir: home,
      projectRoot: root,
      projectTrusted: trusted,
      settings: loaded.settings,
      scope: params.scope,
    });
  }

  /** 执行导入；正文与原子写全部交给宿主导入服务，服务层不另起写路径。 */
  async importSkills(
    params: Params<'resources.importSkills'>,
  ): Promise<Output<'resources.importSkills'>> {
    const { root, trusted, home } = this.context(params.workspaceId);
    const loaded = loadSettings({ homeDir: home, cwd: root, includeProject: trusted });
    return await runSkillImport({
      homeDir: home,
      projectRoot: root,
      projectTrusted: trusted,
      settings: loaded.settings,
      scope: params.scope,
      items: params.items,
      overwrite: params.overwrite,
    });
  }
}

/** 候选投影：丢弃完整配置与摘要，只保留页面可安全展示的发现事实。 */
function projectMcpImportCandidate(candidate: McpImportCandidate) {
  return {
    harness: candidate.harness,
    name: candidate.name,
    sourceRef: candidate.sourceRef,
    origin: candidate.origin,
    transport: candidate.transport,
    target: candidate.target,
    hasSecretSurface: candidate.hasSecretSurface,
    strippedFields: candidate.strippedFields,
    ...(candidate.nameProblem ? { nameProblem: candidate.nameProblem } : {}),
    conflict: candidate.conflict,
    ...(candidate.previouslyImported ? { previouslyImported: candidate.previouslyImported } : {}),
  };
}

function toSkillsOutput(
  snapshot: Awaited<ReturnType<typeof readSkillsResourceSnapshot>>,
): Output<'resources.readSkills'> {
  return {
    enabled: snapshot.enabled,
    skills: snapshot.skills,
    diagnostics: snapshot.diagnostics,
  };
}
