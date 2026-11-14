import {
  loadSettings,
  mutateGlobalMcpConfig,
  mutateGlobalSettings,
  readMcpResourceSnapshot,
  readSkillsResourceSnapshot,
} from '@kiturone/kapibala-host/internal';
import type { Output, Params } from '../shared/contracts.js';
import type { Workspaces } from './workspaces.js';

/**
 * 资源管理服务：MCP 服务器配置与技能开关/清单的宿主侧投影。
 *
 * 约束与边界：
 * - 全部写操作走宿主层短事务（mutateGlobalMcpConfig / mutateGlobalSettings），服务层不自行落盘；
 * - 项目级 MCP 声明只读：delete/toggle 对 project 来源一律拒绝，不提供绕过信任防线的入口；
 * - MCP 编辑保留面板外字段（env/headers/required 等原文），密钥类值不进服务层往返。
 */
export class ResourceService {
  constructor(private readonly workspaces: Workspaces) {}

  private context(workspaceId: string): {
    root: string;
    trusted: boolean;
    home: string;
  } {
    const workspace = this.workspaces.get(workspaceId);
    return {
      root: workspace.root,
      trusted: workspace.trusted,
      home: this.workspaces.home,
    };
  }

  /** 全局 + 项目声明的只读投影；诊断已过脱敏管道。 */
  readMcp(workspaceId: string): Output<'resources.readMcp'> {
    const { root, trusted, home } = this.context(workspaceId);
    const snapshot = readMcpResourceSnapshot({
      homeDir: home,
      projectRoot: root,
      isProjectTrusted: trusted,
    });
    return {
      projectTrusted: snapshot.projectTrusted,
      servers: snapshot.servers,
      diagnostics: snapshot.diagnostics,
    };
  }

  /**
   * 新增或编辑全局服务器；编辑保留声明中面板外的字段，改名即移动键位。
   * `keepTransport` 表示原传输声明不满足面板编辑条件（目标串内嵌密钥，快照未提供
   * 未脱敏回填面）：此时保留原 type/command/args/url 原文，仅允许改名与启停，
   * 绝不能用脱敏摘要回写传输字段。
   */
  saveMcpServer(params: Params<'resources.saveMcpServer'>): Output<'resources.readMcp'> {
    const { home } = this.context(params.workspaceId);
    mutateGlobalMcpConfig(
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
      { homeDir: home },
    );
    return this.readMcp(params.workspaceId);
  }

  /** 删除全局服务器；项目级声明只读，拒绝删除。 */
  deleteMcpServer(params: Params<'resources.deleteMcpServer'>): Output<'resources.readMcp'> {
    const { home } = this.context(params.workspaceId);
    mutateGlobalMcpConfig(
      (file) => {
        if (file.mcpServers?.[params.name] === undefined)
          throw new Error(
            `MCP_SERVER_NOT_FOUND: '${params.name}' 不在全局配置中（项目级声明只读）`,
          );
        delete file.mcpServers[params.name];
      },
      { homeDir: home },
    );
    return this.readMcp(params.workspaceId);
  }

  /** 全局服务器启停（enabled 字段写回）；项目级声明只读，拒绝启停。 */
  toggleMcpServer(params: Params<'resources.toggleMcpServer'>): Output<'resources.readMcp'> {
    const { home } = this.context(params.workspaceId);
    mutateGlobalMcpConfig(
      (file) => {
        const raw = file.mcpServers?.[params.name];
        if (raw === undefined)
          throw new Error(
            `MCP_SERVER_NOT_FOUND: '${params.name}' 不在全局配置中（项目级声明只读）`,
          );
        file.mcpServers = file.mcpServers ?? {};
        file.mcpServers[params.name] = {
          ...(raw as Record<string, unknown>),
          enabled: params.enabled,
        };
      },
      { homeDir: home },
    );
    return this.readMcp(params.workspaceId);
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
