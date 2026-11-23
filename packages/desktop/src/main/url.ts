/**
 * URL 字面比较前的规范化。
 *
 * 为什么需要：Node 的 `pathToFileURL()` 会把路径中的 `~` 百分号编码成 `%7E`，
 * 而 Chromium 回读的帧 URL（`senderFrame.url` / `mainFrame.url`）保留字面 `~`。
 * Windows 8.3 短名（如 `RUNNER~1`、`KPBL83~1`）天然带 `~`，于是「主进程构造的期望 URL」
 * 与「渲染进程实际上报的 URL」在同一物理页面上字面不等，`kpbl:ready` 守卫会静默拒绝，
 * 控制端口永不投递，表现为安装副本冷启动挂死（CI Windows 打包 smoke 的稳定失败根因）。
 *
 * 保证什么：只解码 RFC 3986 §2.3 的未保留字符（ALPHA / DIGIT / `-` / `.` / `_` / `~`）
 * 的百分号编码——这类编码与字面字符语义完全等价，解码不改变 URL 身份；
 * 其余百分号编码统一转大写后原样保留。
 *
 * 不做什么：不解码保留字符（如 `%2F`、`%3F`），避免把编码的分隔符还原成路径/查询结构
 * 而放宽同源判定；不解析、不重排、不触碰查询参数语义。调用方必须对比较的两侧同时使用，
 * 单侧规范化会引入新的不一致。
 */
const UNRESERVED = /[A-Za-z0-9\-._~]/;

/** 将 URL 中未保留字符的百分号编码还原为字面字符，其余编码统一大写；仅用于同源字面比较。 */
export function normalizeUrl(url: string): string {
  return url.replace(/%[0-9A-Fa-f]{2}/g, (encoded) => {
    const char = String.fromCharCode(Number.parseInt(encoded.slice(1), 16));
    return UNRESERVED.test(char) ? char : encoded.toUpperCase();
  });
}

/**
 * 剥离 `#fragment` 后执行主框架 URL 规范化。
 *
 * 主页面内的页内锚点（例如 GFM 脚注或 SVG 锚点）即使改变了 URL 片段，物理文档身份并未离开
 * 期望的渲染入口；剥离片段后再做严格字面比较，防止合法的同文档状态令 IPC 守卫永久误拒。
 */
export function normalizeMainFrameUrl(url: string): string {
  const hashIndex = url.indexOf('#');
  return normalizeUrl(hashIndex >= 0 ? url.slice(0, hashIndex) : url);
}
