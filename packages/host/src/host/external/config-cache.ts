import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ViewExternalConfigChoice, ViewExternalConfigOption } from '../../view-model/index.js';
import { getExternalStateDirPath } from './config.js';
import { orderThoughtLevels } from './thought-levels.js';
import { isReservedObjectPropertyName } from './types.js';

/** 外部代理可用模型/模式/推理档位本地缓存文件名（`~/.kapibala/external/config-cache.json`）。 */
export const EXTERNAL_CONFIG_CACHE_FILE_NAME = 'config-cache.json';

/** 缓存文件结构版本（v2 携带逐模型 `supportedThoughtLevels` 与 `defaultThoughtLevel` 元数据）。 */
const EXTERNAL_CONFIG_CACHE_VERSION = 2;

export interface CachedHarnessConfigEntry {
  readonly configDigest: string;
  readonly updatedAt: number;
  readonly configOptions: readonly ViewExternalConfigOption[];
}

interface ExternalConfigCacheFile {
  readonly version: typeof EXTERNAL_CONFIG_CACHE_VERSION;
  readonly entries: Record<string, CachedHarnessConfigEntry>;
}

function cacheFilePath(homeDir?: string): string {
  return path.join(getExternalStateDirPath(homeDir), EXTERNAL_CONFIG_CACHE_FILE_NAME);
}

/** 读取本地配置选项缓存；文件缺失、旧版本或损坏时静默回退空表，触发按需重刷而不阻断启动。 */
export function readHarnessConfigCache(
  homeDir?: string,
): Readonly<Record<string, CachedHarnessConfigEntry>> {
  let raw: string;
  try {
    raw = fs.readFileSync(cacheFilePath(homeDir), 'utf8');
  } catch {
    return Object.create(null) as Record<string, CachedHarnessConfigEntry>;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ExternalConfigCacheFile>;
    if (
      parsed.version !== EXTERNAL_CONFIG_CACHE_VERSION ||
      !parsed.entries ||
      typeof parsed.entries !== 'object' ||
      Array.isArray(parsed.entries)
    ) {
      return Object.create(null) as Record<string, CachedHarnessConfigEntry>;
    }
    const clean: Record<string, CachedHarnessConfigEntry> = Object.create(null);
    for (const [id, entry] of Object.entries(parsed.entries)) {
      if (isReservedObjectPropertyName(id) || !entry || typeof entry !== 'object') continue;
      if (
        typeof entry.configDigest !== 'string' ||
        typeof entry.updatedAt !== 'number' ||
        !Array.isArray(entry.configOptions)
      ) {
        continue;
      }
      clean[id] = entry;
    }
    return clean;
  } catch {
    return Object.create(null) as Record<string, CachedHarnessConfigEntry>;
  }
}

function writeCacheFile(
  homeDir: string | undefined,
  entries: Record<string, CachedHarnessConfigEntry>,
): void {
  const filePath = cacheFilePath(homeDir);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const payload: ExternalConfigCacheFile = {
      version: EXTERNAL_CONFIG_CACHE_VERSION,
      entries,
    };
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(tempPath, filePath);
  } catch {
    /* 纯性能优化缓存：写盘失败静默忽略，不影响主路径 */
  }
}

/**
 * 权威写入单个外部代理的可用配置项缓存（供 `testHarness` 全量刷新调用，按 `configDigest` 绑定）。
 * 仅存已脱敏的展示模型/模式/档位目录，不含任何凭据或环境变量。
 */
export function saveHarnessConfigCache(
  homeDir: string | undefined,
  harnessId: string,
  configDigest: string,
  configOptions: readonly ViewExternalConfigOption[],
): void {
  if (!harnessId || isReservedObjectPropertyName(harnessId) || configOptions.length === 0) return;
  const current = { ...readHarnessConfigCache(homeDir) };
  current[harnessId] = {
    configDigest,
    updatedAt: Date.now(),
    configOptions,
  };
  writeCacheFile(homeDir, current);
}

/**
 * 在会话启动或热切换配置后增量合并本地缓存：
 * - 若尚无同指纹缓存，直接用本次会话目录补种；
 * - 若已有完整探测缓存，保留各模型的 `supportedThoughtLevels` / `defaultThoughtLevel` 与全局 `thought_level` 并集，
 *   防止启动单个无推理档位模型（如 `opencode/big-pickle`）把全量探测缓存冲掉。
 */
export function mergeHarnessConfigCache(
  homeDir: string | undefined,
  harnessId: string,
  configDigest: string,
  incomingOptions: readonly ViewExternalConfigOption[],
): void {
  if (!harnessId || isReservedObjectPropertyName(harnessId) || incomingOptions.length === 0) {
    return;
  }
  const current = { ...readHarnessConfigCache(homeDir) };
  const existing = Object.hasOwn(current, harnessId) ? current[harnessId] : undefined;
  if (!existing || existing.configDigest !== configDigest || existing.configOptions.length === 0) {
    current[harnessId] = {
      configDigest,
      updatedAt: Date.now(),
      configOptions: incomingOptions,
    };
    writeCacheFile(homeDir, current);
    return;
  }

  const prevByCat = new Map(existing.configOptions.map((o) => [o.category, o]));
  const nextByCat = new Map(incomingOptions.map((o) => [o.category, o]));
  const merged: ViewExternalConfigOption[] = [];

  for (const cat of ['model', 'thought_level', 'mode'] as const) {
    const prev = prevByCat.get(cat);
    const next = nextByCat.get(cat);
    if (!prev && !next) continue;
    if (!prev && next) {
      merged.push(next);
      continue;
    }
    if (prev && !next) {
      merged.push(prev);
      continue;
    }
    if (cat === 'model' && prev && next) {
      const prevChoiceByVal = new Map(prev.options.map((c) => [c.value, c]));
      const mergedChoices: ViewExternalConfigChoice[] = next.options.map((choice) => {
        const old = prevChoiceByVal.get(choice.value);
        if (!old) return choice;
        return {
          ...choice,
          ...(choice.supportedThoughtLevels !== undefined
            ? { supportedThoughtLevels: choice.supportedThoughtLevels }
            : old.supportedThoughtLevels !== undefined
              ? { supportedThoughtLevels: old.supportedThoughtLevels }
              : {}),
          ...(choice.defaultThoughtLevel !== undefined
            ? { defaultThoughtLevel: choice.defaultThoughtLevel }
            : old.defaultThoughtLevel !== undefined
              ? { defaultThoughtLevel: old.defaultThoughtLevel }
              : {}),
        };
      });
      for (const old of prev.options) {
        if (!mergedChoices.some((c) => c.value === old.value)) {
          mergedChoices.push(old);
        }
      }
      merged.push({
        ...prev,
        id: next.id,
        options: mergedChoices,
      });
      continue;
    }
    if (cat === 'thought_level' && prev && next) {
      const byVal = new Map<string, ViewExternalConfigChoice>();
      for (const c of prev.options) byVal.set(c.value, c);
      for (const c of next.options) byVal.set(c.value, c);
      const ordered = orderThoughtLevels(byVal.keys()).map((v) => byVal.get(v)!);
      merged.push({
        ...prev,
        id: next.id,
        options: ordered,
      });
      continue;
    }
    merged.push(prev!);
  }

  current[harnessId] = {
    configDigest,
    updatedAt: existing.updatedAt,
    configOptions: merged,
  };
  writeCacheFile(homeDir, current);
}

/** 清除单个外部代理的本地配置项缓存（用于覆盖配置、恢复默认或删除自定义代理后失效）。 */
export function deleteHarnessConfigCache(homeDir: string | undefined, harnessId: string): void {
  if (!harnessId || isReservedObjectPropertyName(harnessId)) return;
  const current = { ...readHarnessConfigCache(homeDir) };
  if (!Object.hasOwn(current, harnessId)) return;
  delete current[harnessId];
  writeCacheFile(homeDir, current);
}
