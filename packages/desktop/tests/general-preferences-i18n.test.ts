import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeNotices } from '../src/main/native-notices.js';
import { Preferences } from '../src/main/preferences.js';
import {
  DEFAULT_LOCALE_PREFERENCE,
  EN_MESSAGES,
  ZH_CN_MESSAGES,
  clampChatFontSize,
  clampTerminalFontSize,
  formatActivityTimestamp,
  resolveDesktopLocale,
  resolveMonoFontStack,
  resolveSansFontStack,
  shouldSubmitComposerKey,
  translateDesktop,
} from '../src/shared/i18n/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('桌面端零依赖强类型双语词典与排版工具（shared/i18n）', () => {
  it('中英文词典键集合 100% 对齐，支持参数插值与 system 语言解析', () => {
    expect(Object.keys(EN_MESSAGES).sort()).toEqual(Object.keys(ZH_CN_MESSAGES).sort());
    expect(DEFAULT_LOCALE_PREFERENCE).toBe('system');
    expect(resolveDesktopLocale('zh-CN', 'en-US')).toBe('zh-CN');
    expect(resolveDesktopLocale('en', 'zh-CN')).toBe('en');
    expect(resolveDesktopLocale('system', 'zh-TW')).toBe('zh-CN');
    expect(resolveDesktopLocale('system', 'en-US')).toBe('en');
    expect(resolveDesktopLocale('system', 'ja-JP')).toBe('en');

    const prevE2e = process.env.KPBL_DESKTOP_E2E;
    try {
      process.env.KPBL_DESKTOP_E2E = '1';
      expect(resolveDesktopLocale('system', 'en-US')).toBe('zh-CN');
    } finally {
      if (prevE2e === undefined) Reflect.deleteProperty(process.env, 'KPBL_DESKTOP_E2E');
      else process.env.KPBL_DESKTOP_E2E = prevE2e;
    }

    expect(translateDesktop('zh-CN', 'settings.nav.general')).toBe('常规');
    expect(translateDesktop('en', 'settings.nav.general')).toBe('General');
    expect(translateDesktop('en', 'launchpad.greetingWorkspace', { name: 'kapibala' })).toBe(
      'Start a new task in kapibala',
    );
  });

  it('安全解析界面与代码等宽字体栈，剥离非法 CSS 注入字符并夹紧字号边界', () => {
    expect(resolveSansFontStack('system')).toContain('PingFang SC');
    expect(resolveMonoFontStack('jetbrains-mono')).toContain('"JetBrains Mono"');
    expect(resolveMonoFontStack('Fira Code; color: red } {')).toContain('"Fira Code color red"');
    expect(resolveMonoFontStack('Fira Code; color: red } {')).not.toContain(';');
    expect(resolveMonoFontStack('Fira Code; color: red } {')).not.toContain('{');

    expect(clampChatFontSize(9)).toBe(13);
    expect(clampChatFontSize(15)).toBe(15);
    expect(clampChatFontSize(28)).toBe(18);
    expect(clampTerminalFontSize(6)).toBe(11);
    expect(clampTerminalFontSize(14)).toBe(14);
    expect(clampTerminalFontSize(30)).toBe(18);
  });

  it('按时间格式偏好与语言格式化会话活动时间，并正确判定发送快捷键', () => {
    const now = Date.UTC(2026, 10, 28, 12, 30, 0);
    expect(formatActivityTimestamp(0, 'relative', 'zh-CN', now)).toBe('');
    expect(formatActivityTimestamp(now - 20_000, 'relative', 'zh-CN', now)).toBe('刚刚');
    expect(formatActivityTimestamp(now - 20_000, 'relative', 'en', now)).toBe('Just now');
    expect(formatActivityTimestamp(now - 5 * 60_000, 'relative', 'en', now)).toBe('5m ago');
    expect(formatActivityTimestamp(now - 5 * 60_000, '24h', 'en', now)).toMatch(/^\d{2}:\d{2}$/);

    expect(
      shouldSubmitComposerKey(
        { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false },
        'enter',
      ),
    ).toBe(true);
    expect(
      shouldSubmitComposerKey(
        { key: 'Enter', shiftKey: true, metaKey: false, ctrlKey: false, isComposing: false },
        'enter',
      ),
    ).toBe(false);
    expect(
      shouldSubmitComposerKey(
        { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, isComposing: true },
        'enter',
      ),
    ).toBe(false);
    expect(
      shouldSubmitComposerKey(
        { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false },
        'mod-enter',
      ),
    ).toBe(false);
    expect(
      shouldSubmitComposerKey(
        { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: true, isComposing: false },
        'mod-enter',
      ),
    ).toBe(true);
  });
});

describe('Preferences 桌面常规偏好持久化、旧配置无损升级与重置默认', () => {
  it('旧版仅含 theme/recent/width/height 的 desktop-state.json 无损补齐常规默认值，重置不丢最近项目', () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-prefs-general-'));
    tempDirs.push(userData);
    fs.writeFileSync(
      path.join(userData, 'desktop-state.json'),
      JSON.stringify({
        theme: 'dark',
        recent: [{ id: 'r1', name: 'kapibala', root: '/repo/kapibala' }],
        width: 1440,
        height: 900,
      }),
    );

    const prefs = new Preferences(userData);
    const initial = prefs.read();
    expect(initial.theme).toBe('dark');
    expect(initial.locale).toBe('system');
    expect(initial.typography).toEqual({
      uiFontFamily: 'system',
      codeFontFamily: 'system',
      chatFontSize: 15,
      terminalFontSize: 13,
      codeLigatures: false,
    });
    expect(initial.general).toEqual({
      timeFormat: 'relative',
      sendShortcut: 'enter',
      codeWordWrap: false,
      desktopNotifications: true,
      preferredShell: 'auto',
    });
    expect(initial.confirmations).toEqual({
      deleteSession: true,
      archiveSession: false,
      closeActiveTerminal: true,
    });

    prefs.patch({
      locale: 'en',
      typography: { chatFontSize: 17, terminalFontSize: 15, codeFontFamily: 'jetbrains-mono' },
      general: { sendShortcut: 'mod-enter', desktopNotifications: false },
      confirmations: { archiveSession: true },
    });

    const reloaded = new Preferences(userData).read();
    expect(reloaded.locale).toBe('en');
    expect(reloaded.typography.chatFontSize).toBe(17);
    expect(reloaded.typography.terminalFontSize).toBe(15);
    expect(reloaded.typography.codeFontFamily).toBe('jetbrains-mono');
    expect(reloaded.general.sendShortcut).toBe('mod-enter');
    expect(reloaded.general.desktopNotifications).toBe(false);
    expect(reloaded.confirmations.archiveSession).toBe(true);
    expect(reloaded.confirmations.deleteSession).toBe(true);

    prefs.resetGeneral();
    const afterReset = prefs.read();
    expect(afterReset.locale).toBe('system');
    expect(afterReset.typography.chatFontSize).toBe(15);
    expect(afterReset.general.sendShortcut).toBe('enter');
    expect(afterReset.confirmations.archiveSession).toBe(false);
    expect(afterReset.recent).toEqual([{ id: 'r1', name: 'kapibala', root: '/repo/kapibala' }]);
    expect(afterReset.width).toBe(1440);
  });

  it('NativeNotices 支持后台通知总开关与双语通知文案', () => {
    const shown: Array<{ title: string; body: string }> = [];
    let enabled = false;
    const locale: 'zh-CN' | 'en' = 'en';
    const notices = new NativeNotices(
      () => true,
      (title, body) => {
        shown.push({ title, body });
        return () => {};
      },
      () => {},
      () => enabled,
      () => locale,
    );
    notices.open('s1');
    notices.observe({
      type: 'approval.requested',
      workspaceId: 'w1',
      sessionId: 's1',
      workspaceName: 'demo',
      workspaceRoot: '/demo',
      conversationId: 'c1',
      approvalId: 'ap-1',
      runId: 'r1',
      toolName: 'run_command',
      capabilities: ['exec'],
      description: 'npm test',
      sessionAllowed: true,
      expiresAt: Date.now() + 60_000,
    });
    expect(shown).toHaveLength(0);

    enabled = true;
    notices.observe({
      type: 'approval.requested',
      workspaceId: 'w1',
      sessionId: 's1',
      workspaceName: 'demo',
      workspaceRoot: '/demo',
      conversationId: 'c1',
      approvalId: 'ap-2',
      runId: 'r1',
      toolName: 'run_command',
      capabilities: ['exec'],
      description: 'npm test',
      sessionAllowed: true,
      expiresAt: Date.now() + 60_000,
    });
    expect(shown).toEqual([
      {
        title: 'Approval requested',
        body: 'Open Kapibala to review and respond.',
      },
    ]);
  });
});
