import * as React from 'react';
import { type FunctionComponent, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * `tsconfig.node.json` 不启用 `--jsx`，按 `ui-primitives.test.ts` 同源约定通过动态路径加载 `.tsx` 组件，
 * 渲染层严格类型检查由 `tsconfig.renderer.json` 覆盖。
 */
let KapibalaHomeMascot: FunctionComponent<{ readonly typing: boolean }>;

beforeAll(async () => {
  (globalThis as Record<string, unknown>).React = React;
  const modulePath: string = '../src/renderer/home-mascot.js';
  const loaded = (await import(modulePath)) as {
    readonly KapibalaHomeMascot: FunctionComponent<{ readonly typing: boolean }>;
  };
  KapibalaHomeMascot = loaded.KapibalaHomeMascot;
});

describe('Desktop 首屏循环动图吉祥物 (KapibalaHomeMascot)', () => {
  it('渲染无底框纯墨线动态水豚 SVG 分层（呼吸廓形、琥珀小橘、袅袅热气与静水微澜），保持 aria-hidden 不污染无障碍按钮树', () => {
    const html = renderToStaticMarkup(createElement(KapibalaHomeMascot, { typing: false }));
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('<button');
    expect(html).toContain('kapibala-home-mascot');
    expect(html).toContain('kapibala-mascot-yuzu');
    expect(html).toContain('kapibala-mascot-steam');
    expect(html).toContain('kapibala-mascot-ripple');
    expect(html).toContain('data-typing="false"');
  });

  it('在输入框有草稿打字时切换 data-typing="true" 专注倾听状态', () => {
    const html = renderToStaticMarkup(createElement(KapibalaHomeMascot, { typing: true }));
    expect(html).toContain('data-typing="true"');
  });
});
