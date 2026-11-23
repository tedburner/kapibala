/**
 * 会话级监视的领域类型。监视没有执行体：它只是一条控制记录，
 * 由持会话写租约的宿主布置触发源，命中后经背景消息通道唤醒会话。
 */

/**
 * 监视的触发源类型；当前仅支持本机文件与 localhost 端口。
 * `process_exit` 因宿主未维护子进程 PID 注册表而不接线，
 * 历史落盘中的遗留记录由读取侧按残缺数据跳过，不再布置触发源。
 */
export type WatchKind = 'file_change' | 'port_ready';

/** 监视生命周期；`armed` 之外均为终态，终态不再产生新通知。 */
export type WatchStatus = 'armed' | 'fired' | 'timeout' | 'cancelled' | 'orphaned';

/** 终态集合；通知只承载终态，避免把「仍在监视」误当成事件。 */
export type WatchTerminalStatus = Exclude<WatchStatus, 'armed'>;

/** 一条监视的规格；`deadlineAt` 必填，杜绝无限期占用资源。 */
export interface WatchSpec {
  readonly kind: WatchKind;
  /**
   * 目标：`file_change` 为工作区相对路径，
   * `port_ready` 为 1–65535 的端口号（只连 127.0.0.1）。
   */
  readonly target: string;
  /** 轮询间隔，仅 `file_change` / `port_ready` 使用；下限 2000ms，默认 5000ms。 */
  readonly intervalMs?: number;
  /** 截止时间（毫秒时间戳）；到期投递 `timeout` 并关闭监视。 */
  readonly deadlineAt: number;
}

/**
 * 监视状态，作为 `watch_state` 全局控制记录的载荷。
 * 是否欠一次投递由水位 `lastSeenAt < 事件时间` 判定，不使用布尔闩锁；
 * 同一 `watchId` 多次变更以追加新记录、读时取最后一条为准，绝不改写历史。
 */
export interface WatchState {
  readonly watchId: string;
  readonly spec: WatchSpec;
  readonly state: WatchStatus;
  /** 已确认看到的事件时间水位；恢复时只有更晚的事件才补投。 */
  lastSeenAt: number;
  /** 最近一次实际投递时间；仅用于冷却与诊断。 */
  lastNotifiedAt?: number;
  /** 登记时的分支；通知必须落回该分支。 */
  readonly branchId: string;
  readonly armedAt: number;
  closedAt?: number;
}

/**
 * 监视触发通知；一条监视至多产生一条，因此 `eventId` 直接取 `watchId`。
 * 去重靠回读背景消息的 `watchSource.eventId`，与子代理通知共用投递通道。
 */
export interface WatchNotification {
  readonly eventId: string;
  readonly watchId: string;
  readonly kind: WatchKind;
  readonly target: string;
  readonly state: WatchTerminalStatus;
  readonly firedAt: number;
  /** 可选的人类可读事实摘要：内容摘要 / 连接耗时。 */
  readonly detail?: string;
}
