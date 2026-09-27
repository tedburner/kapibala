import type { HookContext, HookHandlers, HookPoint } from './index.js';

export class HookRegistry {
  private readonly hooks: { [K in HookPoint]?: Array<NonNullable<HookHandlers[K]>> } = {};

  on<K extends HookPoint>(point: K, handler: NonNullable<HookHandlers[K]>): void {
    if (!this.hooks[point]) {
      this.hooks[point] = [];
    }
    (this.hooks[point] as any[]).push(handler);
  }

  get<K extends HookPoint>(point: K): Array<NonNullable<HookHandlers[K]>> {
    return (this.hooks[point] as any[]) ?? [];
  }

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
