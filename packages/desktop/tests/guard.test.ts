import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HostGuard } from '../src/main/guard.js';

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-guard-'));
  roots.push(root);
  return { root, guard: new HostGuard(root) };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('存在、损坏或不可读 guard 阻止新 Host，不静默覆盖', () => {
  const { root, guard } = fixture();
  expect(guard.inspect()).toEqual({ blocked: false });
  guard.begin('first');
  expect(() => guard.begin('second')).toThrow(/RECOVERY_REQUIRED/);
  fs.writeFileSync(path.join(root, 'host-guard.json'), '{broken');
  expect(guard.inspect().blocked).toBe(true);
  expect(() => guard.begin('third')).toThrow(/RECOVERY_REQUIRED/);
});
it('先记录空间再执行，仅完整清理确认加正常退出可清除 guard', () => {
  const { guard } = fixture();
  guard.begin('first');
  guard.register({ id: 'workspace', root: '/explicit/workspace' });
  expect(guard.inspect()).toMatchObject({
    blocked: true,
    record: { workspaces: [{ id: 'workspace', root: '/explicit/workspace' }] },
  });
  expect(() => guard.complete({ hostInstanceId: 'first', cleaned: false, exitCode: 0 })).toThrow(
    /CLEANUP_UNCONFIRMED/,
  );
  expect(() => guard.complete({ hostInstanceId: 'first', cleaned: true, exitCode: 1 })).toThrow(
    /CLEANUP_UNCONFIRMED/,
  );
  guard.complete({ hostInstanceId: 'first', cleaned: true, exitCode: 0 });
  expect(guard.inspect().blocked).toBe(false);
});
it('恢复必须有人工确认和旧 Host 退出事实，不删除他人的 guard', () => {
  const { guard } = fixture();
  guard.begin('first');
  expect(() => guard.recover({ confirmed: false, oldHostExited: true })).toThrow(
    /RECOVERY_REQUIRED/,
  );
  expect(() => guard.recover({ confirmed: true, oldHostExited: false })).toThrow(
    /RECOVERY_REQUIRED/,
  );
  expect(() => guard.complete({ hostInstanceId: 'another', cleaned: true, exitCode: 0 })).toThrow(
    /GUARD_OWNER_MISMATCH/,
  );
  guard.recover({ confirmed: true, oldHostExited: true });
  guard.begin('second');
  expect(guard.inspect()).toMatchObject({ record: { hostInstanceId: 'second' } });
});
