/**
 * 工作台 `Preview` 标签页 URL 输入框的安全准入分类器（0 Node 依赖，主进程与渲染层共用同一规则）。
 *
 * 设计取舍与安全边界（设计 018 §6.1 / 决策 4）：
 * - 内嵌 iframe 仅放行本机回环开发端口（`http://localhost:<port>`、`http://127.0.0.1:<port>`、`http://[::1]:<port>`），
 *   与 `008` `port_ready` 监视通知无缝闭环；必须显式携带合法开发端口（1–65535）且不含账号密码（`user:pass@`）；
 * - 公网 `https://`（非私网/非回环/非元数据地址）返回 `'open_external'`，由界面引导通过系统浏览器打开，
 *   避免 `X-Frame-Options: DENY` 白屏及在应用窗口内加载任意公网脚本；
 * - `file:`、`javascript:`、`data:`、`blob:`、`kpbl-preview:`、RFC1918 局域网段、链路本地与云元数据 IP（`169.254.169.254`）
 *   一律返回 `'blocked'` 拒绝加载。
 */

/** URL 预览裁决结果：内嵌回环开发服务、引导外部浏览器打开、或硬拦截。 */
export type PreviewUrlDecision =
  | { readonly kind: 'embed_loopback'; readonly normalizedUrl: string; readonly port: number }
  | { readonly kind: 'open_external'; readonly normalizedUrl: string; readonly reason: string }
  | { readonly kind: 'blocked'; readonly reason: string };

/** Chromium / Fetch 标准禁止访问的高危传统服务端口子集（防本地跨协议 SSRF 探测）。 */
const RESTRICTED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080,
]);

/** 判断剥离尾随点号后的主机名是否为本机回环地址（`localhost`、`127.0.0.1`、`[::1]`）。 */
function isLoopbackHost(hostname: string): boolean {
  const clean = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  return clean === 'localhost' || clean === '127.0.0.1' || clean === '::1';
}

/**
 * 在 WHATWG `new URL()` 将缩写 IPv4（`127.1`、`127.0.1`）或八进制/十六进制分段（`127.0.0.01`、`127.0.0.0x1`）
 * 规范化为四段十进制前，直接检查原始 authority 主机段是否存在混淆写法。
 *
 * 规则：若点分标签全部由十进制数字或 `0x` 十六进制字面量组成，则必须严格为 4 段无前导零的十进制 `0..255` 整数。
 */
function hasObfuscatedNumericAuthorityHost(rawUrl: string): boolean {
  const authorityMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:[\\/]{2}([^\\/?#]+)/.exec(rawUrl);
  if (!authorityMatch?.[1]) return false;
  const authority = authorityMatch[1];
  const atIdx = authority.lastIndexOf('@');
  const hostPort = atIdx >= 0 ? authority.slice(atIdx + 1) : authority;
  if (hostPort.startsWith('[')) return false;
  const colonIdx = hostPort.indexOf(':');
  const rawHost = (colonIdx >= 0 ? hostPort.slice(0, colonIdx) : hostPort).replace(/\.+$/, '');
  if (!rawHost) return false;
  const labels = rawHost.split('.');
  const allNumericOrHex = labels.every((label) => /^(?:0x[0-9a-f]+|\d+)$/i.test(label));
  if (!allNumericOrHex) return false;
  if (labels.length !== 4) return true;
  for (const label of labels) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(label)) return true;
    const value = Number(label);
    if (!Number.isInteger(value) || value < 0 || value > 255) return true;
  }
  return false;
}

/** 判断目标端口是否与宿主渲染进程自身的本地回环源端口冲突（防开发态递归自嵌套与特权桥暴露）。 */
function matchesHostLoopbackPort(port: number, hostOrigin: string | undefined): boolean {
  if (!hostOrigin) return false;
  try {
    const hostUrl = new URL(hostOrigin);
    const hostProto = hostUrl.protocol.toLowerCase();
    const cleanHostOrigin = hostUrl.hostname.toLowerCase().replace(/\.+$/, '');
    if (
      (hostProto === 'http:' ||
        hostProto === 'https:' ||
        hostProto === 'ws:' ||
        hostProto === 'wss:') &&
      isLoopbackHost(cleanHostOrigin)
    ) {
      const hostPort = hostUrl.port
        ? Number(hostUrl.port)
        : hostProto === 'https:' || hostProto === 'wss:'
          ? 443
          : 80;
      return hostPort === port;
    }
  } catch {
    // 自定义协议或 file:// 形态无需回环端口自嵌比对。
  }
  return false;
}

/**
 * 判断主机名是否命中私网、未指定地址、链路本地、NAT64 或云元数据保留段。
 * 覆盖十进制 IPv4、其他 `127.x.x.x` 变体、`0.0.0.0`、RFC1918、CGNAT、169.254/16 及 IPv6 保留前缀。
 */
function isPrivateOrReservedHost(hostname: string): boolean {
  const lower = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  if (!lower) return true;
  if (
    lower === '0.0.0.0' ||
    lower === '::' ||
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal')
  ) {
    return true;
  }

  // 非标准整数/八进制/十六进制 IPv4 写法（如 2130706433 或 0x7f000001）一律按保留地址拦截
  if (/^(?:0x[0-9a-f]+|\d+)$/i.test(lower)) {
    return true;
  }

  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map((part) => Number(part));
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (lower.includes(':')) {
    if (
      lower === '::1' ||
      /^fe[89ab][0-9a-f]:/i.test(lower) ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('ff') ||
      lower.startsWith('::ffff:') ||
      lower.startsWith('64:ff9b:') ||
      lower.startsWith('2001:db8:') ||
      lower.startsWith('2002:') ||
      /^::(?:\d+\.\d+\.\d+\.\d+|[0-9a-f]{1,4}(?::[0-9a-f]{1,4})?)$/i.test(lower)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 校验并分类工作台用户输入的预览 URL。
 *
 * 支持便捷输入：对裸 `localhost:3000` 或 `:3000` 自动补全为 `http://localhost:3000/` 后再做严格白名单裁决；
 * 当传入 `options.hostOrigin`（如开发态渲染进程自身 `http://127.0.0.1:5173`）时，拒绝同端口自嵌套防递归挂载与同源桥暴露。
 */
export function classifyPreviewUrl(
  rawInput: string,
  options?: { readonly hostOrigin?: string },
): PreviewUrlDecision {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { kind: 'blocked', reason: '请输入本地开发端口地址（如 http://localhost:3000）' };
  }

  let candidate = trimmed;
  if (/^:\d{1,5}(?:\/.*)?$/.test(candidate)) {
    candidate = `http://localhost${candidate}`;
  } else if (/^(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5}(?:\/.*)?$/i.test(candidate)) {
    candidate = `http://${candidate}`;
  }

  // 在 WHATWG URL 自动将缩写/整数/八进制/十六进制主机名归一为四段十进制前先行拦截混淆写法
  if (hasObfuscatedNumericAuthorityHost(candidate)) {
    return { kind: 'blocked', reason: '安全策略禁止使用非标准数值或八进制/十六进制混淆主机名' };
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { kind: 'blocked', reason: 'URL 格式无效，请输入完整的 http://localhost:<端口> 地址' };
  }

  if (parsed.username || parsed.password) {
    return { kind: 'blocked', reason: '预览地址不允许包含内嵌认证凭据' };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return {
      kind: 'blocked',
      reason: `安全策略禁止在工作台预览 ${protocol.replace(/:$/, '')} 协议地址`,
    };
  }

  const cleanHost = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (!cleanHost) {
    return { kind: 'blocked', reason: 'URL 主机名无效' };
  }

  if (isLoopbackHost(cleanHost)) {
    if (protocol !== 'http:') {
      return {
        kind: 'blocked',
        reason:
          '本地内嵌预览仅支持 HTTP 开发服务（如 http://localhost:5173），HTTPS 本地端口请在系统浏览器中打开',
      };
    }
    if (parsed.hostname.endsWith('.')) {
      return {
        kind: 'blocked',
        reason: '安全策略禁止使用带尾随点号的回环主机名',
      };
    }
    if (!parsed.port) {
      return {
        kind: 'blocked',
        reason: '本机回环预览需显式指定开发服务端口号（如 http://localhost:5173）',
      };
    }
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || RESTRICTED_PORTS.has(port)) {
      return { kind: 'blocked', reason: `端口 ${parsed.port} 不在受允许的开发预览范围内` };
    }
    if (matchesHostLoopbackPort(port, options?.hostOrigin)) {
      return {
        kind: 'blocked',
        reason: '安全策略禁止在工作台内嵌当前桌面渲染进程自身的开发服务端口',
      };
    }
    return {
      kind: 'embed_loopback',
      normalizedUrl: parsed.toString(),
      port,
    };
  }

  if (isPrivateOrReservedHost(cleanHost)) {
    return {
      kind: 'blocked',
      reason: '安全策略禁止预览局域网私网段或保留元数据地址',
    };
  }

  if (protocol === 'http:') {
    return {
      kind: 'blocked',
      reason: '非本机地址不支持明文 HTTP 内嵌预览，请使用 HTTPS 在系统浏览器中打开',
    };
  }

  return {
    kind: 'open_external',
    normalizedUrl: parsed.toString(),
    reason: '公网页面为保护会话安全不在工作台内嵌渲染，可直接在系统浏览器中打开',
  };
}

/**
 * 判断主进程 `webRequest` 与 `will-frame-navigate` 拦截器中的子帧（iframe）请求是否属于受允许的本机回环开发服务请求。
 * 仅放行 `http:` 与 `ws:` 协议下的 `localhost` / `127.0.0.1` / `[::1]` 显式安全开发端口，
 * 拒绝认证凭据、混淆主机名、尾随点号以及与宿主自身 `hostOrigin` 同端口的回环请求（防子帧重定向至开发渲染服务暴露特权桥）。
 */
export function isAllowedLoopbackSubframeUrl(
  rawUrl: string,
  options?: { readonly hostOrigin?: string },
): boolean {
  if (hasObfuscatedNumericAuthorityHost(rawUrl)) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'ws:') return false;
  if (parsed.hostname.endsWith('.')) return false;
  const cleanHost = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (!isLoopbackHost(cleanHost) || !parsed.port) return false;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || RESTRICTED_PORTS.has(port)) {
    return false;
  }
  if (matchesHostLoopbackPort(port, options?.hostOrigin)) {
    return false;
  }
  return true;
}
