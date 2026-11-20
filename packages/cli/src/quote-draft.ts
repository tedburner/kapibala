import {
  MAX_REFERENCE_BYTES_PER_RUN,
  MAX_REFERENCE_CHARS_PER_RUN,
  MAX_REFERENCE_RECORDS_PER_RUN,
  MAX_REFERENCE_SESSIONS_PER_RUN,
  type PreparedTaskResult,
  SessionReferenceReader,
  createReferenceError,
} from '@kiturone/kapibala';
import { type ReferenceSelection, readReferenceBlocks } from '@kiturone/kapibala-host/internal';

/**
 * 待发送引用草稿：`/quote` 挂载身份，下一条用户输入发送时注入并清空。
 *
 * 边界：
 * - 只存身份（`ReferenceSelection`），不存正文；正文一律在运行锁内由宿主读取，
 *   这样草稿被篡改也无法伪造「被引用的历史」；
 * - 会话数与记录数在挂载阶段先按 Core 常量拦一次，避免把必然失败的请求留到运行期；
 * - 草稿是宿主会话级状态，不落盘、不跨进程传输；`take()` 一次性取走并清空。
 */
export class QuoteDraft {
  private entries: ReferenceSelection[] = [];

  /** 当前已挂载的引用身份；返回只读快照，调用方不得直接修改内部数组。 */
  list(): readonly ReferenceSelection[] {
    return [...this.entries];
  }

  /**
   * 挂载一条引用身份；超过单轮会话数或记录数上限时拒绝，不产生半挂载状态。
   *
   * 这里只做结构校验：会话数，以及显式 `recordIds` 的条数。会话级选择省略 `recordIds`，
   * 实际取到几条要读文件才知道，由 `describeReferences` 按真实读取结果统一裁决；
   * 不再用「每会话取满 limit」的上界估算，避免把实际可发送的短会话组合误拒。
   */
  add(selection: ReferenceSelection): void {
    const next = [...this.entries, selection];
    const sessions = new Set(next.map((entry) => entry.sessionId));
    if (sessions.size > MAX_REFERENCE_SESSIONS_PER_RUN)
      throw new Error(`单轮最多引用 ${MAX_REFERENCE_SESSIONS_PER_RUN} 个会话`);
    const records = next.reduce((sum, entry) => sum + (entry.recordIds?.length ?? 0), 0);
    if (records > MAX_REFERENCE_RECORDS_PER_RUN)
      throw new Error(`单轮最多引用 ${MAX_REFERENCE_RECORDS_PER_RUN} 条消息`);
    this.entries = next;
  }

  /** 按 1 起始的序号删除；越界返回 false，不改变现有草稿。 */
  remove(index: number): boolean {
    if (!Number.isSafeInteger(index) || index < 1 || index > this.entries.length) return false;
    this.entries.splice(index - 1, 1);
    return true;
  }

  /** 取走并清空草稿；调用方负责把身份交给宿主读取，正文不在这里产生。 */
  take(): ReferenceSelection[] {
    const taken = this.entries;
    this.entries = [];
    return taken;
  }

  /** 清空草稿（会话切换或用户主动放弃时使用）。 */
  clear(): void {
    this.entries = [];
  }

  /** 是否已有挂载条目；宿主据此决定下一条输入是否走引用注入路径。 */
  get size(): number {
    return this.entries.length;
  }
}

/** 引用读取所需的宿主身份；`homeDirectory` 缺省时使用当前用户目录。 */
export interface ReferenceHostContext {
  /** 当前会话项目根（绝对路径）；源会话必须属于同一项目桶。 */
  projectRoot: string;
  /** 宿主的 HOME 语义目录，用于定位 `~/.kapibala/sessions`。 */
  homeDirectory?: string;
}

/**
 * 在运行锁内准备引用块：读取、脱敏、裁剪与合计预算校验全部在这里完成。
 *
 * 失败语义：任一读取失败或超预算都抛错，Core 的 `runPreparedTask` 因此零追加。
 */
export async function prepareReferenceTask(
  selections: readonly ReferenceSelection[],
  context: ReferenceHostContext,
): Promise<PreparedTaskResult> {
  const reader = new SessionReferenceReader({ homeDirectory: context.homeDirectory });
  return { content: await readReferenceBlocks(reader, context.projectRoot, selections) };
}

/**
 * 生成挂载摘要：`已引用 N 条（M 个会话，共 X 字符）`。
 *
 * 只做展示用的只读读取，但会按实际读取结果校验单轮合计预算（条数 / 字符 / 字节）：
 * 多个源会话叠加后超限时抛 REFERENCE_BUDGET_EXCEEDED，让挂载阶段就暴露，
 * 而不是等到发送时才发现引用必然放不下。读取失败（找不到 / 跨桶 / 已归档）同样抛出。
 */
export async function describeReferences(
  selections: readonly ReferenceSelection[],
  context: ReferenceHostContext,
): Promise<string> {
  const reader = new SessionReferenceReader({ homeDirectory: context.homeDirectory });
  let records = 0;
  let chars = 0;
  let bytes = 0;
  for (const selection of selections) {
    const result = await reader.read({
      projectRoot: context.projectRoot,
      sessionId: selection.sessionId,
      ...(selection.recordIds ? { recordIds: selection.recordIds } : {}),
      ...(selection.branchId !== undefined ? { branchId: selection.branchId } : {}),
      ...(selection.limit !== undefined ? { limit: selection.limit } : {}),
    });
    records += result.records.length;
    for (const record of result.records) {
      chars += Array.from(record.text).length;
      bytes += Buffer.byteLength(record.text, 'utf8');
    }
  }
  if (
    records > MAX_REFERENCE_RECORDS_PER_RUN ||
    chars > MAX_REFERENCE_CHARS_PER_RUN ||
    bytes > MAX_REFERENCE_BYTES_PER_RUN
  ) {
    throw createReferenceError(
      'REFERENCE_BUDGET_EXCEEDED',
      `Reference budget exceeded: ${records} records, ${chars} chars, ${bytes} bytes`,
    );
  }
  return `已引用 ${records} 条（${new Set(selections.map((entry) => entry.sessionId)).size} 个会话，共 ${chars} 字符）`;
}
