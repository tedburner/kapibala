import { createHash, randomUUID } from 'node:crypto';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
export type LogChannel = 'operation' | 'audit';
export type LogField = string | number | boolean | null;

/** 单条可持久化的脱敏运行或审计事件。 */
export interface LogEvent {
  schemaVersion: 1;
  timestamp: string;
  level: LogLevel;
  channel: LogChannel;
  event: string;
  sessionId: string;
  runId?: string;
  operationId?: string;
  toolUseId?: string;
  fields: Record<string, LogField>;
}

/** 宿主提供的事件存储入口；审计 Sink 的写入完成代表已持久化。 */
export interface LogSink {
  write(event: LogEvent): Promise<void>;
}

export interface LogInput {
  level: LogLevel;
  event: string;
  sessionId: string;
  runId?: string;
  operationId?: string;
  toolUseId?: string;
  fields?: Record<string, unknown>;
}

/** Core 与宿主共同使用的运行日志和审批审计入口。 */
export interface EventLogger {
  record(event: LogInput): Promise<void>;
  recordAudit(event: LogInput): Promise<void>;
}

const SAFE_FIELDS = new Set([
  'mode',
  'toolName',
  'durationMs',
  'decision',
  'decisionSource',
  'ruleSource',
  'approvalChoice',
  'status',
  'phase',
  'errorCode',
  'retryPolicy',
  'reason',
  'shell',
  'executableDigest',
  'cwdDigest',
  'commandDigest',
  'commandPreview',
  'commandLength',
  'argumentCount',
  'executionFingerprint',
  'exitCode',
  'outputBytes',
  'outputTruncated',
  'outputFileTruncated',
  'reclaimed',
  'modelId',
  'provider',
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'attempt',
  'count',
  'pathDigest',
  'source',
  'sessionMode',
  'processId',
]);
const SENSITIVE_VALUE =
  /(?:\bBearer\s+\S+|\b(?:sk|api|key)-[A-Za-z0-9_-]{5,}|(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+)/i;

/** 将任意来源的字段缩减为可写入日志的固定集合。 */
export function projectSafeFields(fields: Record<string, unknown>): Record<string, LogField> {
  const safe: Record<string, LogField> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (!SAFE_FIELDS.has(name)) continue;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      safe[name] = value;
    } else if (typeof value === 'string') {
      const validPreview =
        name !== 'commandPreview' || /^(?:[a-z][a-z0-9-]* \(\d+ args\)|\[redacted\])$/.test(value);
      const validReason = name !== 'reason' || /^[a-z][a-z0-9_.-]{0,80}$/i.test(value);
      safe[name] =
        SENSITIVE_VALUE.test(value) ||
        !validPreview ||
        !validReason ||
        value.includes('\n') ||
        value.includes('\r')
          ? '[redacted]'
          : value.slice(0, 512);
    }
  }
  return safe;
}

/** 生成不依赖模型工具调用 ID 的内部关联标识。 */
export function createLogId(): string {
  return randomUUID();
}

/** 只暴露固定命令类别与参数数目，避免把自由文本写入审计。 */
export function commandAuditSummary(command: string): {
  commandDigest: string;
  commandPreview: string;
  commandLength: number;
  argumentCount: number;
} {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.toLowerCase();
  const category =
    first &&
    new Set([
      'git',
      'pnpm',
      'npm',
      'node',
      'rg',
      'ls',
      'pwd',
      'cat',
      'get-childitem',
      'get-content',
    ]).has(first)
      ? first
      : undefined;
  return {
    commandDigest: createHash('sha256').update(command, 'utf8').digest('hex'),
    commandPreview: category ? `${category} (${Math.max(0, parts.length - 1)} args)` : '[redacted]',
    commandLength: Buffer.byteLength(command, 'utf8'),
    argumentCount: Math.max(0, parts.length - 1),
  };
}

/** 将批准范围绑定到最终命令、解释器、目录与执行选项。 */
export function executionFingerprint(input: {
  command: string;
  shell: string;
  executable: string;
  cwd: string;
  environmentDigest: string;
  timeoutMs: number;
  outputLimitBytes: number;
  targetDigest?: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.command,
        input.shell,
        input.executable,
        input.cwd,
        input.environmentDigest,
        input.timeoutMs,
        input.outputLimitBytes,
        input.targetDigest ?? null,
      ]),
    )
    .digest('hex');
}

/** 统一筛选和脱敏日志；运行日志失败只报告安全诊断，审计失败仍向调用方传播。 */
export class StructuredLogger implements EventLogger {
  private readonly operationSink: LogSink;
  private readonly auditSink: LogSink;
  private readonly debug: boolean;
  private readonly onDiagnostic?: (message: string) => void;

  constructor(options: {
    operationSink: LogSink;
    auditSink: LogSink;
    debug?: boolean;
    onDiagnostic?: (message: string) => void;
  }) {
    this.operationSink = options.operationSink;
    this.auditSink = options.auditSink;
    this.debug = options.debug ?? false;
    this.onDiagnostic = options.onDiagnostic;
  }

  /** 普通日志写入失败不阻断业务，也不声称持久化成功；诊断不携带原始异常内容。 */
  async record(event: LogInput): Promise<void> {
    if (!this.debug && (event.level === 'debug' || event.level === 'trace')) return;
    try {
      await this.operationSink.write(this.format(event, 'operation'));
    } catch {
      try {
        this.onDiagnostic?.('Operation log write failed; the event was not persisted');
      } catch {
        // 宿主诊断异常不能影响会话；审计失败仍由 recordAudit 原样传播。
      }
    }
  }

  /** 审计必须成功持久化；异常交由执行器拒绝启动工具或报告已执行操作的结果未知。 */
  async recordAudit(event: LogInput): Promise<void> {
    await this.auditSink.write(this.format(event, 'audit'));
  }

  private format(input: LogInput, channel: LogChannel): LogEvent {
    return {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      level: input.level,
      channel,
      event: input.event,
      sessionId: input.sessionId,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
      ...(input.toolUseId === undefined ? {} : { toolUseId: input.toolUseId }),
      fields: projectSafeFields(input.fields ?? {}),
    };
  }
}
