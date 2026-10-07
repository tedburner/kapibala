import type { HookContext, HookHandlers, HookPoint } from './index.js';

/** 按切点收集钩子的有序注册表；同一处理器可注册多次，触发时按注册顺序执行。 */
export class HookRegistry {
  private readonly hooks: { [K in HookPoint]?: Array<NonNullable<HookHandlers[K]>> } = {};

  /** 注册到指定切点；不查重，触发顺序即注册顺序。 */
  on<K extends HookPoint>(point: K, handler: NonNullable<HookHandlers[K]>): void {
    if (!this.hooks[point]) {
      this.hooks[point] = [];
    }
    (this.hooks[point] as any[]).push(handler);
  }

  /** 返回该切点的处理器列表（无注册时为空数组）；数组为内部引用，调用方不应修改。 */
  get<K extends HookPoint>(point: K): Array<NonNullable<HookHandlers[K]>> {
    return (this.hooks[point] as any[]) ?? [];
  }

  /**
   * 串行 await 通知型切点的全部处理器；任一抛错立即中断并向调用方传播。
   * 需要返回值的 model:before / tool:before 不经 emit，由执行方自行遍历。
   */
  async emit<K extends 'session:start' | 'session:end' | 'model:after' | 'tool:after' | 'error'>(
    point: K,
    ctx: HookContext,
    ...args: any[]
  ): Promise<void> {
    const handlers = this.get(point);
    for (const handler of handlers) {
      await (handler as (...emitArgs: any[]) => void | Promise<void>)(ctx, ...args);
    }
  }
}
