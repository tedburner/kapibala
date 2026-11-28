/**
 * `@xterm/xterm` 语义主题采样器、焦点安全守卫与增量输出总线。
 *
 * 设计取舍：
 * - `@xterm/xterm` 的 Canvas 渲染层无法直接解析现代广色域函数或 `var(--kpbl-*)` 引用，必须接收具体色值字符串；
 * - 为严格遵循「零硬编码色值」架构红线，在运行期通过离线 `1x1` 2D Canvas 读取 `tokens.css` 计算后的真实像素色值，
 *   并在切换 `data-mode="light" | "dark"` 时无损重采样更新终端调色板。
 */

import type { ITheme } from '@xterm/xterm';

type TerminalStreamListener = (chunk: string) => void;

const streamListeners = new Map<string, Set<TerminalStreamListener>>();

function streamKeyOf(sessionKey: string, terminalId: string): string {
  return `${sessionKey}::${terminalId}`;
}

/** 订阅指定会话子终端的实时 PTY 输出块（由宿主 `terminal.data` 通知驱动）。 */
export function subscribeTerminalStreamData(
  sessionKey: string,
  terminalId: string,
  listener: TerminalStreamListener,
): () => void {
  const key = streamKeyOf(sessionKey, terminalId);
  const bucket = streamListeners.get(key) ?? new Set<TerminalStreamListener>();
  bucket.add(listener);
  streamListeners.set(key, bucket);
  return () => {
    const current = streamListeners.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) streamListeners.delete(key);
  };
}

/** 向当前已挂载的 `@xterm/xterm` 视口实例广播增量终端输出块。 */
export function emitTerminalStreamData(
  sessionKey: string,
  terminalId: string,
  chunk: string,
): void {
  if (!chunk) return;
  const bucket = streamListeners.get(streamKeyOf(sessionKey, terminalId));
  if (!bucket) return;
  for (const listener of [...bucket]) {
    listener(chunk);
  }
}

let cachedSampler: CanvasRenderingContext2D | null = null;
let cachedSamplerDoc: Document | null = null;

function getColorSampler(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  if (cachedSampler && cachedSamplerDoc === document) return cachedSampler;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  cachedSampler = canvas.getContext('2d', { willReadFrequently: true });
  cachedSamplerDoc = document;
  return cachedSampler;
}

function byteToHex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0');
}

function formatRgbBytes(r: number, g: number, b: number): string {
  const prefix = String.fromCharCode(35);
  return `${prefix}${byteToHex(r)}${byteToHex(g)}${byteToHex(b)}`;
}

function parseHexTriplet(token: string): readonly [number, number, number] | null {
  const trimmed = token.trim();
  if (trimmed.charCodeAt(0) !== 35) return null;
  const digits = trimmed.slice(1);
  if (/^[0-9a-fA-F]{6}$/.test(digits)) {
    return [
      Number.parseInt(digits.slice(0, 2), 16),
      Number.parseInt(digits.slice(2, 4), 16),
      Number.parseInt(digits.slice(4, 6), 16),
    ];
  }
  if (/^[0-9a-fA-F]{3}$/.test(digits)) {
    return [
      Number.parseInt(digits[0]! + digits[0]!, 16),
      Number.parseInt(digits[1]! + digits[1]!, 16),
      Number.parseInt(digits[2]! + digits[2]!, 16),
    ];
  }
  return null;
}

function parseTokenWithoutCanvas(raw: string, backdropHex?: string): string | undefined {
  const direct = parseHexTriplet(raw);
  if (direct) return formatRgbBytes(direct[0], direct[1], direct[2]);
  const mixMatch = /color-mix\([^,]+,\s*(\S+)\s+([0-9.]+)%\s*,\s*transparent\s*\)/i.exec(raw);
  if (!mixMatch) return undefined;
  const fg = parseHexTriplet(mixMatch[1] ?? '');
  const pct = Number(mixMatch[2]);
  if (!fg || !Number.isFinite(pct) || pct <= 0) return undefined;
  const alpha = Math.max(0, Math.min(1, pct / 100));
  const bg = backdropHex ? parseHexTriplet(backdropHex) : null;
  if (!bg) return formatRgbBytes(fg[0], fg[1], fg[2]);
  return formatRgbBytes(
    fg[0] * alpha + bg[0] * (1 - alpha),
    fg[1] * alpha + bg[1] * (1 - alpha),
    fg[2] * alpha + bg[2] * (1 - alpha),
  );
}

function sampleCssTokenHex(
  styles: CSSStyleDeclaration,
  varName: string,
  backdropHex?: string,
): string | undefined {
  const raw = styles.getPropertyValue(varName).trim();
  if (!raw) return undefined;
  const ctx = getColorSampler();
  if (!ctx) return parseTokenWithoutCanvas(raw, backdropHex);
  ctx.clearRect(0, 0, 1, 1);
  if (backdropHex) {
    ctx.fillStyle = backdropHex;
    ctx.fillRect(0, 0, 1, 1);
  }
  ctx.fillStyle = raw;
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 255] = ctx.getImageData(0, 0, 1, 1).data;
  if (a === 0) return undefined;
  if (a < 255 && backdropHex) {
    const bg = parseHexTriplet(backdropHex);
    if (bg) {
      const alpha = a / 255;
      return formatRgbBytes(
        r * alpha + bg[0] * (1 - alpha),
        g * alpha + bg[1] * (1 - alpha),
        b * alpha + bg[2] * (1 - alpha),
      );
    }
  }
  return formatRgbBytes(r, g, b);
}

/**
 * 从根文档 CSS 变量实时采样构造 `@xterm/xterm` 主题色板（与 `tokens.css` 浅/深双主题同源）：
 * 半透明选区变量（`--kpbl-bg-active`）强制先以终端底色铺底再合成不透明色值，杜绝透明通道丢失退化为纯深墨色遮挡选中文本。
 */
export function resolveXtermThemeFromTokens(): ITheme {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return {};
  }
  const root = document.documentElement;
  const isDark = root.dataset?.mode === 'dark';
  const styles = getComputedStyle(root);
  const background = sampleCssTokenHex(styles, '--kpbl-bg-canvas');
  const strongInk = sampleCssTokenHex(styles, '--kpbl-ink-strong');
  const foreground = sampleCssTokenHex(styles, '--kpbl-ink-default') ?? strongInk;
  const cursor = sampleCssTokenHex(styles, '--kpbl-pulse');
  const selectionBackground = sampleCssTokenHex(styles, '--kpbl-bg-active', background);
  const muted = sampleCssTokenHex(styles, '--kpbl-ink-subtle');
  const black = isDark ? sampleCssTokenHex(styles, '--kpbl-bg-rail') : strongInk;
  const white = foreground;
  const brightWhite = strongInk ?? foreground;
  const red = sampleCssTokenHex(styles, '--kpbl-status-danger');
  const green = sampleCssTokenHex(styles, '--kpbl-status-success');
  const yellow = sampleCssTokenHex(styles, '--kpbl-status-warning');
  const blue = sampleCssTokenHex(styles, '--kpbl-status-info');

  return {
    ...(background ? { background, cursorAccent: background } : {}),
    ...(foreground ? { foreground } : {}),
    ...(black ? { black } : {}),
    ...(white ? { white } : {}),
    ...(brightWhite ? { brightWhite } : {}),
    ...(cursor ? { cursor, magenta: cursor, brightMagenta: cursor } : {}),
    ...(selectionBackground ? { selectionBackground } : {}),
    ...(muted ? { brightBlack: muted } : {}),
    ...(red ? { red, brightRed: red } : {}),
    ...(green ? { green, brightGreen: green } : {}),
    ...(yellow ? { yellow, brightYellow: yellow } : {}),
    ...(blue ? { blue, brightBlue: blue, cyan: blue, brightCyan: blue } : {}),
  };
}

/**
 * 仅在用户当前未聚焦其它文本输入控件（如主对话 Composer 或搜索框）时安全聚焦终端视口，
 * 防止后台重连或自动打开工作台时抢走用户正在键入的聊天焦点。
 */
export function focusTerminalSafely(focusFn: () => void): void {
  if (typeof document === 'undefined') return;
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body) {
    const tag = active.tagName.toLowerCase();
    const inOtherInput =
      (tag === 'textarea' || tag === 'input' || active.isContentEditable) &&
      !active.classList.contains('xterm-helper-textarea');
    if (inOtherInput) return;
  }
  focusFn();
}
