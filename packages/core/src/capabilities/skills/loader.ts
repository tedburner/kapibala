import { randomUUID } from 'node:crypto';
import type { ToolHardDenial } from '../../runtime/executor/index.js';
import type { CanonicalMessage, SessionEvent, ToolResultBlock } from '../../types/index.js';
import { type Tool, defineTool } from '../tools/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import { escapeSkillXml, estimateSkillTokens } from './catalog.js';
import { findSkillContent } from './content.js';
import { intersectSkillTools, normalizeSkillTools } from './policy.js';
import type { SkillRegistry } from './registry.js';
import {
  type SkillResourceInput,
  type SkillResourcePage,
  listSkillResources,
  readSkillResource,
} from './resources.js';
import { skillDigest, skillFailure } from './scanner.js';
import type { SkillActivation, SkillContentSource, SkillDefinition } from './types.js';

/** 加载预检结果；只有最终成功工具结果或真实用户消息提交后才形成活动资格。 */
export interface PreparedSkill {
  /** 本轮完整正文仍可见时只引用，引用结果不附完整正文来源。 */
  alreadyPresent?: boolean;
  definition: SkillDefinition;
  source: SkillContentSource;
  text: string;
  allowedTools?: ReadonlySet<string>;
}

/** 计入 JSON 转义及来源字段；仅估原 Markdown 会低估多行正文和包装来源的请求成本。 */
function skillUnitTokens(text: string, source: SkillContentSource): number {
  const block =
    source.caller === 'user'
      ? { type: 'text', text, skillSource: source }
      : { type: 'tool_result', toolUseId: source.invocationId, content: text, skillSource: source };
  return estimateSkillTokens(JSON.stringify(block)) + 32;
}

/** 会话内技能运行状态；控制工具按实例身份识别，pending 只收紧而不授予资源。 */
export class SkillRuntime {
  readonly loaderTool: Tool;
  readonly queryTool: Tool;
  readonly resourceTool: Tool;
  private readonly controls: Set<Tool>;
  private readonly prepared = new Map<string, PreparedSkill>();
  private readonly active = new Map<string, SkillActivation>();
  private runId = '';
  private history: () => readonly CanonicalMessage[] = () => [];
  private projection: () => readonly CanonicalMessage[] = () => [];
  private reservedTokens = 0;
  private remaining: () => number = () => 0;

  /** 注册表和工具集合属于一个Session；不跨会话共享授权或隐式目录。 */
  constructor(
    readonly registry: SkillRegistry,
    private readonly tools: ToolRegistry,
    private readonly onResourceRead?: (
      source: SkillContentSource,
      input: SkillResourceInput,
      page: SkillResourcePage,
    ) => Promise<void>,
  ) {
    this.loaderTool = defineTool({
      name: 'load_skill',
      description:
        'Load full instructions for a matching skill. Use list_skills to discover skills omitted from the catalog. Reactivate historical skills in each new run.',
      metadata: { source: 'builtin', permissions: ['fs:read'] },
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      execute: async (input, context) => {
        if (typeof input.name !== 'string')
          throw skillFailure('SKILL_INVALID_INPUT', '技能名称必须是字符串');
        const loaded = await this.prepare(input.name, 'model', context.signal);
        this.prepared.set(loaded.text, loaded);
        return loaded.text;
      },
    });
    this.queryTool = defineTool({
      name: 'list_skills',
      description:
        'Search trusted model-callable skill metadata, including skills omitted from the prompt. Pagination does not activate a skill.',
      metadata: { source: 'builtin', permissions: ['fs:read'] },
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          cursor: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
      },
      execute: async (input) => this.registry.queryModel(input, this.remaining()),
    });
    this.resourceTool = defineTool({
      name: 'read_skill_resource',
      description:
        'Read a text resource inside an activated, committed skill. Follow nextOffset using offset for large UTF-8 resources; do not combine offset with line ranges. This never executes scripts.',
      metadata: { source: 'builtin', permissions: ['fs:read'] },
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'path'],
        properties: {
          name: { type: 'string' },
          path: { type: 'string' },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
          offset: { type: 'integer', minimum: 0 },
        },
      },
      execute: async (input, context) =>
        this.readResource(input as unknown as SkillResourceInput, context.signal),
    });
    this.controls = new Set([this.loaderTool, this.queryTool, this.resourceTool]);
  }

  /**
   * 开始新运行；历史正文只作事实，必须由本轮加载重新激活。
   * remaining 必须扣除在途 assistant 和普通工具结果；尚未提交的成功技能正文由本类独立预留，不重复扣除。
   */
  begin(
    runId: string,
    history: () => readonly CanonicalMessage[],
    remaining: () => number,
    projection: () => readonly CanonicalMessage[] = history,
  ): void {
    this.clear();
    this.runId = runId;
    this.history = history;
    this.projection = projection;
    this.remaining = remaining;
  }

  /** 按实际集合安装实例工具；同名插件不覆盖为受信任工具，也不能制造目录引导。 */
  syncTools(): void {
    const model = this.registry.enabled && this.registry.list('model').length > 0;
    for (const tool of [this.loaderTool, this.queryTool, this.resourceTool]) {
      const shouldRegister = tool === this.resourceTool ? model || this.active.size > 0 : model;
      const existing = this.tools.get(tool.name);
      if (shouldRegister && !existing) this.tools.register(tool);
      else if (!shouldRegister && existing === tool) this.tools.unregister(tool.name);
    }
  }

  /** 清空本轮状态；调用方必须先等待工具和历史事务清理，不能提前释放会话锁。 */
  clear(): void {
    this.active.clear();
    this.prepared.clear();
    this.runId = '';
    this.reservedTokens = 0;
    this.history = () => [];
    this.projection = () => [];
    this.remaining = () => 0;
  }

  /** 查询本轮活动状态副本，避免宿主修改限制。 */
  get activations(): SkillActivation[] {
    return structuredClone([...this.active.values()]);
  }

  /** 预检正文、限制和输入空间；调用方由宿主固定，不读取模型伪造caller。 */
  async prepare(
    name: string,
    caller: 'model' | 'user',
    signal?: AbortSignal,
  ): Promise<PreparedSkill> {
    if (!this.runId) throw skillFailure('SKILL_INVOCATION_FORBIDDEN', '技能只能在当前运行中激活');
    const definition = await this.registry.load(name, caller, signal);
    const allowedTools = normalizeSkillTools(definition, this.tools.list());
    const combined = intersectSkillTools([...this.active.values(), { allowedTools }]);
    const existing = this.active.get(name);
    if (
      existing?.state === 'committed' &&
      existing.definition.contentDigest === definition.contentDigest &&
      findSkillContent(this.projection(), existing.source)
    ) {
      return {
        definition,
        source: existing.source,
        allowedTools,
        alreadyPresent: true,
        text: JSON.stringify({
          status: 'already_present',
          name,
          invocationId: existing.source.invocationId,
          effectiveTools: combined === undefined ? 'host policy' : [...combined].sort(),
        }),
      };
    }
    const resources = await listSkillResources(definition, signal);
    const text = `<skill_content name="${escapeSkillXml(definition.name)}">\nScope: ${definition.scope}\nContent digest: ${definition.contentDigest}\nCompatibility: ${definition.compatibility ?? 'unspecified'}\nSkill directory: ${definition.baseDir}\nRead relative references with read_skill_resource; script execution still requires normal permissions.\nEffective business tools: ${combined === undefined ? 'host policy' : [...combined].sort().join(', ') || 'none'}\n\n${definition.body}\n<skill_resources>\n${resources.files.map((file) => `<file>${escapeSkillXml(file)}</file>`).join('\n')}\n</skill_resources>\nResources truncated: ${resources.truncated}\n</skill_content>`;
    const source: SkillContentSource = {
      version: 1,
      name,
      scope: definition.scope,
      filePath: definition.filePath,
      baseDir: definition.baseDir,
      contentDigest: definition.contentDigest,
      renderedDigest: skillDigest(text),
      caller,
      runId: this.runId,
      invocationId: randomUUID(),
    };
    if (skillUnitTokens(text, source) > this.remaining() - this.reservedTokens)
      throw skillFailure('SKILL_BODY_BUDGET_EXCEEDED', '剩余输入预算不能容纳完整技能正文');
    return {
      definition,
      text,
      allowedTools,
      source,
    };
  }

  /** 真实用户入口安装pending；正文需进入用户消息，提交前不提供资源。 */
  acceptUser(prepared: PreparedSkill): void {
    if (prepared.source.caller !== 'user' || prepared.source.runId !== this.runId)
      throw skillFailure('SKILL_INVOCATION_FORBIDDEN', '技能用户来源与当前运行不符');
    this.active.set(prepared.definition.name, {
      definition: prepared.definition,
      source: prepared.source,
      allowedTools: prepared.allowedTools,
      state: 'pending',
    });
  }

  /** 最终工具结果通过执行器钩子/审计后安装收紧；同名或仿造结果不激活。 */
  acceptResult(tool: Tool, result: ToolResultBlock): void {
    if (tool !== this.loaderTool || result.isError) return;
    const prepared = this.prepared.get(result.content);
    if (!prepared)
      throw skillFailure('SKILL_INVOCATION_FORBIDDEN', '加载结果无法关联当前受信任预检');
    this.prepared.delete(result.content);
    if (prepared.alreadyPresent) return;
    prepared.source.invocationId = result.toolUseId;
    result.skillSource = structuredClone(prepared.source);
    this.reservedTokens += skillUnitTokens(result.content, prepared.source);
    this.active.set(prepared.definition.name, {
      definition: prepared.definition,
      source: prepared.source,
      allowedTools: prepared.allowedTools,
      state: 'pending',
    });
  }

  /** 业务调用的动态硬拒绝；控制工具仅按实例豁免，仍须宿主权限裁决。 */
  denial(tool: Tool): ToolHardDenial | undefined {
    if (this.controls.has(tool)) return undefined;
    const allowed = intersectSkillTools(this.active.values());
    if (allowed !== undefined && !allowed.has(tool.name))
      return {
        code: 'SKILL_POLICY_DENIED',
        message: '工具不在当前活动技能允许范围内',
        retryPolicy: 'never',
        fields: { skillNames: [...this.active.keys()].sort().join(',') },
      };
    return undefined;
  }

  /** 完整消息提交后记录审计再发布事件；失败不回滚历史，但不提交资源资格。 */
  async commit(
    audit: (source: SkillContentSource, messageId: string) => Promise<void>,
    persistence: 'memory' | 'disk',
  ): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    for (const activation of this.active.values()) {
      if (activation.state !== 'pending') continue;
      const found = findSkillContent(this.history(), activation.source);
      if (!found || found.source.invocationId !== activation.source.invocationId) continue;
      await audit(activation.source, found.messageId);
      activation.state = 'committed';
      events.push({
        type: 'skill_loaded',
        source: structuredClone(activation.source),
        messageId: found.messageId,
        persistence,
      });
    }
    this.reservedTokens = 0;
    return events;
  }

  /** 检查最终模型投影的完整活动指导；钩子或压缩不能移走后继续执行。 */
  assertProjection(messages: readonly CanonicalMessage[]): void {
    for (const activation of this.active.values()) {
      if (activation.state === 'committed' && !findSkillContent(messages, activation.source))
        throw skillFailure('SKILL_CONTEXT_LOST', '当前活动技能正文已离开请求投影，请重新开始运行');
    }
  }

  /** 只读本轮已提交技能资源；文件/来源漂移要求重新开始，不重放脚本。 */
  async readResource(input: SkillResourceInput, signal?: AbortSignal): Promise<SkillResourcePage> {
    if (typeof input.name !== 'string')
      throw skillFailure('SKILL_INVALID_INPUT', '技能名称必须是字符串');
    const activation = this.active.get(input.name);
    if (!activation || activation.state !== 'committed')
      throw skillFailure('SKILL_NOT_COMMITTED', '技能尚未在本轮完整提交，请加载后在下一步读取');
    await this.registry.verify(activation.definition, signal);
    const page = await readSkillResource(activation.definition, input, signal);
    await this.onResourceRead?.(activation.source, input, page);
    return page;
  }
}
