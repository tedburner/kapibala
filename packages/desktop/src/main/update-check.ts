/** GitHub Releases 仓库；与根 package.json 的 repository 同源，更新检查只认这个仓库。 */
export const UPDATE_REPOSITORY = 'tedburner/kapibala';

/** 检查通道固定 `latest`：本版只有稳定通道，不做 beta / nightly 分流。 */
export const LATEST_RELEASE_API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;

/** 桌面支持的更新目标；与发布工作流的四平台安装包一一对应。 */
export type DesktopUpdateTarget = 'darwin-arm64' | 'darwin-x64' | 'win32-x64' | 'linux-x64';

/** GitHub Release 资产的展示最小面；不保留无关字段，避免页面透传整个 API 响应。 */
export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

/** 更新检查结果；`unknown` 表示无法判断（离线、限流、响应异常），UI 据此静默降级。 */
export interface UpdateCheckResult {
  status: 'update-available' | 'up-to-date' | 'no-asset' | 'unknown';
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  installer?: { name: string; url: string; size: number };
  checksum?: { name: string; url: string };
  /** 无法判断时的稳定原因码；只用于诊断展示，不影响启动。 */
  reason?: string;
}

/** 仅注入实际用到的 fetch 能力，单测无需构造完整 Response。 */
export type UpdateFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * 平台与安装包资产矩阵。
 *
 * 资产名形如 `Kapibala-0.1.4-mac-arm64-test.dmg`：用显式 token 匹配平台与架构，
 * 未知 target 明确失败而不是模糊猜测（避免把 x64 包当 arm64 下载）。
 */
const TARGET_MATCHERS: Record<
  DesktopUpdateTarget,
  { tokens: readonly string[]; extensions: readonly string[]; suffix: string }
> = {
  'darwin-arm64': { tokens: ['-mac-arm64'], extensions: ['.dmg', '.zip'], suffix: 'mac-arm64' },
  'darwin-x64': { tokens: ['-mac-x64'], extensions: ['.dmg', '.zip'], suffix: 'mac-x64' },
  'win32-x64': { tokens: ['-win-x64'], extensions: ['.exe'], suffix: 'win-x64' },
  'linux-x64': { tokens: ['-linux-x64'], extensions: ['.AppImage'], suffix: 'linux-x64' },
};

/** 把 Node 的 platform/arch 映射为显式 target；不支持的组合返回 undefined。 */
export function resolveDesktopTarget(
  platform: NodeJS.Platform,
  arch: string,
): DesktopUpdateTarget | undefined {
  const key = `${platform}-${arch}`;
  return key in TARGET_MATCHERS ? (key as DesktopUpdateTarget) : undefined;
}

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string;
}

/** 解析 `v0.1.3` / `0.1.3-beta.1`；非法版本返回 undefined，调用方按「无法判断」降级。 */
function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    value.trim(),
  );
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? '',
  };
}

/**
 * 比较两个版本号：左侧小于右侧返回 -1，相等 0，大于 1；任一侧非法返回 undefined。
 * 预发布版本低于同号正式版（`0.1.4-beta` < `0.1.4`），与 semver 的排序口径一致。
 */
export function compareVersions(left: string, right: string): number | undefined {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

/** 从 assets 中挑出当前平台安装包与对应校验清单；缺失任一项返回 undefined。 */
export function matchDesktopAssets(
  assets: readonly ReleaseAsset[],
  target: DesktopUpdateTarget,
): { installer: ReleaseAsset; checksum: ReleaseAsset } | undefined {
  const matcher = TARGET_MATCHERS[target];
  const installer = matcher.extensions
    .map((extension) =>
      assets.find(
        (asset) =>
          asset.name.endsWith(extension) &&
          matcher.tokens.every((token) => asset.name.includes(token)),
      ),
    )
    .find((asset): asset is ReleaseAsset => asset !== undefined);
  if (!installer) return undefined;
  // 桌面安装包按平台各传一份 SHA256SUMS-<suffix>.txt；兼容单份通用清单。
  const checksum =
    assets.find((asset) => asset.name === `SHA256SUMS-${matcher.suffix}.txt`) ??
    assets.find((asset) => asset.name === 'SHA256SUMS.txt');
  if (!checksum) return undefined;
  return { installer, checksum };
}

function asAsset(value: unknown): ReleaseAsset | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.name !== 'string' ||
    typeof record.browser_download_url !== 'string' ||
    typeof record.size !== 'number'
  )
    return undefined;
  return {
    name: record.name,
    browser_download_url: record.browser_download_url,
    size: record.size,
  };
}

/**
 * 查询 GitHub Releases 最新正式版并判断是否需要更新。
 *
 * 边界：只发一个 GET，超时 10 秒；任何网络 / 响应 / 版本解析异常都返回 `unknown`，
 * 由界面静默降级——更新检查不允许影响启动或其它功能。
 * 本函数不下载、不安装，只返回资产地址与摘要清单地址。
 */
export async function checkForDesktopUpdate(options: {
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  fetch: UpdateFetch;
  timeoutMs?: number;
}): Promise<UpdateCheckResult> {
  const target = resolveDesktopTarget(options.platform, options.arch);
  if (!target)
    return {
      status: 'unknown',
      currentVersion: options.currentVersion,
      reason: 'UNSUPPORTED_PLATFORM',
    };
  let release: Record<string, unknown>;
  try {
    const response = await options.fetch(LATEST_RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Kapibala-Desktop-Update',
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (!response.ok)
      return {
        status: 'unknown',
        currentVersion: options.currentVersion,
        reason: `HTTP_${response.status}`,
      };
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object')
      return {
        status: 'unknown',
        currentVersion: options.currentVersion,
        reason: 'INVALID_RELEASE',
      };
    release = body as Record<string, unknown>;
  } catch {
    return { status: 'unknown', currentVersion: options.currentVersion, reason: 'NETWORK' };
  }
  const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
  const latestVersion = tag.replace(/^v/, '');
  const comparison = compareVersions(options.currentVersion, latestVersion);
  if (!tag || comparison === undefined)
    return {
      status: 'unknown',
      currentVersion: options.currentVersion,
      reason: 'INVALID_VERSION',
    };
  const releaseUrl =
    typeof release.html_url === 'string'
      ? release.html_url
      : `https://github.com/${UPDATE_REPOSITORY}/releases/tag/${tag}`;
  if (comparison >= 0)
    return {
      status: 'up-to-date',
      currentVersion: options.currentVersion,
      latestVersion,
      releaseUrl,
    };
  const assets = Array.isArray(release.assets)
    ? release.assets.map(asAsset).filter((asset): asset is ReleaseAsset => asset !== undefined)
    : [];
  const matched = matchDesktopAssets(assets, target);
  if (!matched)
    return {
      status: 'no-asset',
      currentVersion: options.currentVersion,
      latestVersion,
      releaseUrl,
      reason: 'NO_MATCHING_ASSET',
    };
  return {
    status: 'update-available',
    currentVersion: options.currentVersion,
    latestVersion,
    releaseUrl,
    installer: {
      name: matched.installer.name,
      url: matched.installer.browser_download_url,
      size: matched.installer.size,
    },
    checksum: {
      name: matched.checksum.name,
      url: matched.checksum.browser_download_url,
    },
  };
}
