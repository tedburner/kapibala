import { ToolNotFound } from '../../errors/index.js';
import type { Tool, ToolDefinition } from './index.js';
import { toToolDefinition } from './index.js';

/** 同名工具冲突策略：error 直接抛错；prefer-builtin 保留既有内置注册；prefer-last 后到者覆盖。 */
export type ConflictPolicy = 'error' | 'prefer-builtin' | 'prefer-last';

/**
 * 不可变工具注册表快照；捕获特定时刻的工具定义、执行引用与版本。
 * 外部注册表后续的增删改绝不改写已有快照视图。
 */
export interface ToolRegistrySnapshot {
  readonly version: number;
  get(name: string): Tool | undefined;
  has(name: string): boolean;
  resolve(name: string): Tool;
  list(): Tool[];
  definitions(): ToolDefinition[];
  sourceOf(name: string): string | undefined;
}

/**
 * 按名称索引的工具注册表。冲突按构造时给定的策略处理，胜出条目的来源标签保持不变；
 * 支持原子来源替换（replaceSource）、不可变运行快照（snapshot）与来源注销。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly toolSources = new Map<string, string>(); // toolName -> source
  private readonly conflictPolicy: ConflictPolicy;
  private version = 0;

  constructor(options?: { conflictPolicy?: ConflictPolicy }) {
    this.conflictPolicy = options?.conflictPolicy ?? 'error';
  }

  /** 获取当前注册表版本号；每次有效变更（注册、替换、注销）单调自增。 */
  get currentVersion(): number {
    return this.version;
  }

  register(tool: Tool, opts?: { source?: string }): void {
    const source = opts?.source ?? tool.metadata?.source ?? 'builtin';
    const existing = this.tools.get(tool.name);

    if (existing) {
      if (this.conflictPolicy === 'error') {
        throw new Error(
          `Tool name conflict: '${tool.name}' is already registered by '${this.toolSources.get(tool.name)}'`,
        );
      }
      if (
        this.conflictPolicy === 'prefer-builtin' &&
        this.toolSources.get(tool.name) === 'builtin'
      ) {
        return; // 保留内置
      }
      // prefer-last 直接覆盖
    }

    this.tools.set(tool.name, tool);
    this.toolSources.set(tool.name, source);
    this.version++;
  }

  /**
   * 原子替换指定来源的全部工具：
   * 1. 预检候选批内自身重名：若候选批次内包含同名工具，整批拒绝；
   * 2. 预检跨来源冲突：若候选工具被其它来源占用且策略不允许覆盖，整批拒绝；
   * 3. 同步原子提交：预检全部通过后一次性清理该来源旧工具并写入新工具；失败时完全保持旧状态不变。
   */
  replaceSource(source: string, tools: Tool[]): void {
    // 1. 批内重名预检
    const batchNames = new Set<string>();
    for (const tool of tools) {
      if (batchNames.has(tool.name)) {
        throw new Error(
          `Invalid candidate tools: duplicate tool name '${tool.name}' within source batch '${source}'`,
        );
      }
      batchNames.add(tool.name);
    }

    // 2. 跨来源冲突预检
    for (const tool of tools) {
      const existing = this.tools.get(tool.name);
      const existingSource = this.toolSources.get(tool.name);
      if (existing && existingSource !== source) {
        if (this.conflictPolicy === 'error') {
          throw new Error(
            `Tool name conflict: candidate '${tool.name}' from '${source}' conflicts with existing tool registered by '${existingSource}'`,
          );
        }
        if (this.conflictPolicy === 'prefer-builtin' && existingSource === 'builtin') {
          throw new Error(
            `Tool name conflict: candidate '${tool.name}' from '${source}' cannot override builtin tool`,
          );
        }
      }
    }

    // 3. 同步原子提交：先移除该来源的旧工具
    for (const [name, s] of this.toolSources.entries()) {
      if (s === source) {
        this.tools.delete(name);
        this.toolSources.delete(name);
      }
    }

    // 写入新工具
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
      this.toolSources.set(tool.name, source);
    }

    this.version++;
  }

  /**
   * 注册指定来源的工具集。
   *
   * 语义与约束：
   * 1. 委托给 `replaceSource` 实现整源原子替换（新集合未包含的该来源旧工具将被注销移除，非增量累加）；
   * 2. 默认禁止跨来源名称冲突（抛出 KapibalaError TOOL_CONFLICT）；若 options 配置了 conflictPolicy: 'prefer-last' 则允许覆盖旧来源同名工具；
   * 3. 预检阶段发现批内同名重复时整批拒绝，绝不破坏注册表原子状态。
   */
  registerSource(source: string, tools: Tool[]): void {
    this.replaceSource(source, tools);
  }

  unregisterSource(source: string): void {
    let changed = false;
    for (const [name, s] of this.toolSources.entries()) {
      if (s === source) {
        this.tools.delete(name);
        this.toolSources.delete(name);
        changed = true;
      }
    }
    if (changed) {
      this.version++;
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 获取工具对应的来源标记。 */
  sourceOf(name: string): string | undefined {
    return this.toolSources.get(name);
  }

  /** 注销指定名称及来源记录；调用方须核对实例身份，不能移除同名替代工具。 */
  unregister(name: string): void {
    if (this.tools.has(name)) {
      this.tools.delete(name);
      this.toolSources.delete(name);
      this.version++;
    }
  }

  /** 未命中时抛 ToolNotFound，并携带当前全部可用名称辅助模型自纠。 */
  resolve(name: string): Tool {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolNotFound(name, Array.from(this.tools.keys()));
    }
    return tool;
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  definitions(): ToolDefinition[] {
    return this.list().map(toToolDefinition);
  }

  /**
   * 捕获当前注册表的不可变只读快照。
   * 注册表后续的增删改绝不改变该快照的定义列表、工具执行实例与来源版本。
   */
  snapshot(): ToolRegistrySnapshot {
    const snapshotTools = new Map(this.tools);
    const snapshotSources = new Map(this.toolSources);
    const snapshotVersion = this.version;

    return {
      version: snapshotVersion,
      get: (name: string) => snapshotTools.get(name),
      has: (name: string) => snapshotTools.has(name),
      resolve: (name: string) => {
        const tool = snapshotTools.get(name);
        if (!tool) {
          throw new ToolNotFound(name, Array.from(snapshotTools.keys()));
        }
        return tool;
      },
      list: () => Array.from(snapshotTools.values()),
      definitions: () => Array.from(snapshotTools.values()).map(toToolDefinition),
      sourceOf: (name: string) => snapshotSources.get(name),
    };
  }
}
