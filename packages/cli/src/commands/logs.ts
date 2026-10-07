import fs from 'node:fs';
import path from 'node:path';
import { type LogEvent, createDefaultLogSinks } from '@kiturone/kapibala';
import type { CommandHandler } from './dispatcher.js';

/**
 * 输出最近 N 条（默认 20，上限 100）运行与审计日志；两类来源合并后按时间正序展示。
 * 只读已落盘文件，不发起任何运行。
 */
export const logsCommand: CommandHandler = (args) => {
  const count = args[0] === undefined ? 20 : Number(args[0]);
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('日志条数必须为 1–100');
  const { operationSink, auditSink } = createDefaultLogSinks();
  const events = [
    ...readRecent(operationSink.directory, 'operation', count),
    ...readRecent(auditSink.directory, 'audit', count),
  ]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-count);
  if (events.length === 0) console.log('暂无运行或审计日志。');
  for (const event of events) {
    console.log(
      `${event.timestamp} ${event.channel} ${event.level.toUpperCase()} ${event.event} ${JSON.stringify(event.fields)}`,
    );
  }
};

/** 从最新日志文件向回读，凑满 count 即止；崩溃留下的残缺末行静默跳过。 */
function readRecent(directory: string, prefix: 'operation' | 'audit', count: number): LogEvent[] {
  if (!fs.existsSync(directory)) return [];
  const files = fs
    .readdirSync(directory)
    .filter((name) => new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}-\\d{3}\\.jsonl$`).test(name))
    .sort()
    .reverse();
  const events: LogEvent[] = [];
  for (const name of files) {
    const lines = fs.readFileSync(path.join(directory, name), 'utf8').trim().split('\n').reverse();
    for (const line of lines) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as LogEvent);
      } catch {
        /* Skip an incomplete final line after a crash. */
      }
      if (events.length >= count) break;
    }
    if (events.length >= count) break;
  }
  return events;
}
