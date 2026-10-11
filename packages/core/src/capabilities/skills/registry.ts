import fs from 'node:fs/promises';
import { type SkillQuery, type SkillQueryPage, estimateSkillTokens } from './catalog.js';
import { parseSkillDocument } from './frontmatter.js';
import {
  compareSkillPaths,
  readBoundedSkillText,
  scanSkillRoot,
  skillDigest,
  skillFailure,
  skillPathKey,
} from './scanner.js';
import {
  SKILL_LIMITS,
  type SkillDefinition,
  type SkillDiagnostic,
  type SkillMetadata,
  type SkillOptions,
} from './types.js';

/** 确定性技能注册表；刷新原子替换快照，运行中加载必须与发现指纹一致。 */
export class SkillRegistry {
  private definitions = new Map<string, SkillMetadata>();
  private warnings: SkillDiagnostic[] = [];
  private revisionValue = '';
  /** 固定宿主配置副本，外部对象变更不能静默改变本轮发现或信任。 */
  constructor(private readonly options: SkillOptions) {
    this.options = structuredClone(options);
  }

  /** 获取独立诊断副本，调用方不能修改生效候选或权限。 */
  get diagnostics(): SkillDiagnostic[] {
    return structuredClone(this.warnings);
  }
  /** 快照游标身份随正文、来源、可用性变化而失效。 */
  get revision(): string {
    return this.revisionValue;
  }
  /** 是否由宿主启用；关闭只影响本次能力，不删除历史或文件。 */
  get enabled(): boolean {
    return this.options.enabled !== false;
  }

  /** 每轮开始重新发现；取消不发布半个快照，非法单文件只产生诊断。 */
  async refresh(signal?: AbortSignal): Promise<void> {
    const candidates: SkillMetadata[] = [];
    const diagnostics: SkillDiagnostic[] = [];
    for (const root of this.options.roots) {
      const result = await scanSkillRoot(root, signal);
      candidates.push(...result.skills);
      diagnostics.push(...result.diagnostics);
    }
    candidates.sort((a, b) => a.priority - b.priority || compareSkillPaths(a.filePath, b.filePath));
    const definitions = new Map<string, SkillMetadata>();
    const physical = new Set<string>();
    const disabled = new Set(this.options.disabled ?? []);
    for (const candidate of candidates) {
      candidate.disabled = !this.enabled || disabled.has(candidate.name);
      const existing = definitions.get(candidate.name);
      if (existing?.available) {
        diagnostics.push({
          code: 'SKILL_SHADOWED',
          level: 'warn',
          path: candidate.filePath,
          message: '同名技能被更高优先级来源覆盖',
          winnerPath: existing.filePath,
          loserPath: candidate.filePath,
        });
        continue;
      }
      if (!candidate.available && existing) continue;
      const identity = skillPathKey(candidate.filePath);
      if (physical.has(identity)) continue;
      if (candidate.available) physical.add(identity);
      definitions.set(candidate.name, candidate);
    }
    signal?.throwIfAborted();
    this.definitions = definitions;
    this.warnings = diagnostics;
    this.revisionValue = skillDigest(
      JSON.stringify(
        [...definitions.values()].map((s) => [
          s.name,
          s.scope,
          s.priority,
          s.sourceRoot,
          s.filePath,
          s.contentDigest,
          s.available,
          s.disabled,
          s.modelInvocable,
        ]),
      ),
    );
  }

  /** 按名称查询胜出元数据副本；未知名称返回 undefined，正文仅由 load 校验后懒读取。 */
  get(name: string): SkillMetadata | undefined {
    const value = this.definitions.get(name);
    return value ? structuredClone(value) : undefined;
  }

  /** 宿主可检查不可用条目；模型/用户视图分别施加调用控制，均不读取正文。 */
  list(caller: 'host' | 'model' | 'user' = 'host', query = ''): SkillMetadata[] {
    const needle = query.toLowerCase();
    return [...this.definitions.values()]
      .filter(
        (s) =>
          caller === 'host' ||
          (s.available && !s.disabled && (caller === 'model' ? s.modelInvocable : s.userInvocable)),
      )
      .filter(
        (s) =>
          !needle || `${s.name} ${s.description} ${s.when ?? ''}`.toLowerCase().includes(needle),
      )
      .sort((a, b) => a.priority - b.priority || compareSkillPaths(a.name, b.name))
      .map((metadata) => structuredClone(metadata));
  }

  /** 按当前快照校验调用控制与物理身份，不接受模型提供的信任或 caller 升级。 */
  async load(
    name: string,
    caller: 'model' | 'user',
    signal?: AbortSignal,
  ): Promise<SkillDefinition> {
    const skill = this.get(name);
    if (!skill) throw skillFailure('SKILL_NOT_FOUND', '技能不存在，请查询当前技能列表');
    if (skill.disabled) throw skillFailure('SKILL_INVOCATION_FORBIDDEN', '技能已由宿主禁用');
    if (!skill.available)
      throw skillFailure(
        skill.unavailableReason?.includes('信任') ? 'SKILL_UNTRUSTED' : 'SKILL_UNSUPPORTED',
        skill.unavailableReason ?? '技能不可执行',
      );
    if (!(caller === 'model' ? skill.modelInvocable : skill.userInvocable))
      throw skillFailure('SKILL_INVOCATION_FORBIDDEN', '当前调用方不能激活此技能');
    const raw = await this.verify(skill, signal);
    return { ...skill, body: parseSkillDocument(raw, skill.filePath).body };
  }

  /** 查询可信模型集合；过期游标可修正，预算不足不返回不前进的分页。 */
  queryModel(
    input: SkillQuery = {},
    remainingTokens: number = SKILL_LIMITS.queryTokens,
  ): SkillQueryPage {
    const limit = input.limit ?? 20;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      (input.query !== undefined &&
        (typeof input.query !== 'string' || Array.from(input.query).length > 512))
    )
      throw skillFailure('SKILL_INVALID_INPUT', '查询参数必须是有界文本和1–50条分页');
    const query = input.query?.toLowerCase() ?? '';
    const queryDigest = skillDigest(query);
    const skills = this.list('model', query);
    let offset = 0;
    if (input.cursor !== undefined) {
      try {
        if (
          typeof input.cursor !== 'string' ||
          input.cursor.length > 512 ||
          !/^[a-zA-Z0-9_-]+$/.test(input.cursor)
        )
          throw new Error('invalid');
        const value = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as {
          revision: string;
          query: string;
          offset: number;
        };
        if (value.revision !== this.revision || value.query !== queryDigest)
          throw skillFailure('SKILL_CURSOR_EXPIRED', '查询快照或条件已变化，请重新查询');
        if (!Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > skills.length)
          throw new Error('invalid');
        offset = value.offset;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'SKILL_CURSOR_EXPIRED')
          throw error;
        throw skillFailure('SKILL_INVALID_INPUT', '技能查询游标无效');
      }
    }
    const page: SkillQueryPage = { skills: [], total: skills.length };
    const finalize = () => {
      const next = offset + page.skills.length;
      page.nextCursor =
        next < skills.length
          ? Buffer.from(
              JSON.stringify({ revision: this.revision, query: queryDigest, offset: next }),
            ).toString('base64url')
          : undefined;
    };
    const budget = Math.max(0, Math.min(SKILL_LIMITS.queryTokens, remainingTokens));
    for (const skill of skills.slice(offset, offset + limit)) {
      const description = Array.from(skill.description);
      let length = Math.min(description.length, SKILL_LIMITS.descriptionChars);
      let accepted = false;
      while (length > 0) {
        page.skills.push({
          name: skill.name,
          description: description.slice(0, length).join(''),
          scope: skill.scope,
          ...(skill.argumentHint
            ? { argumentHint: Array.from(skill.argumentHint).slice(0, 100).join('') }
            : {}),
        });
        finalize();
        if (estimateSkillTokens(JSON.stringify(page, null, 2)) <= budget) {
          accepted = true;
          break;
        }
        page.skills.pop();
        length = length > 24 ? Math.floor(length / 2) : 0;
      }
      if (!accepted) break;
    }
    finalize();
    if (
      (offset < skills.length && !page.skills.length) ||
      estimateSkillTokens(JSON.stringify(page, null, 2)) > budget
    )
      throw skillFailure('SKILL_BODY_BUDGET_EXCEEDED', '剩余上下文无法容纳最小技能查询响应');
    return page;
  }

  /** 复核配置根、词法发现路径和原文件字节，返回本次有界读取文本；漂移要求新运行，不能热替换。 */
  async verify(skill: SkillMetadata, signal?: AbortSignal): Promise<string> {
    try {
      const root = await fs.realpath(skill.discoveryRoot);
      const target = await fs.realpath(skill.discoveryPath);
      if (
        skillPathKey(root) !== skillPathKey(skill.sourceRoot) ||
        skillPathKey(target) !== skillPathKey(skill.filePath)
      )
        throw new Error('changed');
      const raw = await readBoundedSkillText(target, SKILL_LIMITS.fileBytes, signal);
      if (skillDigest(raw) !== skill.contentDigest) throw new Error('changed');
      return raw;
    } catch (error) {
      if (signal?.aborted) throw error;
      throw skillFailure('SKILL_CHANGED', '技能文件或来源已变化，请开始新运行刷新');
    }
  }
}
