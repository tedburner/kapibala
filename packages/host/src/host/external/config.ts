import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSensitiveEnvVarName } from '@kiturone/kapibala-mcp';
import { redactCommonSecrets } from '../redaction.js';
import { stableJson } from '../resource/mcp-approval.js';
import {
  ENV_VAR_NAME_PATTERN,
  FORBIDDEN_EXTERNAL_ENV_KEYS,
  hasAsciiControlCharacter,
} from './env.js';
import { BUILTIN_EXTERNAL_HARNESSES, findBuiltinExternalHarness } from './presets.js';
import {
  type ExternalHarnessDefinition,
  ExternalHarnessError,
  isReservedObjectPropertyName,
} from './types.js';

/** 外部代理配置目录名（位于 `~/.kapibala/external`）。 */
export const EXTERNAL_STATE_DIR_NAME = 'external';
/** 外部代理定义配置文件名（位于 `~/.kapibala/external/harnesses.json`）。 */
export const EXTERNAL_HARNESSES_FILE_NAME = 'harnesses.json';

const HARNESS_ID_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;

/** 内置外部代理的增量覆写字段；全部为空时自动从磁盘剔除，保持恢复默认的洁净语义。 */
export interface BuiltinHarnessOverride {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly envFrom?: readonly string[];
  readonly enabled?: boolean;
}

/** 用户新增或编辑的自定义 `Local ACP Command` 持久化条目。 */
export interface CustomExternalHarnessInput {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly flavor?: string;
  readonly registryId?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly envFrom?: readonly string[];
  readonly enabled: boolean;
}

/** `harnesses.json` 磁盘文档结构（`version: 1`）。 */
export interface ExternalHarnessesConfigFile {
  readonly version: 1;
  overrides: Record<string, BuiltinHarnessOverride>;
  custom: Record<string, Omit<CustomExternalHarnessInput, 'id'>>;
}

/** 合并内置预设与用户磁盘覆写后的单条解析结果。 */
export interface ResolvedExternalHarnessEntry {
  readonly definition: ExternalHarnessDefinition;
  /** 内置预设若存在任何磁盘增量覆写则为 `true`，供设置页控制「恢复默认」按钮显隐。 */
  readonly hasOverride: boolean;
}

/** 获取外部代理状态根目录（`~/.kapibala/external`）。 */
export function getExternalStateDirPath(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), '.kapibala', EXTERNAL_STATE_DIR_NAME);
}

/** 获取外部代理定义配置文件路径（`~/.kapibala/external/harnesses.json`）。 */
export function getExternalHarnessesConfigPath(homeDir?: string): string {
  return path.join(getExternalStateDirPath(homeDir), EXTERNAL_HARNESSES_FILE_NAME);
}

/**
 * 计算外部代理启动配置的确定性 SHA-256 指纹（对齐 Maka Continuity 守卫）。
 *
 * 参与字段：`transport`、`command`、`args`、`env`、`envFrom`；任一字段改动后指纹即变，
 * 会话管理层据此禁止向旧 `nativeSessionId` 盲目续聊，退化为安全只读历史归档。
 */
export function computeHarnessConfigDigest(def: ExternalHarnessDefinition): string {
  const normalized = {
    transport: def.transport,
    command: def.command.trim(),
    args: [...def.args],
    env: def.env ?? {},
    envFrom: [...(def.envFrom ?? [])].sort(),
  };
  return `sha256:${createHash('sha256').update(stableJson(normalized)).digest('hex')}`;
}

function isAllowedConfiguredCommandPath(raw: string): boolean {
  if (!raw.includes('/') && !raw.includes('\\')) return true;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return true;
  if (/^[A-Za-z]:[\\/]/.test(raw) || /^\\\\[^\\]+\\[^\\]+/.test(raw)) return true;
  // POSIX 绝对路径（排除单反斜杠开头的 Windows 盘内根相对路径 `\foo`）
  if (raw.startsWith('/') && !raw.startsWith('//')) return true;
  return false;
}

function validateCommandField(label: string, command: string): void {
  const trimmed = command.trim();
  if (!trimmed || hasAsciiControlCharacter(trimmed)) {
    throw new ExternalHarnessError(
      'EXTERNAL_CONFIG_INVALID',
      `[${label}] 命令不能为空或包含控制字符`,
    );
  }
  if (!isAllowedConfiguredCommandPath(trimmed)) {
    throw new ExternalHarnessError(
      'EXTERNAL_CONFIG_INVALID',
      `[${label}] 禁止使用相对路径命令 '${trimmed}'（请填写裸命令名或绝对路径）`,
    );
  }
  if (redactCommonSecrets(trimmed) !== trimmed) {
    throw new ExternalHarnessError(
      'EXTERNAL_CONFIG_INVALID',
      `[${label}] 命令中包含疑似明文凭据，请改用 envFrom 转发环境变量名`,
    );
  }
}

function validateArgsField(label: string, args: readonly string[]): void {
  if (args.length > 128) {
    throw new ExternalHarnessError(
      'EXTERNAL_CONFIG_INVALID',
      `[${label}] 启动参数数量不能超过 128 项`,
    );
  }
  for (const item of args) {
    if (typeof item !== 'string' || item.includes('\0') || item.length > 16_384) {
      throw new ExternalHarnessError(
        'EXTERNAL_CONFIG_INVALID',
        `[${label}] 启动参数必须为不含空字节且长度不超过 16KiB 的字符串`,
      );
    }
    if (redactCommonSecrets(item) !== item) {
      throw new ExternalHarnessError(
        'EXTERNAL_CONFIG_INVALID',
        `[${label}] 启动参数中包含疑似明文密钥，严禁将 API Key 写入参数列表`,
      );
    }
  }
}

function validateEnvField(label: string, env: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_VAR_NAME_PATTERN.test(key) || FORBIDDEN_EXTERNAL_ENV_KEYS.has(key.toUpperCase())) {
      throw new ExternalHarnessError(
        'EXTERNAL_CONFIG_INVALID',
        `[${label}] 环境变量名非法或受宿主保护：${key}`,
      );
    }
    if (isSensitiveEnvVarName(key)) {
      throw new ExternalHarnessError(
        'EXTERNAL_CONFIG_INVALID',
        `[${label}] 禁止在静态配置中保存敏感凭据 '${key}'，请改填至 envFrom 变量名白名单`,
      );
    }
    if (typeof value !== 'string' || hasAsciiControlCharacter(value)) {
      throw new ExternalHarnessError(
        'EXTERNAL_CONFIG_INVALID',
        `[${label}] 环境变量 '${key}' 值包含非法控制字符`,
      );
    }
    if (redactCommonSecrets(value) !== value) {
      throw new ExternalHarnessError(
        'EXTERNAL_CONFIG_INVALID',
        `[${label}] 环境变量 '${key}' 值包含疑似明文密钥，请改用 envFrom 按名透传`,
      );
    }
  }
}

function validateEnvFromField(label: string, envFrom: readonly string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const raw of envFrom) {
    if (typeof raw !== 'string') {
      throw new ExternalHarnessError(
        'EXTERNAL_CONFIG_INVALID',
        `[${label}] envFrom 项必须为字符串`,
      );
    }
    const name = raw.trim();
    if (!name) continue;
    if (
      name.length > 64 ||
      !ENV_VAR_NAME_PATTERN.test(name) ||
      FORBIDDEN_EXTERNAL_ENV_KEYS.has(name.toUpperCase())
    ) {
      throw new ExternalHarnessError(
        'EXTERNAL_CONFIG_INVALID',
        `[${label}] envFrom 包含非法或受禁的变量名：${name}`,
      );
    }
    if (!seen.has(name)) {
      if (deduped.length >= 64) {
        throw new ExternalHarnessError(
          'EXTERNAL_CONFIG_INVALID',
          `[${label}] envFrom 变量数量不能超过 64 项`,
        );
      }
      seen.add(name);
      deduped.push(name);
    }
  }
  return deduped;
}

function parseAndValidateConfigObject(raw: unknown): ExternalHarnessesConfigFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ExternalHarnessError(
      'EXTERNAL_CONFIG_CORRUPT',
      'harnesses.json 顶层必须为 JSON 对象',
    );
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== undefined && obj.version !== 1) {
    throw new ExternalHarnessError(
      'EXTERNAL_CONFIG_CORRUPT',
      `不支持的 harnesses.json 版本号：${String(obj.version)}`,
    );
  }
  if (
    obj.overrides !== undefined &&
    (typeof obj.overrides !== 'object' || Array.isArray(obj.overrides) || obj.overrides === null)
  ) {
    throw new ExternalHarnessError('EXTERNAL_CONFIG_CORRUPT', 'harnesses.json overrides 字段损坏');
  }
  if (
    obj.custom !== undefined &&
    (typeof obj.custom !== 'object' || Array.isArray(obj.custom) || obj.custom === null)
  ) {
    throw new ExternalHarnessError('EXTERNAL_CONFIG_CORRUPT', 'harnesses.json custom 字段损坏');
  }

  const overrides: Record<string, BuiltinHarnessOverride> = Object.create(null);
  for (const [id, rawOv] of Object.entries((obj.overrides as Record<string, unknown>) ?? {})) {
    if (isReservedObjectPropertyName(id) || !findBuiltinExternalHarness(id)) {
      throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', `未知的内置外部代理 ID：${id}`);
    }
    if (!rawOv || typeof rawOv !== 'object' || Array.isArray(rawOv)) {
      throw new ExternalHarnessError('EXTERNAL_CONFIG_CORRUPT', `内置覆写项 '${id}' 结构非法`);
    }
    const ov = rawOv as Record<string, unknown>;
    const normalized: {
      command?: string;
      args?: readonly string[];
      env?: Readonly<Record<string, string>>;
      envFrom?: readonly string[];
      enabled?: boolean;
    } = {};

    if (ov.command !== undefined) {
      if (typeof ov.command !== 'string') {
        throw new ExternalHarnessError('EXTERNAL_CONFIG_CORRUPT', `[${id}] command 必须为字符串`);
      }
      if (ov.command.trim()) {
        validateCommandField(id, ov.command);
        normalized.command = ov.command.trim();
      }
    }
    if (ov.args !== undefined) {
      if (!Array.isArray(ov.args)) {
        throw new ExternalHarnessError('EXTERNAL_CONFIG_CORRUPT', `[${id}] args 必须为数组`);
      }
      validateArgsField(id, ov.args as string[]);
      normalized.args = [...(ov.args as string[])];
    }
    if (ov.env !== undefined) {
      if (!ov.env || typeof ov.env !== 'object' || Array.isArray(ov.env)) {
        throw new ExternalHarnessError('EXTERNAL_CONFIG_CORRUPT', `[${id}] env 必须为对象`);
      }
      validateEnvField(id, ov.env as Record<string, string>);
      if (Object.keys(ov.env).length > 0) {
        normalized.env = { ...(ov.env as Record<string, string>) };
      }
    }
    if (ov.envFrom !== undefined) {
      if (!Array.isArray(ov.envFrom)) {
        throw new ExternalHarnessError('EXTERNAL_CONFIG_CORRUPT', `[${id}] envFrom 必须为数组`);
      }
      normalized.envFrom = validateEnvFromField(id, ov.envFrom as string[]);
    }
    if (ov.enabled !== undefined) {
      if (typeof ov.enabled !== 'boolean') {
        throw new ExternalHarnessError('EXTERNAL_CONFIG_CORRUPT', `[${id}] enabled 必须为布尔值`);
      }
      normalized.enabled = ov.enabled;
    }

    if (Object.keys(normalized).length > 0) {
      overrides[id] = normalized;
    }
  }

  const custom: Record<string, Omit<CustomExternalHarnessInput, 'id'>> = Object.create(null);
  for (const [id, rawItem] of Object.entries((obj.custom as Record<string, unknown>) ?? {})) {
    if (!HARNESS_ID_PATTERN.test(id) || isReservedObjectPropertyName(id)) {
      throw new ExternalHarnessError(
        'EXTERNAL_CONFIG_INVALID',
        `自定义代理 ID '${id}' 非法（仅允许小写字母、数字、连字符与下划线，最长 64 字符且不得使用保留属性名）`,
      );
    }
    if (findBuiltinExternalHarness(id)) {
      throw new ExternalHarnessError(
        'EXTERNAL_CONFIG_INVALID',
        `自定义代理 ID '${id}' 与内置预设重名，请更换标识`,
      );
    }
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      throw new ExternalHarnessError('EXTERNAL_CONFIG_CORRUPT', `自定义代理 '${id}' 结构非法`);
    }
    const item = rawItem as Record<string, unknown>;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name || hasAsciiControlCharacter(name)) {
      throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', `[${id}] 显示名称不能为空`);
    }
    if (typeof item.command !== 'string') {
      throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', `[${id}] 缺少可执行命令`);
    }
    validateCommandField(id, item.command);

    const args = Array.isArray(item.args) ? (item.args as string[]) : [];
    validateArgsField(id, args);

    let env: Record<string, string> | undefined;
    if (item.env !== undefined) {
      if (!item.env || typeof item.env !== 'object' || Array.isArray(item.env)) {
        throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', `[${id}] env 必须为对象`);
      }
      validateEnvField(id, item.env as Record<string, string>);
      if (Object.keys(item.env).length > 0) {
        env = { ...(item.env as Record<string, string>) };
      }
    }

    let envFrom: string[] | undefined;
    if (item.envFrom !== undefined) {
      if (!Array.isArray(item.envFrom)) {
        throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', `[${id}] envFrom 必须为数组`);
      }
      const cleaned = validateEnvFromField(id, item.envFrom as string[]);
      if (cleaned.length > 0) envFrom = cleaned;
    }

    const flavor =
      typeof item.flavor === 'string' && item.flavor.trim() ? item.flavor.trim() : undefined;
    const registryId =
      typeof item.registryId === 'string' && item.registryId.trim()
        ? item.registryId.trim()
        : undefined;
    const enabled = item.enabled !== false;

    custom[id] = {
      name,
      command: item.command.trim(),
      args: [...args],
      ...(flavor ? { flavor } : {}),
      ...(registryId ? { registryId } : {}),
      ...(env ? { env } : {}),
      ...(envFrom ? { envFrom } : {}),
      enabled,
    };
  }

  return {
    version: 1,
    overrides,
    custom,
  };
}

/**
 * 读取 `~/.kapibala/external/harnesses.json` 原始增量配置。
 *
 * 失败边界：文件不存在时返回空骨架；JSON 语法错误或字段损坏时抛 `EXTERNAL_CONFIG_CORRUPT`，绝不静默返回空对象抹掉用户配置。
 */
export function readExternalHarnessesConfig(
  options: { readonly homeDir?: string } = {},
): ExternalHarnessesConfigFile {
  const filePath = getExternalHarnessesConfigPath(options.homeDir);
  let rawText: string;
  try {
    rawText = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, overrides: {}, custom: {} };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (cause) {
    throw new ExternalHarnessError(
      'EXTERNAL_CONFIG_CORRUPT',
      `外部代理配置文件 ${filePath} JSON 损坏，已拒绝覆盖写入`,
      { cause },
    );
  }
  return parseAndValidateConfigObject(parsed);
}

/**
 * 合并内置预设与用户磁盘配置，产出完整的外部代理列表（内置在前、自定义按 ID 排序在后）。
 */
export function listResolvedExternalHarnesses(
  options: { readonly homeDir?: string } = {},
): ResolvedExternalHarnessEntry[] {
  const file = readExternalHarnessesConfig(options);
  const results: ResolvedExternalHarnessEntry[] = [];

  for (const builtin of BUILTIN_EXTERNAL_HARNESSES) {
    const ov = Object.hasOwn(file.overrides, builtin.id) ? file.overrides[builtin.id] : undefined;
    const hasOverride = Boolean(ov && Object.keys(ov).length > 0);
    results.push({
      hasOverride,
      definition: {
        ...builtin,
        ...(ov?.command !== undefined ? { command: ov.command } : {}),
        ...(ov?.args !== undefined ? { args: ov.args } : {}),
        ...(ov?.env !== undefined ? { env: ov.env } : {}),
        ...(ov?.envFrom !== undefined ? { envFrom: ov.envFrom } : {}),
        ...(ov?.enabled !== undefined ? { enabled: ov.enabled } : {}),
        builtin: true,
      },
    });
  }

  for (const id of Object.keys(file.custom).sort()) {
    if (isReservedObjectPropertyName(id) || !Object.hasOwn(file.custom, id)) continue;
    const entry = file.custom[id]!;
    results.push({
      hasOverride: false,
      definition: {
        id,
        name: entry.name,
        transport: 'acp',
        command: entry.command,
        args: entry.args,
        ...(entry.flavor ? { flavor: entry.flavor } : {}),
        ...(entry.registryId ? { registryId: entry.registryId } : {}),
        ...(entry.env ? { env: entry.env } : {}),
        ...(entry.envFrom ? { envFrom: entry.envFrom } : {}),
        builtin: false,
        enabled: entry.enabled,
      },
    });
  }

  return results;
}

/**
 * `harnesses.json` 独占锁短事务：锁内重读 → 同步修改 → 全量结构与凭据安全校验 → `tmp + rename` 原子替换。
 *
 * 与 `mutateMcpConfig` 保持同一锁纪律：竞争立即抛 `EXTERNAL_CONFIG_BUSY`（绝不自动抢占锁），释放时校验随机 `owner`。
 */
export function mutateExternalHarnessesConfig<T>(
  mutate: (draft: ExternalHarnessesConfigFile) => T,
  options: { readonly homeDir?: string } = {},
): T {
  const filePath = getExternalHarnessesConfigPath(options.homeDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });

  const lockPath = `${filePath}.lock`;
  const owner = randomUUID();
  let lockFd: number;
  try {
    lockFd = fs.openSync(lockPath, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ExternalHarnessError(
        'EXTERNAL_CONFIG_BUSY',
        `外部代理配置锁 ${lockPath} 已被占用；请等待并发写入结束后重试`,
      );
    }
    throw err;
  }

  try {
    fs.writeFileSync(lockFd, JSON.stringify({ owner, pid: process.pid }));
    const draft = readExternalHarnessesConfig(options);
    const out = mutate(draft);
    const rawOut: unknown = out;
    if (rawOut && typeof (rawOut as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(rawOut).catch(() => {});
      throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', '外部代理配置事务回调必须同步完成');
    }

    const validated = parseAndValidateConfigObject(draft);
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, serialized, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      fs.renameSync(tempPath, filePath);
    } catch (err) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* ignore missing temp */
      }
      throw err;
    }
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* ignore chmod on Windows */
    }
    return out;
  } finally {
    fs.closeSync(lockFd);
    try {
      const currentOwner = (JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { owner?: string })
        .owner;
      if (currentOwner === owner) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      /* 保留异常现场 */
    }
  }
}

/**
 * 保存内置外部代理的路径、参数或 `envFrom` 覆写差量。
 *
 * 置空回退语义：当传入 `override.command === ''`（或与内置默认命令相同）时，显式移除 `command` 覆写键回退至内置命令，
 * 同时保留已配置的 `args` / `envFrom`；若合并后所有字段均回到内置默认值，自动清理空 `overrides[id]` 条目。
 */
export function saveBuiltinHarnessOverride(
  id: string,
  override: BuiltinHarnessOverride,
  options: { readonly homeDir?: string } = {},
): void {
  const builtin = findBuiltinExternalHarness(id);
  if (isReservedObjectPropertyName(id) || !builtin) {
    throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', `未知的内置外部代理 ID：${id}`);
  }
  mutateExternalHarnessesConfig((draft) => {
    const prev = Object.hasOwn(draft.overrides, id) ? draft.overrides[id]! : {};
    const next: {
      command?: string;
      args?: readonly string[];
      env?: Readonly<Record<string, string>>;
      envFrom?: readonly string[];
      enabled?: boolean;
    } = {
      ...prev,
      ...override,
    };
    if (
      next.command !== undefined &&
      (next.command.trim() === '' || next.command.trim() === builtin.command)
    ) {
      next.command = undefined;
    }
    if (
      (next.enabled === undefined || next.enabled === builtin.enabled) &&
      next.command === undefined &&
      next.args === undefined &&
      next.env === undefined &&
      next.envFrom === undefined
    ) {
      delete draft.overrides[id];
    } else {
      draft.overrides[id] = next;
    }
  }, options);
}

/** 清除指定内置外部代理的全部覆写字段，一键恢复代码默认设定。 */
export function resetBuiltinHarnessOverride(
  id: string,
  options: { readonly homeDir?: string } = {},
): boolean {
  if (isReservedObjectPropertyName(id) || !findBuiltinExternalHarness(id)) {
    throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', `未知的内置外部代理 ID：${id}`);
  }
  return mutateExternalHarnessesConfig((draft) => {
    if (!Object.hasOwn(draft.overrides, id)) return false;
    delete draft.overrides[id];
    return true;
  }, options);
}

/** 切换内置或自定义外部代理的启用状态。 */
export function toggleExternalHarness(
  id: string,
  enabled: boolean,
  options: { readonly homeDir?: string } = {},
): void {
  if (!id || isReservedObjectPropertyName(id)) {
    throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', `非法的外部代理 ID：${id}`);
  }
  mutateExternalHarnessesConfig((draft) => {
    const builtin = findBuiltinExternalHarness(id);
    if (builtin) {
      const prev = Object.hasOwn(draft.overrides, id) ? draft.overrides[id]! : {};
      const next = { ...prev, enabled };
      if (
        enabled === builtin.enabled &&
        next.command === undefined &&
        next.args === undefined &&
        next.env === undefined &&
        next.envFrom === undefined
      ) {
        delete draft.overrides[id];
      } else {
        draft.overrides[id] = next;
      }
      return;
    }
    const custom = Object.hasOwn(draft.custom, id) ? draft.custom[id] : undefined;
    if (!custom) {
      throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', `未找到外部代理定义：${id}`);
    }
    draft.custom[id] = { ...custom, enabled };
  }, options);
}

/** 新增或更新一条自定义 `Local ACP Command` 外部代理。 */
export function upsertCustomExternalHarness(
  entry: CustomExternalHarnessInput,
  options: { readonly homeDir?: string } = {},
): void {
  const id = entry.id.trim();
  if (!HARNESS_ID_PATTERN.test(id) || isReservedObjectPropertyName(id)) {
    throw new ExternalHarnessError(
      'EXTERNAL_CONFIG_INVALID',
      `自定义代理 ID '${id}' 非法（仅允许小写字母、数字、连字符与下划线，最长 64 字符且不得使用保留属性名）`,
    );
  }
  mutateExternalHarnessesConfig((draft) => {
    const { id: _ignored, ...rest } = entry;
    draft.custom[id] = rest;
  }, options);
}

/** 删除一条用户自定义外部代理；尝试删除内置预设时抛 `EXTERNAL_CONFIG_INVALID` 引导使用停用或重置。 */
export function removeCustomExternalHarness(
  id: string,
  options: { readonly homeDir?: string } = {},
): boolean {
  if (!id || isReservedObjectPropertyName(id)) {
    return false;
  }
  if (findBuiltinExternalHarness(id)) {
    throw new ExternalHarnessError(
      'EXTERNAL_CONFIG_INVALID',
      `'${id}' 为内置外部代理，不能删除；可将其停用或恢复默认设置`,
    );
  }
  return mutateExternalHarnessesConfig((draft) => {
    if (!Object.hasOwn(draft.custom, id)) return false;
    delete draft.custom[id];
    return true;
  }, options);
}
