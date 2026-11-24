import type {
  ExternalHarnessWireItem,
  ExternalProbeWire,
  ExternalSessionWireItem,
  ExternalSnapshotWire,
  ExternalTemplateWireItem,
} from '@kiturone/kapibala-host/protocol';
import type {
  ViewExternalHarness,
  ViewExternalHarnessProbe,
  ViewExternalSession,
  ViewExternalSnapshot,
  ViewExternalTemplate,
} from '@kiturone/kapibala-host/view-model';

/** 将视图层探测结果（`undefined` 可选字段）映射为协议层显式 `null` 形状。 */
export function toExternalProbeWire(probe: ViewExternalHarnessProbe): ExternalProbeWire {
  return {
    available: probe.available,
    status: probe.status,
    agentName: probe.agentName ?? null,
    version: probe.version ?? null,
    loadSupported: probe.loadSupported,
    reason: probe.reason ?? null,
    loginHint: probe.loginHint ?? null,
    installHint: probe.installHint ?? null,
  };
}

/** 将视图层外部代理定义映射为协议层 wire 条目。 */
export function toExternalHarnessWire(item: ViewExternalHarness): ExternalHarnessWireItem {
  return {
    id: item.id,
    name: item.name,
    transport: item.transport,
    command: item.command,
    args: [...item.args],
    envFrom: [...item.envFrom],
    builtin: item.builtin,
    registryId: item.registryId ?? null,
    hasOverride: item.hasOverride,
    enabled: item.enabled,
    probe: item.probe ? toExternalProbeWire(item.probe) : null,
  };
}

/** 将官方 ACP 模板映射为协议层 wire 条目。 */
export function toExternalTemplateWire(item: ViewExternalTemplate): ExternalTemplateWireItem {
  return {
    registryId: item.registryId,
    name: item.name,
    description: item.description,
    command: item.command,
    args: [...item.args],
    envFrom: [...(item.envFrom ?? [])],
    installHint: item.installHint,
    loginHint: item.loginHint ?? null,
    website: item.website ?? null,
  };
}

/** 将外部会话摘要映射为协议层 wire 条目。 */
export function toExternalSessionWire(item: ViewExternalSession): ExternalSessionWireItem {
  return {
    id: item.id,
    harnessId: item.harnessId,
    harnessName: item.harnessName,
    transport: item.transport,
    workspaceRoot: item.workspaceRoot,
    title: item.title,
    status: item.status,
    resumable: item.resumable,
    canContinue: item.canContinue,
    hasArchive: item.hasArchive,
    pendingApprovalCount: item.pendingApprovalCount,
    modelLabel: item.modelLabel ?? null,
    modeLabel: item.modeLabel ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    lastError: item.lastError ?? null,
  };
}

/** 将外部会话完整快照映射为协议层 wire 形状。 */
export function toExternalSnapshotWire(snap: ViewExternalSnapshot): ExternalSnapshotWire {
  return {
    session: toExternalSessionWire(snap.session),
    sequence: snap.sequence,
    truncatedArchive: Boolean(snap.truncatedArchive),
    messages: snap.messages.map((msg) => ({
      id: msg.id,
      role: msg.role,
      state: msg.state,
      persisted: msg.persisted,
      blocks: msg.blocks.map((b) => ({
        id: b.id,
        kind: b.kind,
        text: b.text,
        state: b.state,
        revision: b.revision,
        tool: b.tool
          ? {
              callId: b.tool.callId,
              name: b.tool.name,
              displayName: b.tool.displayName,
              invocation: b.tool.invocation,
              verb: b.tool.verb ?? null,
              chip: b.tool.chip ?? null,
              mono: Boolean(b.tool.mono),
              input: b.tool.input,
              status: b.tool.status,
              result: b.tool.result ?? null,
            }
          : null,
      })),
      usage: msg.usage
        ? {
            promptTokens: msg.usage.promptTokens,
            completionTokens: msg.usage.completionTokens,
            totalTokens: msg.usage.totalTokens,
          }
        : null,
    })),
    approvals: snap.approvals.map((a) => ({
      approvalId: a.approvalId,
      sessionId: a.sessionId,
      toolCallId: a.toolCallId,
      toolTitle: a.toolTitle,
      target: a.target ?? null,
      warning: a.warning ?? null,
      options: a.options.map((o) => ({
        optionId: o.optionId,
        label: o.label,
        kind: o.kind,
      })),
      expiresAt: a.expiresAt,
    })),
    plan: snap.plan
      ? {
          items: snap.plan.items.map((i) => ({
            id: i.id,
            title: i.title,
            status: i.status,
          })),
          updatedAt: snap.plan.updatedAt ?? null,
          revision: snap.plan.revision,
        }
      : null,
    notices: snap.notices.map((n) => ({
      id: n.id,
      level: n.level,
      text: n.text,
    })),
  };
}
