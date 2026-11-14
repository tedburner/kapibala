import type { AgentSession } from '@kiturone/kapibala';
import type { McpServerStatus } from '@kiturone/kapibala-mcp';
import { sanitizeUntrustedOutput } from '../ui/text-safety.js';
import type { StatusFacts } from '../view-model/status.js';

/** 只读宿主观察；列表和字符串有界，省略数量显式保留，不承载原始配置、进程或执行能力。 */
export interface ManagedInspection {
  status: StatusFacts;
  branchDrift?: { createdBranch?: string; currentBranch?: string };
  skills: {
    enabled: boolean;
    entries: {
      name: string;
      description: string;
      scope: string;
      available: boolean;
      active?: string;
      reason?: string;
    }[];
    diagnostics: { code: string; message: string }[];
    omitted: number;
    diagnosticsOmitted: number;
  };
  mcp: {
    enabled: boolean;
    servers: {
      name: string;
      state: string;
      toolsState?: string;
      promptsState?: string;
      toolCount?: number;
      promptCount?: number;
      error?: string;
    }[];
    diagnostics: { code: string; message: string }[];
    omitted: number;
    diagnosticsOmitted: number;
  };
  tasksOmitted: number;
  truncated: boolean;
}

/** 将已有会话快照投影为有界观察，不扫描新目录、不启动 MCP、不确认通知或收集子任务。 */
export function projectInspection(
  input: {
    status: StatusFacts;
    branchDrift?: ManagedInspection['branchDrift'];
    skills: ReturnType<AgentSession['getSkills']>;
    skillsEnabled: boolean;
    mcpEnabled: boolean;
    servers: Array<
      Pick<McpServerStatus, 'name' | 'toolsState' | 'promptsState' | 'errorMessage'> & {
        connectionState: string;
      } & { toolCount?: number; promptCount?: number }
    >;
    mcpDiagnostics: readonly { code: string; message: string }[];
  },
  redact: (text: string) => string,
): ManagedInspection {
  let truncated = false;
  const clean = (value: string) => {
    const text = sanitizeUntrustedOutput(redact(value));
    if (text.length > 256) truncated = true;
    return text.slice(0, 256);
  };
  const take = 32;
  const diagnostics = (items: readonly { code: string; message: string }[]) =>
    items.slice(0, take).map((item) => ({ code: clean(item.code), message: clean(item.message) }));
  return {
    status: {
      ...input.status,
      model: input.status.model && clean(input.status.model),
      permissionMode: input.status.permissionMode && clean(input.status.permissionMode),
      gitBranch: input.status.gitBranch && clean(input.status.gitBranch),
      tasks: input.status.tasks?.slice(0, take).map((task) => ({
        ...task,
        agentId: clean(task.agentId),
        role: clean(task.role),
        originBranchId: clean(task.originBranchId),
        branchHint: task.branchHint && clean(task.branchHint),
        description: clean(task.description),
        summary: task.summary && clean(task.summary),
        error: task.error && clean(task.error),
      })),
    },
    branchDrift: input.branchDrift && {
      createdBranch: input.branchDrift.createdBranch && clean(input.branchDrift.createdBranch),
      currentBranch: input.branchDrift.currentBranch && clean(input.branchDrift.currentBranch),
    },
    skills: {
      enabled: input.skillsEnabled,
      entries: input.skills.skills.slice(0, take).map((skill) => ({
        name: clean(skill.name),
        description: clean(skill.description),
        scope: skill.scope,
        available: skill.available && !skill.disabled,
        active: input.skills.activations.find((item) => item.definition.name === skill.name)?.state,
        reason: skill.unavailableReason && clean(skill.unavailableReason),
      })),
      diagnostics: diagnostics(input.skills.diagnostics),
      omitted: Math.max(0, input.skills.skills.length - take) + input.skills.catalog.omitted,
      diagnosticsOmitted: Math.max(0, input.skills.diagnostics.length - take),
    },
    mcp: {
      enabled: input.mcpEnabled,
      servers: input.servers.slice(0, take).map((server) => ({
        name: clean(server.name),
        state: server.connectionState,
        toolsState: server.toolsState,
        promptsState: server.promptsState,
        toolCount: server.toolCount,
        promptCount: server.promptCount,
        error: server.errorMessage && clean(server.errorMessage),
      })),
      diagnostics: diagnostics(input.mcpDiagnostics),
      omitted: Math.max(0, input.servers.length - take),
      diagnosticsOmitted: Math.max(0, input.mcpDiagnostics.length - take),
    },
    truncated,
    tasksOmitted: Math.max(0, (input.status.tasks?.length ?? 0) - take),
  };
}
