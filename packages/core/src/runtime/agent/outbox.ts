/**
 * @fileoverview 可靠通知投递发件箱（SubagentOutbox）与收件箱（SessionInbox）。
 *
 * 约束、边界与为什么：
 * 1. 至少一次投递与幂等去重（At-least-once & Idempotent Delivery）：
 *    通知持有基于 agentId + generation + terminalRevision 生成的全局确定性 eventId。
 *    父收件箱严格根据 eventId 去重，即使崩溃重投也绝不重复向父会话注入重复消息。
 * 2. 消息身份与权限降级：
 *    消费时通知作为带 subagent 来源的普通背景消息（协议投影为 user）持久化入父历史，
 *    绝对不能以 system 权限注入，且模型伪造文本不获得特权。
 * 3. 绝不追加第二个启动工具结果：
 *    spawn_agent 的 tool_result 在受理时已即刻闭合；通知作为独立的背景消息追加，
 *    严禁伪造或追加第二个 tool_result 污染 canonical 工具事务。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SubagentRole } from '../../capabilities/security/subagent-policy.js';
import { createMessageId } from '../../types/identity.js';
import type { CanonicalMessage } from '../../types/index.js';
import type { AgentTaskRecord, AgentTaskStatus } from './types.js';

/**
 * 收件箱与协调器所依赖的持久化消息下沉抽象契约。
 */
export interface SessionMessageSink {
  /** 获取当前活动分支标识。 */
  getActiveBranchId(): string;
  /** 追加一条持久化消息至指定分支。 */
  append(message: CanonicalMessage, options?: { branchId?: string }): Promise<unknown>;
  /** 读取现有持久化记录列表（用于启动幂等对账）。 */
  readRecords?(): Promise<ReadonlyArray<{ type: string; payload: Record<string, unknown> }>>;
}

/**
 * 子代理终态通知数据结构。
 */
export interface AgentNotification {
  /** 投递事件全局唯一幂等标识。 */
  readonly eventId: string;
  /** 任务标识。 */
  readonly agentId: string;
  /** 根任务标识。 */
  readonly rootTaskId: string;
  /** 目标父会话 ID。 */
  readonly parentSessionId: string;
  /** 派生来源分支 ID。 */
  readonly originBranchId: string;
  /** 派生来源运行轮次 ID。 */
  readonly originRunId: string;
  /** 触发派生的工具调用 ID。 */
  readonly spawnToolCallId: string;
  /** 派生代次。 */
  readonly generation: number;
  /** 角色预设。 */
  readonly role: SubagentRole;
  /** 任务描述。 */
  readonly description: string;
  /** 终态状态。 */
  readonly status: AgentTaskStatus;
  /** 终态结果摘要。 */
  readonly summary?: string;
  /** 错误信息。 */
  readonly error?: string;
  /** 产物列表。 */
  readonly artifacts?: string[];
  /** 产生时间戳。 */
  readonly timestamp: number;
}

/**
 * 格式化子代理通知内容为协议背景消息文本。
 */
export function formatNotificationContent(notification: AgentNotification): string {
  const parts: string[] = [];
  const statusLabel =
    notification.status === 'completed'
      ? '执行完成'
      : notification.status === 'cancelled'
        ? '已取消'
        : '执行失败';

  parts.push(`[子代理任务通知 · ${statusLabel}]`);
  parts.push(`- 任务: ${notification.description} (${notification.role})`);
  parts.push(`- 标识: ${notification.agentId} (代次: ${notification.generation})`);

  if (notification.summary) {
    parts.push(`- 结果摘要: ${notification.summary}`);
  }
  if (notification.error) {
    parts.push(`- 错误原因: ${notification.error}`);
  }
  if (notification.artifacts && notification.artifacts.length > 0) {
    parts.push(`- 产物文件: ${notification.artifacts.join(', ')}`);
  }

  return parts.join('\n');
}

/**
 * 子代理发件箱配置选项。
 */
export interface SubagentOutboxOptions {
  /** 可选持久化 JSONL 日志路径；配置后自动落盘并在重启时恢复未确认通知。 */
  storagePath?: string;
}

/**
 * 子代理端可靠发件箱（SubagentOutbox）。
 */
export class SubagentOutbox {
  private readonly notifications = new Map<string, AgentNotification>();
  private readonly acknowledgedEventIds = new Set<string>();
  private readonly storagePath?: string;

  constructor(options?: SubagentOutboxOptions) {
    this.storagePath = options?.storagePath;
    if (this.storagePath && fs.existsSync(this.storagePath)) {
      try {
        const content = fs.readFileSync(this.storagePath, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const entry = JSON.parse(trimmed) as {
              type: 'notification' | 'ack';
              notification?: AgentNotification;
              eventId?: string;
            };
            if (entry.type === 'notification' && entry.notification) {
              this.notifications.set(entry.notification.eventId, entry.notification);
            } else if (entry.type === 'ack' && entry.eventId) {
              this.acknowledgedEventIds.add(entry.eventId);
            }
          } catch {
            /* 忽略损坏单行 */
          }
        }
      } catch {
        /* 忽略恢复异常 */
      }
    }
  }

  /**
   * 从已完成的子代理记录生成并登记终态通知。
   */
  enqueueFromTask(task: AgentTaskRecord, terminalRevision = 'final'): AgentNotification {
    const eventId = `${task.agentId}:${task.origin.generation}:${terminalRevision}`;
    const notification: AgentNotification = {
      eventId,
      agentId: task.agentId,
      rootTaskId: task.origin.rootTaskId,
      parentSessionId: task.origin.parentSessionId,
      originBranchId: task.origin.originBranchId,
      originRunId: task.origin.originRunId,
      spawnToolCallId: task.origin.spawnToolCallId,
      generation: task.origin.generation,
      role: task.role,
      description: task.description,
      status: task.status,
      summary: task.summary,
      error: task.error,
      timestamp: task.finishedAt ?? Date.now(),
    };

    this.notifications.set(eventId, notification);
    if (this.storagePath) {
      try {
        const dir = path.dirname(this.storagePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(
          this.storagePath,
          `${JSON.stringify({ type: 'notification', notification })}\n`,
          'utf8',
        );
      } catch {
        /* 忽略持久化失败 */
      }
    }
    return notification;
  }

  /**
   * 获取所有未被确认的待投递通知。
   */
  getPendingNotifications(): AgentNotification[] {
    const pending: AgentNotification[] = [];
    for (const [eventId, notification] of this.notifications.entries()) {
      if (!this.acknowledgedEventIds.has(eventId)) {
        pending.push(notification);
      }
    }
    return pending;
  }

  /**
   * 确认指定通知投递已在父会话中落盘（ACK）。
   */
  acknowledge(eventId: string): void {
    this.acknowledgedEventIds.add(eventId);
    if (this.storagePath) {
      try {
        const dir = path.dirname(this.storagePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(
          this.storagePath,
          `${JSON.stringify({ type: 'ack', eventId })}\n`,
          'utf8',
        );
      } catch {
        /* 忽略持久化失败 */
      }
    }
  }

  /**
   * 查询指定通知是否已被确认。
   */
  isAcknowledged(eventId: string): boolean {
    return this.acknowledgedEventIds.has(eventId);
  }
}

/**
 * 父会话收件箱（SessionInbox），负责去重与作为背景消息持久化入父历史。
 */
export class SessionInbox {
  private static readonly globalInFlightConsumes = new Map<string, Promise<boolean>>();
  private readonly store: SessionMessageSink;
  private readonly consumedEventIds = new Set<string>();

  constructor(store: SessionMessageSink) {
    this.store = store;
  }

  /**
   * 消费并持久化一条子代理通知。
   *
   * 保证：
   * - 幂等去重：已消费过的 eventId 直接返回成功，绝不重复追加消息；
   * - 并发合并：相同 eventId 的并发消费请求复用在途 Promise，消除竞态窗口；
   * - 检查父历史现有消息，避免跨进程/重启后重复消费；
   * - 构造协议兼容的背景消息（role: 'user'，带 subagentSource 标记），通过 store.append 保存；
   * - 严格保持在来源分支上落盘；
   * - 绝不追加第二个启动结果。
   *
   * @param notification 待投递的通知对象
   * @returns 是否为新写入的消息（false 表示幂等跳过）
   */
  async consume(notification: AgentNotification): Promise<boolean> {
    const { eventId, originBranchId } = notification;

    if (this.consumedEventIds.has(eventId)) {
      return false;
    }

    const inFlight = SessionInbox.globalInFlightConsumes.get(eventId);
    if (inFlight) {
      return inFlight;
    }

    const consumePromise = (async () => {
      // 回读父会话历史，检查是否已有相同 eventId 的通知消息落盘
      if (this.store.readRecords) {
        const records = await this.store.readRecords();
        for (const r of records) {
          if (r.type === 'message') {
            const payload = r.payload as Record<string, unknown>;
            const sourceMeta = payload.subagentSource as Record<string, unknown> | undefined;
            if (sourceMeta && sourceMeta.eventId === eventId) {
              this.consumedEventIds.add(eventId);
              return false;
            }
          }
        }
      }

      const messageText = formatNotificationContent(notification);
      const message: CanonicalMessage = {
        id: createMessageId(),
        role: 'user',
        timestamp: Date.now(),
        content: [
          {
            type: 'text',
            text: messageText,
          },
        ],
      };

      // 附加 subagentSource 元数据供审计与去重消费（不作为模型指令）
      message.subagentSource = {
        eventId: notification.eventId,
        agentId: notification.agentId,
        rootTaskId: notification.rootTaskId,
        role: notification.role,
        status: notification.status,
        originBranchId: notification.originBranchId,
      };

      // 持久化追加到父会话的对应分支
      await this.store.append(message, { branchId: originBranchId });
      this.consumedEventIds.add(eventId);
      return true;
    })();

    SessionInbox.globalInFlightConsumes.set(eventId, consumePromise);
    try {
      return await consumePromise;
    } finally {
      SessionInbox.globalInFlightConsumes.delete(eventId);
    }
  }

  /**
   * 判断指定 eventId 是否已在收件箱中被消费。
   */
  hasConsumed(eventId: string): boolean {
    return this.consumedEventIds.has(eventId);
  }
}
