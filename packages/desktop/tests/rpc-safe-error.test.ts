import { describe, expect, it } from 'vitest';
import { safeError } from '../src/shared/rpc.js';

describe('safeError lock diagnostics', () => {
  it('appends holder pid for session locks without leaking raw messages', () => {
    const locked = safeError({
      code: 'SESSION_LOCKED',
      message: 'Session locked by a live or unknown owner (pid=82094)',
    });
    expect(locked.code).toBe('SESSION_LOCKED');
    expect(locked.message).toContain('pid=82094');
    expect(locked.message).toContain('重启应用');
    // 原始 message 只透出 pid 整数，英文诊断细节不进入用户文案。
    expect(locked.message).not.toContain('Session locked');

    // message 不含 pid 时保持固定安全文案。
    const unknown = safeError({ code: 'SESSION_LOCKED', message: 'corrupt owner' });
    expect(unknown.code).toBe('SESSION_LOCKED');
    expect(unknown.message).toBe('会话正被其它进程占用，请关闭占用它的客户端后重试。');

    // 其它错误码不受影响，不透出原始 message。
    const other = safeError({ code: 'SESSION_IN_USE', message: 'raw internal detail' });
    expect(other.code).toBe('SESSION_IN_USE');
    expect(other.message).not.toContain('raw internal detail');
  });
});
