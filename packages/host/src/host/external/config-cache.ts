import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ViewExternalConfigOption } from '../../view-model/index.js';
import { getExternalStateDirPath } from './config.js';
import { isReservedObjectPropertyName } from './types.js';

/** 外部代理可用模型/模式/推理档位本地缓存文件名（`~/.kapibala/external/config-cache.json`）。 */
export const EXTERNAL_CONFIG_CACHE_FILE_NAME = 'config-cache.json';

interface CachedHarnessConfigEntry {
  readonly configDigest: string;
  readonly updatedAt: number;
  readonly configOptions: readonly ViewExternalConfigOption[];
}

interface ExternalConfigCacheFile {
  readonly version: 1;
  readonly entries: Record<string, CachedHarnessConfigEntry>;
}

function cacheFilePath(homeDir?: string): string {
  return path.join(getExternalStateDirPath(homeDir), EXTERNAL_CONFIG_CACHE_FILE_NAME);
}

/** 读取本地配置选项缓存；文件缺失或损坏时静默回退空表，绝不阻断代理列表或启动流程。 */
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
      parsed.version !== 1 ||
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
    const payload: ExternalConfigCacheFile = { version: 1, entries };
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
 * 写入单个外部代理的可用配置项缓存（按 `configDigest` 绑定，配置变更后自动失效）。
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

/** 清除单个外部代理的本地配置项缓存（用于覆盖配置、恢复默认或删除自定义代理后失效）。 */
export function deleteHarnessConfigCache(homeDir: string | undefined, harnessId: string): void {
  if (!harnessId || isReservedObjectPropertyName(harnessId)) return;
  const current = { ...readHarnessConfigCache(homeDir) };
  if (!Object.hasOwn(current, harnessId)) return;
  delete current[harnessId];
  writeCacheFile(homeDir, current);
}
