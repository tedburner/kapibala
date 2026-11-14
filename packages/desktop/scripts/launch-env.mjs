/**
 * Electron 启动环境的唯一构造入口：只透传白名单变量。
 *
 * 存在的理由：宿主（IDE、沙箱、CI 包装器）惯于用 `NODE_OPTIONS=--require=<vendor shim>`
 * 或 `ELECTRON_RUN_AS_NODE=1` 注入运行时钩子。后者直接让 GUI 二进制退化成纯 Node，
 * 应用启动瞬间就报 `SyntaxError: The requested module 'electron' does not provide an export
 * named 'BrowserWindow'`；前者把宿主的原生模块塞进主进程，表现为沙箱初始化失败、
 * GPU 进程反复崩溃直至 SIGTRAP。两者都与应用代码无关，排查成本极高。
 *
 * 所以这条边界不能靠"记得在命令前加 env -u"来维持，而是用**白名单**收口：
 * 不枚举黑名单，宿主未来新增任何注入变量都会自动被挡在外面。
 *
 * 注意：Node 工具链（pnpm / tsup / vite）不能用白名单，那边走 `scripts/process-env.mjs`
 * 的 `toolchainEnv`（过滤而非白名单）。
 */

/**
 * 启动 Electron 应用时需要透传的变量名。
 *
 * 只登记 Electron / Chromium / Node 自身必需项与用户主动配置的网络证书项：
 * - `HOME` / `USERPROFILE`：工具链里的 git 等子进程依赖；缺省时 Node 会回退到 getpwuid，
 *   结果相同但显式透传更可预期，且不改变 e2e 隔离语义（隔离靠 KPBL_DESKTOP_* 钉死）。
 * - 代理与自签证书：属于用户意图，公司网关场景缺了会直接连不上。
 *
 * 刻意不包含 `NODE_OPTIONS`、`ELECTRON_RUN_AS_NODE`、`ELECTRON_NO_ATTACH_CONSOLE`
 * 以及任何宿主私有前缀 —— 新增项必须在此显式登记，`pnpm check-desktop` 会校验清单内容。
 */
export const DESKTOP_ENV_KEYS = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'WINDIR',
  'DISPLAY',
  'XAUTHORITY',
  'LANG',
  'LC_ALL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];

/**
 * 构造 Electron 应用的启动环境。
 *
 * @param base 宿主环境（通常就是 `process.env`），只从中挑白名单内的变量，空值跳过。
 * @param extra 应用需要的显式变量（`KPBL_DESKTOP_*`、`ELECTRON_RENDERER_URL` 等），优先级最高。
 * @returns 可直接传给 spawn / Playwright `electron.launch` 的环境对象。
 *
 * 反例：不要退回 `{ ...process.env, ...extra }`。那会把宿主注入的预加载钩子带进主进程，
 * 症状是窗口根本不出现、日志里只有与业务无关的模块加载错误，`pnpm check-desktop` 会拦截。
 */
export function desktopLaunchEnv(
  base = process.env,
  extra = /** @type {Record<string, string>} */ ({}),
) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const key of DESKTOP_ENV_KEYS) {
    const value = base[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}
