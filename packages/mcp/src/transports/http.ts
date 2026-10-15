/**
 * @fileoverview MCP Streamable HTTP 客户端传输封装与安全网关集成
 *
 * 约束与边界：
 * 1. 严格使用官方 StreamableHTTPClientTransport，拒绝旧 SSE 协议与旧传输；
 * 2. 严格安全网关：强制 HTTPS（仅 localhost / 127.0.0.0/8 / ::1/128 允许显式 HTTP）；
 * 3. 拒绝 URL 携带 username/password 用户凭据；
 * 4. 全量私网与保留网段拦截（SSRF 防御），结合 DNS 解析预检与底层 Socket Remote IP 二次复核（防御 DNS Rebinding）；
 * 5. 重定向隔离：遇到跨 Origin 重定向时，强制剥离所有鉴权 Header（如 Authorization），严禁跨域泄露凭据，且严禁协议降级（HTTPS -> HTTP）；
 * 6. 业务调用 tools/call 至多发送一次，绝对禁止隐式重试。
 */

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { TransformStream } from 'node:stream/web';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { HttpServerConfig } from '../config.js';
import {
  checkIpRestricted,
  isLoopbackHost,
  resolveAndValidateHostIps,
  validateEndpointUrl,
} from './ip-security.js';

/**
 * 跨 Origin 重定向时必须强制剥离的敏感鉴权头名称集合（小写）。
 */
const SENSITIVE_AUTH_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
]);

import { resolveHttpHeaders } from '../env.js';

/**
 * 受管 Streamable HTTP 传输句柄接口。
 */
export interface ManagedHttpTransport {
  /** 官方 SDK 底层 StreamableHTTPClientTransport 实例。 */
  readonly transport: StreamableHTTPClientTransport;
  /** 经过校验与规范化的目标端点 URL。 */
  readonly url: URL;
  /**
   * 优雅关闭 HTTP 传输连接并清理会话。
   *
   * 保证幂等执行，重复调用安全。
   */
  close(): Promise<void>;
  /** 传输是否已被显式关闭。 */
  readonly isClosed: boolean;
}

/**
 * 创建受管 HTTP 传输配置选项。
 */
export interface CreateHttpTransportOptions {
  /** 是否允许回环地址使用 HTTP，默认 true。 */
  allowLoopbackHttp?: boolean;
  /** 最大允许的 HTTP 重定向跟随次数，默认 5。 */
  maxRedirects?: number;
  /** 底层请求超时时间（毫秒），未指定时遵循配置。 */
  requestTimeoutMs?: number;
  /** 配置来源（'global' | 'project'）。 */
  source?: 'global' | 'project';
}

/**
 * 创建具备 SSRF 防御、DNS Rebinding 拦截与鉴权隔离的受控 fetch 函数。
 *
 * @param options - 安全与重定向配置。
 * @returns 兼容标准 Fetch API 的异步请求函数。
 */
export function createSecureMcpFetch(
  options: CreateHttpTransportOptions = {},
): (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response> {
  const allowLoopbackHttp = options.allowLoopbackHttp !== false;
  const maxRedirects = options.maxRedirects ?? 5;

  return async function secureFetch(
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> {
    let currentUrlString =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    let redirectCount = 0;
    const initialOrigin = new URL(currentUrlString).origin;

    // 复制请求头对象以支持重定向时剥离鉴权头
    const currentHeaders: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          currentHeaders[key.toLowerCase()] = value;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) {
          currentHeaders[k.toLowerCase()] = v;
        }
      } else {
        for (const [k, v] of Object.entries(init.headers)) {
          currentHeaders[k.toLowerCase()] = String(v);
        }
      }
    }

    while (true) {
      // 1. URL 静态安全性校验
      const validation = validateEndpointUrl(currentUrlString, { allowLoopbackHttp });
      if (!validation.valid) {
        throw new Error(`MCP HTTP transport blocked request: ${validation.error}`);
      }
      const targetUrl = validation.url;

      // 2. DNS 预检解析与私网 IP 校验
      const isLoopback = isLoopbackHost(targetUrl.hostname);
      await resolveAndValidateHostIps(targetUrl.hostname, isLoopback && allowLoopbackHttp);

      // 3. 跨 Origin 重定向鉴权头剥离检测
      if (targetUrl.origin !== initialOrigin) {
        for (const authHeader of SENSITIVE_AUTH_HEADERS) {
          delete currentHeaders[authHeader];
        }
      }

      // 4. 执行单次带底层 Socket Remote IP 复核的网络请求
      const response = await executeSecureHttpRequest(
        targetUrl,
        currentHeaders,
        init,
        isLoopback && allowLoopbackHttp,
      );

      // 5. 处理重定向（301, 302, 303, 307, 308）
      const statusCode = response.status;
      const isRedirect = [301, 302, 303, 307, 308].includes(statusCode);

      if (isRedirect) {
        const location = response.headers.get('location');
        if (!location) {
          return response;
        }

        redirectCount++;
        if (redirectCount > maxRedirects) {
          throw new Error(`MCP HTTP request exceeded maximum redirect limit (${maxRedirects})`);
        }

        const nextUrl = new URL(location, targetUrl);

        // 严禁 HTTPS 降级为 HTTP
        if (targetUrl.protocol === 'https:' && nextUrl.protocol === 'http:') {
          throw new Error(
            `MCP HTTP transport blocked insecure protocol downgrade from HTTPS to HTTP during redirect to '${nextUrl.toString()}'`,
          );
        }

        currentUrlString = nextUrl.toString();
        continue;
      }

      return response;
    }
  };
}

/** 4 MiB 单次 Wire 传输负载硬上限 */
const MAX_WIRE_BYTES = 4 * 1024 * 1024;

/**
 * 执行底层 Node.js HTTP/HTTPS 请求，并在 Socket 握手建立后复核 Remote IP 以防御 DNS Rebinding。
 */
function executeSecureHttpRequest(
  targetUrl: URL,
  headers: Record<string, string>,
  init: RequestInit | undefined,
  isLoopbackAllowed: boolean,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const isHttps = targetUrl.protocol === 'https:';
    const requestModule = isHttps ? https : http;

    const requestOptions: http.RequestOptions = {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port ? Number(targetUrl.port) : isHttps ? 443 : 80,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: init?.method ?? 'GET',
      headers,
      signal: init?.signal ?? undefined,
      lookup: (hostname, options, callback) => {
        dns.lookup(hostname, options, (err, address, family) => {
          if (err) {
            callback(err, address, family);
            return;
          }
          const addrStr = Array.isArray(address) ? address[0]?.address : address;
          const check = checkIpRestricted(addrStr);
          if (check.restricted && !(check.isLoopback && isLoopbackAllowed)) {
            callback(
              new Error(
                `DNS Rebinding violation: Resolved IP '${addrStr}' is restricted (${check.reason})`,
              ),
              address as any,
              family,
            );
            return;
          }
          callback(null, address as any, family);
        });
      },
    };

    let dataFlushed = false;
    const flushData = () => {
      if (dataFlushed) return;
      dataFlushed = true;
      if (init?.body) {
        if (typeof init.body === 'string') {
          req.write(init.body);
        } else if (Buffer.isBuffer(init.body)) {
          req.write(init.body);
        } else if (init.body instanceof Uint8Array) {
          req.write(Buffer.from(init.body));
        } else {
          req.write(String(init.body));
        }
      }
      req.end();
    };

    const req = requestModule.request(requestOptions, (res) => {
      try {
        const statusCode = res.statusCode ?? 200;
        // Web 标准：204 (No Content), 205 (Reset Content), 304 (Not Modified) 禁止提供 body，必须为 null
        const hasNoBody = statusCode === 204 || statusCode === 205 || statusCode === 304;
        let webStream: ReadableStream<Uint8Array> | null = null;
        if (!hasNoBody) {
          const rawStream = Readable.toWeb(res) as ReadableStream<Uint8Array>;
          let receivedBytes = 0;
          const countingStream = new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              receivedBytes += chunk.byteLength;
              if (receivedBytes > MAX_WIRE_BYTES) {
                const err = new Error(
                  `MCP HTTP wire limit exceeded: response payload exceeded ${MAX_WIRE_BYTES} bytes (MCP_RESULT_TOO_LARGE)`,
                );
                (err as any).code = 'MCP_RESULT_TOO_LARGE';
                res.destroy(err);
                controller.error(err);
                return;
              }
              controller.enqueue(chunk);
            },
          });
          webStream = rawStream.pipeThrough(countingStream);
        }

        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v !== undefined) {
            if (Array.isArray(v)) {
              for (const item of v) responseHeaders.append(k, item);
            } else {
              responseHeaders.set(k, v);
            }
          }
        }

        const response = new Response(webStream, {
          status: statusCode,
          statusText: res.statusMessage ?? '',
          headers: responseHeaders,
        });

        resolve(response);
      } catch (err) {
        reject(err);
      }
    });

    // 监听底层 Socket 建立，二次复核真实远端 IP（防御 DNS Rebinding）
    req.on('socket', (socket: Socket) => {
      const verifySocketAddress = () => {
        const remoteAddress = socket.remoteAddress;
        if (!remoteAddress) return;
        const check = checkIpRestricted(remoteAddress);
        if (check.restricted) {
          if (check.isLoopback && isLoopbackAllowed) {
            flushData();
            return;
          }
          const violationErr = new Error(
            `DNS Rebinding violation: Underlying socket connected to restricted IP '${remoteAddress}' (${check.reason})`,
          );
          socket.destroy(violationErr);
          req.destroy(violationErr);
          reject(violationErr);
          return;
        }
        flushData();
      };

      if (socket.connecting) {
        socket.once('connect', verifySocketAddress);
      } else {
        verifySocketAddress();
      }
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * 根据 HttpServerConfig 创建并初始化受管 Streamable HTTP 传输实例。
 *
 * @param config - 已校验的 HTTP 服务配置。
 * @param options - 传输构建与安全选项。
 * @returns 受管 HTTP 传输句柄。
 * @throws 当配置 URL 非法或命中私网/协议限制时抛出异常。
 */
export function createManagedHttpTransport(
  config: HttpServerConfig,
  options: CreateHttpTransportOptions = {},
): ManagedHttpTransport {
  // 1. 静态端点校验
  const validation = validateEndpointUrl(config.url, {
    allowLoopbackHttp: options.allowLoopbackHttp,
  });
  if (!validation.valid) {
    throw new Error(`Failed to create MCP HTTP transport: ${validation.error}`);
  }
  const url = validation.url;

  // 2. 构造安全带网关隔离的 fetch 函数
  const secureFetch = createSecureMcpFetch(options);

  // 3. 构建默认请求头（解析展开环境变量凭据并校验缺失变量）
  const resolved = resolveHttpHeaders(config.headers, options.source ?? 'global');
  if (resolved.error) {
    throw new Error(`Failed to create MCP HTTP transport: ${resolved.error}`);
  }
  const requestInitHeaders: Record<string, string> = resolved.headers ?? {};

  // 4. 实例化官方 StreamableHTTPClientTransport
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: secureFetch,
    requestInit: {
      headers: requestInitHeaders,
    },
  });

  let isClosed = false;

  return {
    transport,
    url,
    get isClosed() {
      return isClosed;
    },
    async close() {
      if (isClosed) return;
      isClosed = true;
      try {
        await transport.close();
      } catch {
        // 忽略关闭期间的网络异常
      }
    },
  };
}
