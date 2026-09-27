import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { LogEvent, LogSink } from './index.js';

export interface FileLogSinkOptions {
  directory: string;
  prefix: 'operation' | 'audit';
  maxBytes?: number;
  retentionDays?: number;
  sync?: boolean;
}

/** 将每条 JSONL 事件完整追加到本地文件，并按日期及文件大小轮转。 */
export class FileLogSink implements LogSink {
  readonly directory: string;
  readonly prefix: 'operation' | 'audit';
  private readonly maxBytes: number;
  private readonly retentionDays?: number;
  private readonly sync: boolean;

  constructor(options: FileLogSinkOptions) {
    this.directory = path.resolve(options.directory);
    this.prefix = options.prefix;
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    this.retentionDays = options.prefix === 'audit' ? undefined : options.retentionDays;
    this.sync = options.prefix === 'audit' || (options.sync ?? false);
  }

  async write(event: LogEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    const date = event.timestamp.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid log timestamp');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const filePath = this.chooseFile(date, bytes);
    const descriptor = fs.openSync(filePath, 'a', 0o600);
    try {
      fs.writeSync(descriptor, line, undefined, 'utf8');
      if (this.sync) fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if (this.retentionDays !== undefined) this.cleanupExpired(date);
  }

  /** 返回该通道已占用的字节数，供宿主提示长期保留的审计用量。 */
  getUsageBytes(): number {
    if (!fs.existsSync(this.directory)) return 0;
    return fs
      .readdirSync(this.directory)
      .filter((name) => this.isOwnedFile(name))
      .reduce((total, name) => total + fs.statSync(path.join(this.directory, name)).size, 0);
  }

  private chooseFile(date: string, bytes: number): string {
    const names = fs
      .readdirSync(this.directory)
      .filter((name) => name.startsWith(`${this.prefix}-${date}-`) && this.isOwnedFile(name))
      .sort();
    const lastName = names.at(-1);
    if (lastName) {
      const lastPath = path.join(this.directory, lastName);
      if (fs.statSync(lastPath).size + bytes <= this.maxBytes) return lastPath;
    }
    const next = lastName ? Number(lastName.slice(-9, -6)) + 1 : 1;
    return path.join(
      this.directory,
      `${this.prefix}-${date}-${String(next).padStart(3, '0')}.jsonl`,
    );
  }

  private cleanupExpired(currentDate: string): void {
    const current = Date.parse(`${currentDate}T00:00:00.000Z`);
    const cutoff = current - (this.retentionDays ?? 0) * 86_400_000;
    for (const name of fs.readdirSync(this.directory)) {
      if (!this.isOwnedFile(name)) continue;
      const fileDate = name.slice(this.prefix.length + 1, this.prefix.length + 11);
      if (Date.parse(`${fileDate}T00:00:00.000Z`) < cutoff) {
        fs.unlinkSync(path.join(this.directory, name));
      }
    }
  }

  private isOwnedFile(name: string): boolean {
    return new RegExp(`^${this.prefix}-\\d{4}-\\d{2}-\\d{2}-\\d{3}\\.jsonl$`).test(name);
  }
}

/** 构造 CLI 与默认 SDK 使用的用户级运行及审计 Sink。 */
export function createDefaultLogSinks(baseDirectory = path.join(os.homedir(), '.kapibala')): {
  operationSink: FileLogSink;
  auditSink: FileLogSink;
} {
  return {
    operationSink: new FileLogSink({
      directory: path.join(baseDirectory, 'logs'),
      prefix: 'operation',
      retentionDays: 30,
    }),
    auditSink: new FileLogSink({
      directory: path.join(baseDirectory, 'audit'),
      prefix: 'audit',
      sync: true,
    }),
  };
}

/** 启动时保守关闭上次进程未完成的审计事务，绝不将其当作未执行或自动重试。 */
export async function recoverIncompleteAudit(directory: string): Promise<number> {
  if (!fs.existsSync(directory)) return 0;
  const files = fs
    .readdirSync(directory)
    .filter((name) => /^audit-\d{4}-\d{2}-\d{2}-\d{3}\.jsonl$/.test(name))
    .sort();
  const open = new Map<string, LogEvent>();
  for (const name of files) {
    const lines = readline.createInterface({
      input: fs.createReadStream(path.join(directory, name), { encoding: 'utf8' }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      if (!line) continue;
      let event: LogEvent;
      try {
        event = JSON.parse(line) as LogEvent;
      } catch {
        continue;
      }
      if (!event.operationId || typeof event.operationId !== 'string') continue;
      if (event.event === 'tool.requested') open.set(event.operationId, event);
      if (event.event === 'tool.finished' || event.event === 'audit.outcome_unknown') {
        open.delete(event.operationId);
      }
    }
  }
  const sink = new FileLogSink({ directory, prefix: 'audit' });
  let recovered = 0;
  for (const event of open.values()) {
    const processId = event.fields?.processId;
    if (typeof processId === 'number' && Number.isSafeInteger(processId) && processId > 0) {
      try {
        process.kill(processId, 0);
        continue; // 另一个仍运行的 CLI/SDK 会话拥有该操作，不能误记为崩溃。
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') continue;
      }
    }
    await sink.write({
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      channel: 'audit',
      level: 'warn',
      event: 'audit.outcome_unknown',
      sessionId: event.sessionId,
      runId: event.runId,
      operationId: event.operationId,
      toolUseId: event.toolUseId,
      fields: { status: 'unknown_after_restart' },
    });
    recovered++;
  }
  return recovered;
}
