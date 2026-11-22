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
import type {
  CanonicalMessage,
  SubagentSourceMetadata,
  WatchSourceMetadata,
} from '../../types/index.js';
import type { WatchNotification } from '../watch/types.js';
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
    return consumeBackgroundMessage(this.store, this.consumedEventIds, {
      metadataKey: 'subagentSource',
      eventId: notification.eventId,
      branchId: notification.originBranchId,
      text: formatNotificationContent(notification),
      metadata: {
        eventId: notification.eventId,
        agentId: notification.agentId,
        rootTaskId: notification.rootTaskId,
        role: notification.role,
        status: notification.status,
        originBranchId: notification.originBranchId,
      },
    });
  }

  /**
   * 判断指定 eventId 是否已在收件箱中被消费。
   */
  hasConsumed(eventId: string): boolean {
    return this.consumedEventIds.has(eventId);
  }
}

/** 收件箱共享投递参数；两类背景消息只在元数据键与正文格式上不同。 */
interface BackgroundMessageSource {
  readonly metadataKey: 'subagentSource' | 'watchSource';
  readonly eventId: string;
  readonly branchId: string;
  readonly text: string;
  readonly metadata: SubagentSourceMetadata | WatchSourceMetadata;
}

/** 进程内共享的在途消费（仅单进程内跨收件箱实例去重，跨进程互斥由 SessionLock 与落盘幂等回读保证）。 */
const globalInFlightConsumes = new Map<string, Promise<boolean>>();

/**
 * 子代理与监视共用的背景消息投递实现（v0.1.4 抽取，语义与 SessionInbox 原实现一致）。
 *
 * 顺序约束：先回读历史确认未投递，再落盘消息，最后才把 eventId 记入进程内集合；
 * 任一步失败都抛出，由调用方保留水位并重试，绝不「先确认后落盘」。
 */
async function consumeBackgroundMessage(
  store: SessionMessageSink,
  consumedEventIds: Set<string>,
  source: BackgroundMessageSource,
): Promise<boolean> {
  const { eventId } = source;
  if (consumedEventIds.has(eventId)) return false;

  const key = `${source.metadataKey}:${eventId}`;
  const inFlight = globalInFlightConsumes.get(key);
  if (inFlight) return inFlight;

  const consumePromise = (async () => {
    if (store.readRecords) {
      const records = await store.readRecords();
      for (const record of records) {
        if (record.type !== 'message') continue;
        const payload = record.payload as Record<string, unknown>;
        const metadata = payload[source.metadataKey] as Record<string, unknown> | undefined;
        if (metadata && metadata.eventId === eventId) {
          consumedEventIds.add(eventId);
          return false;
        }
      }
    }

    const message: CanonicalMessage = {
      id: createMessageId(),
      role: 'user',
      timestamp: Date.now(),
      content: [{ type: 'text', text: source.text }],
    };
    if (source.metadataKey === 'subagentSource') {
      message.subagentSource = source.metadata as SubagentSourceMetadata;
    } else {
      message.watchSource = source.metadata as WatchSourceMetadata;
    }

    // 必须先落盘再确认：水位与幂等集合都依赖这条顺序。
    await store.append(message, { branchId: source.branchId });
    consumedEventIds.add(eventId);
    return true;
  })();

  globalInFlightConsumes.set(key, consumePromise);
  try {
    return await consumePromise;
  } finally {
    globalInFlightConsumes.delete(key);
  }
}

const WATCH_STATE_LABELS: Readonly<Record<WatchNotification['state'], string>> = {
  fired: '已触发',
  timeout: '已超时',
  cancelled: '已取消',
  orphaned: '已失联',
};

/** 属性值只做结构转义，不改变可读文本；换行压平，避免伪装成新的结构化标签。 */
function escapeWatchAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\r\n]+/g, ' ');
}

/**
 * 把监视触发通知格式化为背景消息正文：结构化 `<watch-event>` 标签 + 人类可读事实。
 * 标签只用于溯源，不构成权限；正文始终以 `role: 'user'` 背景消息进入历史。
 */
export function formatWatchNotificationContent(notification: WatchNotification): string {
  const attributes = [
    `watch="${escapeWatchAttribute(notification.watchId)}"`,
    `kind="${escapeWatchAttribute(notification.kind)}"`,
    `state="${escapeWatchAttribute(notification.state)}"`,
    `fired-at="${notification.firedAt}"`,
  ].join(' ');
  return [
    `[会话监视通知 · ${WATCH_STATE_LABELS[notification.state]}]`,
    `<watch-event ${attributes}>`,
    `- 目标: ${notification.target}`,
    ...(notification.detail ? [`- 事实: ${notification.detail}`] : []),
  ].join('\n');
}

/**
 * 监视收件箱：与 `SessionInbox` 共用同一投递实现，只替换元数据键与正文格式。
 *
 * 分支必须由调用方显式给出（取 `WatchState.branchId`），禁止猜测当前活动分支：
 * 会话在等待期间可能已切换分支，通知仍应落回登记时的分支。
 */
export class WatchInbox {
  private readonly store: SessionMessageSink;
  private readonly consumedEventIds = new Set<string>();

  constructor(store: SessionMessageSink) {
    this.store = store;
  }

  /**
   * 消费并持久化一条监视通知。
   *
   * @returns 是否为新写入的消息；false 表示进程内或历史中已存在同一 `eventId`。
   */
  async consume(notification: WatchNotification, branchId: string): Promise<boolean> {
    return consumeBackgroundMessage(this.store, this.consumedEventIds, {
      metadataKey: 'watchSource',
      eventId: notification.eventId,
      branchId,
      text: formatWatchNotificationContent(notification),
      metadata: {
        eventId: notification.eventId,
        watchId: notification.watchId,
        kind: notification.kind,
        state: notification.state,
        branchId,
      },
    });
  }

  /** 判断指定 eventId 是否已在本收件箱实例中确认投递。 */
  hasConsumed(eventId: string): boolean {
    return this.consumedEventIds.has(eventId);
  }
}
