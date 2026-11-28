import { useCallback } from 'react';
import {
  type ResolvedDesktopLocale,
  type TranslationKey,
  translateDesktop,
} from '../shared/i18n/index.js';
import { useSettingsStore } from './stores/settings-store.js';

export { type ResolvedDesktopLocale, type TranslationKey, translateDesktop };

/**
 * 渲染层轻量双语 Hook：直接订阅 `useSettingsStore` 的 `resolvedLocale`，
 * 切换语言时驱动消费组件即时无刷新重绘，不引入第三方 i18n Context 容器。
 */
export function useI18n(): {
  readonly locale: ResolvedDesktopLocale;
  readonly t: (key: TranslationKey, params?: Readonly<Record<string, string | number>>) => string;
} {
  const locale = useSettingsStore((s) => s.resolvedLocale);
  const t = useCallback(
    (key: TranslationKey, params?: Readonly<Record<string, string | number>>) =>
      translateDesktop(locale, key, params),
    [locale],
  );
  return { locale, t };
}
