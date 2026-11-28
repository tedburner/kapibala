import { useEffect, useRef } from 'react';
import { clampTerminalFontSize } from '../../../shared/i18n/index.js';
import { classifyPreviewUrl } from '../../../shared/preview-url.js';
import type { TerminalViewportRenderProps } from './TerminalTab.js';
import {
  focusTerminalSafely,
  resolveXtermThemeFromTokens,
  subscribeTerminalStreamData,
} from './xterm-theme.js';

function readRootMonoFont(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--kpbl-font-mono').trim() ||
    'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  );
}

function readRootTerminalFontSize(): number {
  return clampTerminalFontSize(Number(document.documentElement.dataset.terminalFontSize || '13'));
}

/**
 * `@xterm/xterm` 按需懒加载视口组件（018 §6.2）：
 * - 通过动态 `import('@xterm/xterm')` 将终端引擎拆分为独立异步 chunk，保障新会话首页启动零额外解析开销；
 * - 首次挂载时一次性写入宿主 `replayBuffer` 水合历史输出，随后无缝衔接 `subscribeTerminalStreamData` 增量帧；
 * - 监听容器 `ResizeObserver` 与根元素主题/字号/等宽字体属性变更，自动执行 `fitAddon.fit()` 与语义色板同步。
 */
export function XtermViewport({
  sessionKey,
  terminal,
  active,
  onWriteInput,
  onResize,
}: TerminalViewportRenderProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const callbacksRef = useRef({ onWriteInput, onResize, status: terminal.status });
  callbacksRef.current = { onWriteInput, onResize, status: terminal.status };

  const fitTriggerRef = useRef<(() => void) | null>(null);
  const focusTriggerRef = useRef<(() => void) | null>(null);
  const clearTriggerRef = useRef<(() => void) | null>(null);
  const resetTriggerRef = useRef<((replay: string) => void) | null>(null);
  const lastReplayLengthRef = useRef<number>(terminal.replayBuffer?.length ?? 0);
  const latestReplayRef = useRef<string>(terminal.replayBuffer ?? '');
  latestReplayRef.current = terminal.replayBuffer ?? '';
  const prevStatusRef = useRef(terminal.status);
  const generation = terminal.generation ?? 0;

  useEffect(() => {
    const hostEl = containerRef.current;
    if (!hostEl || typeof window === 'undefined') return undefined;

    let cancelled = false;
    let cleanupInstance: (() => void) | undefined;
    const baseReplay = latestReplayRef.current;
    if (generation > 0) lastReplayLengthRef.current = baseReplay.length;
    const pendingChunks: string[] = [];
    let liveWriter: ((chunk: string) => void) | null = null;

    // 在异步加载 @xterm/xterm chunk 前同步挂上增量订阅，确保首屏 Shell 提示符零丢失且不与快照重复。
    const unsubscribeStream = subscribeTerminalStreamData(sessionKey, terminal.id, (chunk) => {
      if (cancelled || !chunk) return;
      if (liveWriter) {
        liveWriter(chunk);
      } else {
        pendingChunks.push(chunk);
      }
    });

    void Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-web-links'),
      import('@xterm/xterm/css/xterm.css'),
    ])
      .then(([xtermMod, fitMod, linksMod]) => {
        if (cancelled || !containerRef.current) return;

        const xterm = new xtermMod.Terminal({
          cursorBlink: true,
          fontSize: readRootTerminalFontSize(),
          lineHeight: 1.35,
          fontFamily: readRootMonoFont(),
          scrollback: 5_000,
          convertEol: false,
          allowProposedApi: false,
          theme: resolveXtermThemeFromTokens(),
        });

        const fitAddon = new fitMod.FitAddon();
        const webLinksAddon = new linksMod.WebLinksAddon((_event, uri) => {
          const decision = classifyPreviewUrl(uri);
          if (decision.kind === 'open_external' || decision.kind === 'embed_loopback') {
            void window.kapibala?.app?.openExternal(decision.normalizedUrl);
          }
        });

        xterm.loadAddon(fitAddon);
        xterm.loadAddon(webLinksAddon);
        xterm.open(hostEl);

        if (baseReplay) {
          xterm.write(baseReplay);
        }
        for (const chunk of pendingChunks.splice(0)) {
          xterm.write(chunk);
        }
        liveWriter = (chunk) => xterm.write(chunk);

        const runFitAndSync = () => {
          if (cancelled || hostEl.clientWidth <= 0 || hostEl.clientHeight <= 0) return;
          try {
            fitAddon.fit();
            if (xterm.cols >= 2 && xterm.rows >= 1) {
              callbacksRef.current.onResize(xterm.cols, xterm.rows);
            }
          } catch {
            // 容器隐藏态或尚未完成首次布局时忽略测量异常。
          }
        };

        fitTriggerRef.current = runFitAndSync;
        focusTriggerRef.current = () => focusTerminalSafely(() => xterm.focus());
        clearTriggerRef.current = () => xterm.clear();
        resetTriggerRef.current = (replay) => {
          xterm.reset();
          if (replay) xterm.write(replay);
          runFitAndSync();
        };

        const dataSub = xterm.onData((input) => {
          if (callbacksRef.current.status === 'exited') return;
          callbacksRef.current.onWriteInput(input);
        });

        let rafId: number | undefined;
        const resizeObserver =
          typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(() => {
                if (rafId !== undefined) window.cancelAnimationFrame(rafId);
                rafId = window.requestAnimationFrame(() => {
                  rafId = undefined;
                  runFitAndSync();
                });
              })
            : undefined;
        resizeObserver?.observe(hostEl);

        const themeObserver =
          typeof MutationObserver !== 'undefined'
            ? new MutationObserver(() => {
                xterm.options.theme = resolveXtermThemeFromTokens();
                xterm.options.fontSize = readRootTerminalFontSize();
                xterm.options.fontFamily = readRootMonoFont();
                runFitAndSync();
              })
            : undefined;
        themeObserver?.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-mode', 'data-terminal-font-size', 'data-mono-font'],
        });

        runFitAndSync();

        cleanupInstance = () => {
          if (rafId !== undefined) window.cancelAnimationFrame(rafId);
          fitTriggerRef.current = null;
          focusTriggerRef.current = null;
          clearTriggerRef.current = null;
          resetTriggerRef.current = null;
          liveWriter = null;
          resizeObserver?.disconnect();
          themeObserver?.disconnect();
          dataSub.dispose();
          xterm.dispose();
        };
      })
      .catch(() => {
        // 动态块加载异常时保持安静降级，不抛出未处理 Promise 拒绝。
      });

    return () => {
      cancelled = true;
      unsubscribeStream();
      cleanupInstance?.();
    };
  }, [sessionKey, terminal.id, generation]);

  useEffect(() => {
    const wasExited = prevStatusRef.current === 'exited';
    prevStatusRef.current = terminal.status;
    if (wasExited && (terminal.status === 'running' || terminal.status === 'starting')) {
      resetTriggerRef.current?.(terminal.replayBuffer ?? '');
    }
  }, [terminal.replayBuffer, terminal.status]);

  useEffect(() => {
    const nextLen = terminal.replayBuffer?.length ?? 0;
    if (lastReplayLengthRef.current > 0 && nextLen === 0) {
      clearTriggerRef.current?.();
    }
    lastReplayLengthRef.current = nextLen;
  }, [terminal.replayBuffer]);

  useEffect(() => {
    if (!active) return undefined;
    fitTriggerRef.current?.();
    focusTriggerRef.current?.();
    if (typeof window === 'undefined') return undefined;
    const raf = window.requestAnimationFrame(() => {
      fitTriggerRef.current?.();
      focusTriggerRef.current?.();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [active]);

  return (
    <div
      ref={containerRef}
      data-xterm-viewport={terminal.id}
      className="kpbl-terminal-xterm-host"
    />
  );
}
