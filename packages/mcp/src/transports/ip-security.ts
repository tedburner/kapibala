/**
 * @fileoverview MCP HTTP 传输安全网关与 IP/DNS 校验工具
 *
 * 约束与边界：
 * 1. 严格全量私网与保留网段拦截（SSRF 防御）：
 *    - IPv4: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 (RFC 1918 私网)；
 *            169.254.0.0/16 (链路本地与云元数据端点)；
 *            100.64.0.0/10 (CGNAT RFC 6598)；
 *            0.0.0.0/8 (当前网络)；
 *            224.0.0.0/4 (组播)；
 *            240.0.0.0/4 (保留网段与广播)；
 *    - IPv6: fc00::/7 (唯一本地地址 ULA RFC 4193)；
 *            fe80::/10 (链路本地)；
 *            ff00::/8 (组播)；
 *            ::/128 (未指定地址)；
 *            ::ffff:0:0/96 (IPv4 映射地址解包为 IPv4 后同等校验)；
 * 2. 协议与回环约束：
 *    - 默认强制 HTTPS；
 *    - 仅回环地址（localhost, 127.0.0.0/8, ::1/128）允许显式使用 HTTP；
 *    - 拒绝包含 user:pass 认证凭据的 URL，防止凭据泄露；
 *    - 明确拒绝旧 SSE 协议（sse: 或 http+sse:）。
 */

import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';

/**
 * IP 限制校验结果。
 */
export interface IpCheckResult {
  /** 是否属于受限制或私有网段。 */
  restricted: boolean;
  /** 是否属于回环地址。 */
  isLoopback: boolean;
  /** 违规或命中规则说明。 */
  reason?: string;
}

/**
 * 将点分十进制 IPv4 地址字符串转为 32 位无符号整型数值。
 *
 * @param ip - 经过校验的 IPv4 地址字符串。
 * @returns 32 位无符号整数。
 */
export function ipv4ToUint32(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * 将 IPv6 地址字符串展开并规范化为 8 个 16 位整数数组。
 *
 * 支持双冒号缩写展开、IPv4 映射形式（如 ::ffff:192.168.1.1）及方括号剥除。
 *
 * @param ip - IPv6 地址字符串。
 * @returns 8 个 16 位无符号整数构成的元组。
 * @throws 当输入格式不合法时抛出异常。
 */
export function expandIPv6(ip: string): number[] {
  let clean = ip.toLowerCase();
  if (clean.startsWith('[') && clean.endsWith(']')) {
    clean = clean.slice(1, -1);
  }

  // 处理 IPv4 映射形式 ::ffff:192.168.1.1
  const v4Match = clean.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Match) {
    const v4Parts = v4Match[2].split('.').map(Number);
    const hex1 = (((v4Parts[0] << 8) | v4Parts[1]) >>> 0).toString(16);
    const hex2 = (((v4Parts[2] << 8) | v4Parts[3]) >>> 0).toString(16);
    clean = `${v4Match[1]}${hex1}:${hex2}`;
  }

  const parts = clean.split('::');
  if (parts.length > 2) {
    throw new Error(`Invalid IPv6 address: multiple '::' occurrences in '${ip}'`);
  }

  const left = parts[0] ? parts[0].split(':').map((h) => Number.parseInt(h, 16)) : [];
  const right =
    parts.length === 2 && parts[1] ? parts[1].split(':').map((h) => Number.parseInt(h, 16)) : [];

  if (parts.length === 2) {
    const missing = 8 - (left.length + right.length);
    if (missing < 0) {
      throw new Error(`Invalid IPv6 address: excessive segment count in '${ip}'`);
    }
    const zeros = new Array<number>(missing).fill(0);
    return [...left, ...zeros, ...right];
  }

  if (left.length !== 8) {
    throw new Error(`Invalid IPv6 address: segment count is not 8 in '${ip}'`);
  }
  return left;
}

/**
 * 校验给定 IPv4 地址是否属于受限制或私有保留网段。
 *
 * 覆盖规则：
 * - 127.0.0.0/8: 回环地址；
 * - 10.0.0.0/8: RFC 1918 私网；
 * - 172.16.0.0/12: RFC 1918 私网；
 * - 192.168.0.0/16: RFC 1918 私网；
 * - 169.254.0.0/16: RFC 3927 链路本地与云元数据；
 * - 100.64.0.0/10: RFC 6598 运营商级 NAT (CGNAT)；
 * - 0.0.0.0/8: 本地网络；
 * - 224.0.0.0/4: 组播；
 * - 240.0.0.0/4: 保留网段及广播。
 *
 * @param ip - IPv4 地址字符串。
 * @returns 校验结果。
 */
export function checkIPv4Restricted(ip: string): IpCheckResult {
  const num = ipv4ToUint32(ip);

  // 127.0.0.0/8 回环
  if (num >>> 24 === 127) {
    return { restricted: true, isLoopback: true, reason: 'IPv4 loopback address (127.0.0.0/8)' };
  }

  // 10.0.0.0/8 私网
  if (num >>> 24 === 10) {
    return { restricted: true, isLoopback: false, reason: 'RFC 1918 private network (10.0.0.0/8)' };
  }

  // 172.16.0.0/12 私网
  if (num >>> 20 === 0xac1) {
    return {
      restricted: true,
      isLoopback: false,
      reason: 'RFC 1918 private network (172.16.0.0/12)',
    };
  }

  // 192.168.0.0/16 私网
  if (num >>> 16 === 0xc0a8) {
    return {
      restricted: true,
      isLoopback: false,
      reason: 'RFC 1918 private network (192.168.0.0/16)',
    };
  }

  // 169.254.0.0/16 链路本地 / 云元数据
  if (num >>> 16 === 0xa9fe) {
    return {
      restricted: true,
      isLoopback: false,
      reason: 'RFC 3927 link-local / cloud metadata address (169.254.0.0/16)',
    };
  }

  // 100.64.0.0/10 CGNAT
  if (num >>> 22 === 0x191) {
    return {
      restricted: true,
      isLoopback: false,
      reason: 'RFC 6598 shared address space / CGNAT (100.64.0.0/10)',
    };
  }

  // 0.0.0.0/8 当前网络
  if (num >>> 24 === 0) {
    return { restricted: true, isLoopback: false, reason: 'Current network (0.0.0.0/8)' };
  }

  // 224.0.0.0/4 组播
  if (num >>> 28 === 14) {
    return { restricted: true, isLoopback: false, reason: 'Multicast address (224.0.0.0/4)' };
  }

  // 240.0.0.0/4 保留网段
  if (num >>> 28 === 15) {
    return { restricted: true, isLoopback: false, reason: 'Reserved address block (240.0.0.0/4)' };
  }

  return { restricted: false, isLoopback: false };
}

/**
 * 校验给定 IPv6 地址是否属于受限制或私有保留网段。
 *
 * 覆盖规则：
 * - ::1/128: 回环地址；
 * - ::/128: 未指定地址；
 * - fc00::/7: RFC 4193 唯一本地地址 (ULA)；
 * - fe80::/10: 链路本地；
 * - ff00::/8: 组播；
 * - ::ffff:0:0/96: IPv4 映射地址（解包后转由 checkIPv4Restricted 严格判定）。
 *
 * @param ip - IPv6 地址字符串。
 * @returns 校验结果。
 */
export function checkIPv6Restricted(ip: string): IpCheckResult {
  let words: number[];
  try {
    words = expandIPv6(ip);
  } catch (err: unknown) {
    return {
      restricted: true,
      isLoopback: false,
      reason: `Malformed IPv6 address: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 检查是否为 IPv4 映射 IPv6 (::ffff:w.x.y.z)
  const isV4Mapped =
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0xffff;

  if (isV4Mapped) {
    const v4Num = ((words[6] << 16) | words[7]) >>> 0;
    const v4String = [
      (v4Num >>> 24) & 0xff,
      (v4Num >>> 16) & 0xff,
      (v4Num >>> 8) & 0xff,
      v4Num & 0xff,
    ].join('.');
    return checkIPv4Restricted(v4String);
  }

  // ::1/128 回环
  const isLoopback =
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0 &&
    words[6] === 0 &&
    words[7] === 1;

  if (isLoopback) {
    return { restricted: true, isLoopback: true, reason: 'IPv6 loopback address (::1/128)' };
  }

  // ::/128 未指定
  const isUnspecified = words.every((w) => w === 0);
  if (isUnspecified) {
    return { restricted: true, isLoopback: false, reason: 'IPv6 unspecified address (::/128)' };
  }

  // fc00::/7 ULA (fc00:: - fdff::)
  if ((words[0] & 0xfe00) === 0xfc00) {
    return {
      restricted: true,
      isLoopback: false,
      reason: 'RFC 4193 Unique Local Address / ULA (fc00::/7)',
    };
  }

  // fe80::/10 链路本地 (fe80:: - febf::)
  if ((words[0] & 0xffc0) === 0xfe80) {
    return { restricted: true, isLoopback: false, reason: 'Link-local address (fe80::/10)' };
  }

  // ff00::/8 组播
  if ((words[0] & 0xff00) === 0xff00) {
    return { restricted: true, isLoopback: false, reason: 'Multicast address (ff00::/8)' };
  }

  return { restricted: false, isLoopback: false };
}

/**
 * 校验给定 IP 字符串（IPv4 或 IPv6）是否属于受限制网段。
 *
 * @param ip - IP 字符串。
 * @returns 校验结果。
 */
export function checkIpRestricted(ip: string): IpCheckResult {
  const version = isIP(ip);
  if (version === 4) {
    return checkIPv4Restricted(ip);
  }
  if (version === 6) {
    return checkIPv6Restricted(ip);
  }
  return { restricted: true, isLoopback: false, reason: `Invalid IP format: '${ip}'` };
}

/**
 * 检查主机名是否为合法的回环地址名称或 IP。
 *
 * @param hostname - URL 中的 hostname（不含端口号，方括号已由 URL 解析器处理）。
 * @returns 若为 localhost、127.0.0.0/8 或 ::1 则返回 true。
 */
export function isLoopbackHost(hostname: string): boolean {
  const clean = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (clean === 'localhost') return true;
  const ipVer = isIP(clean);
  if (ipVer === 4) {
    return checkIPv4Restricted(clean).isLoopback;
  }
  if (ipVer === 6) {
    return checkIPv6Restricted(clean).isLoopback;
  }
  return false;
}

/**
 * URL 端点安全校验选项。
 */
export interface ValidateEndpointOptions {
  /** 是否允许回环地址使用 HTTP 协议，默认 true。 */
  allowLoopbackHttp?: boolean;
}

/**
 * 校验并解析 MCP HTTP 传输端点 URL。
 *
 * 强制安全边界：
 * 1. 严禁包含 username 或 password 凭据；
 * 2. 拒绝除了 https: 与显式回环 http: 之外的任何协议（拒绝旧 SSE 协议）；
 * 3. 若为 http: 协议，仅在 hostname 为回环地址（localhost, 127.0.0.0/8, ::1）时放行；
 * 4. 若 hostname 为直接 IP 地址，若属于私网或受限保留地址且非允许的回环，立即拒绝。
 *
 * @param rawUrl - 待校验的原始 URL 字符串。
 * @param options - 校验选项。
 * @returns 解析成功的 URL 实例，若不合法则返回包含具体原因的错误。
 */
export function validateEndpointUrl(
  rawUrl: string,
  options: ValidateEndpointOptions = {},
): { valid: true; url: URL } | { valid: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (err: unknown) {
    return {
      valid: false,
      error: `Malformed URL '${rawUrl}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 1. 严禁包含 URL 鉴权凭据
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      error: `Security violation: URL embedded username or password credentials are strictly prohibited in '${rawUrl}'`,
    };
  }

  // 2. 协议校验
  const protocol = parsed.protocol.toLowerCase();
  const allowLoopbackHttp = options.allowLoopbackHttp !== false;

  if (protocol === 'sse:' || protocol === 'http+sse:' || protocol === 'https+sse:') {
    return {
      valid: false,
      error: `Legacy SSE transport protocol '${protocol}' is not supported; use Streamable HTTP instead`,
    };
  }

  if (protocol !== 'https:' && protocol !== 'http:') {
    return {
      valid: false,
      error: `Unsupported protocol '${protocol}'; only HTTPS (or HTTP for loopback) is permitted`,
    };
  }

  // 3. HTTP 仅允许回环
  const hostname = parsed.hostname;
  const isLoopback = isLoopbackHost(hostname);

  if (protocol === 'http:') {
    if (!allowLoopbackHttp || !isLoopback) {
      return {
        valid: false,
        error: `Insecure HTTP protocol is strictly prohibited for non-loopback host '${hostname}'; HTTPS is required`,
      };
    }
  }

  // 4. 若为直接 IP 地址，校验是否落入受限私网段
  const cleanHost = hostname.replace(/^\[|\]$/g, '');
  const ipVer = isIP(cleanHost);
  if (ipVer !== 0) {
    const check = checkIpRestricted(cleanHost);
    if (check.restricted && !isLoopback) {
      return {
        valid: false,
        error: `Security violation: Direct connection to private/restricted IP '${cleanHost}' is blocked (${check.reason})`,
      };
    }
  }

  return { valid: true, url: parsed };
}

/**
 * 解析主机名并严格复核所有解析结果 IP（防御 SSRF 与 DNS 绑定内网）。
 *
 * @param hostname - 目标主机名。
 * @param isLoopbackAllowed - 是否允许解析为回环地址。
 * @returns 解析得到的安全 IP 数组。
 * @throws 当解析出受限制私网 IP 或回环 IP 未获授权时抛出安全异常。
 */
export async function resolveAndValidateHostIps(
  hostname: string,
  isLoopbackAllowed = false,
): Promise<string[]> {
  const cleanHost = hostname.replace(/^\[|\]$/g, '');
  if (isIP(cleanHost) !== 0) {
    const check = checkIpRestricted(cleanHost);
    if (check.restricted) {
      if (check.isLoopback && isLoopbackAllowed) {
        return [cleanHost];
      }
      throw new Error(`Target IP '${cleanHost}' is blocked by security gateway (${check.reason})`);
    }
    return [cleanHost];
  }

  let lookupResults: Array<{ address: string; family: number }>;
  try {
    lookupResults = await dnsPromises.lookup(cleanHost, { all: true });
  } catch (err: unknown) {
    throw new Error(
      `DNS resolution failed for host '${cleanHost}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!lookupResults || lookupResults.length === 0) {
    throw new Error(`DNS resolution returned empty address list for host '${cleanHost}'`);
  }

  const safeIps: string[] = [];
  for (const item of lookupResults) {
    const check = checkIpRestricted(item.address);
    if (check.restricted) {
      if (check.isLoopback && isLoopbackAllowed) {
        safeIps.push(item.address);
        continue;
      }
      throw new Error(
        `DNS resolution for host '${cleanHost}' resolved to blocked IP '${item.address}' (${check.reason})`,
      );
    }
    safeIps.push(item.address);
  }

  return safeIps;
}
