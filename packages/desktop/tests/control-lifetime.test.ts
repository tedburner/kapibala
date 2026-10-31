import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ControlLifetime } from '../src/main/control-lifetime.js';
import { NativeNotices } from '../src/main/native-notices.js';
import { Preferences } from '../src/main/preferences.js';

it.each(['initial', 'alias'] as const)(
  '控制失效后的 %s 回复不能覆盖最近项目或继续登记',
  async (stage) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-control-'));
    try {
      const preferences = new Preferences(root);
      preferences.recent('/project', '新项目名');
      let owner = true;
      let backend = true;
      const lifetime = new ControlLifetime(
        () => owner,
        () => {},
      );
      let release!: (value: string) => void;
      let registered = false;
      const pending = lifetime.wait(
        () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
        () => backend,
      );
      const updating = pending.then((name) => {
        preferences.recent('/project', name);
        registered = true;
      });
      const rejection = expect(updating).rejects.toThrow('HOST_UNAVAILABLE');
      if (stage === 'initial') owner = false;
      else backend = false;
      release('过期项目名');
      await rejection;
      expect(preferences.read().recent[0].name).toBe('新项目名');
      expect(registered).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
it('控制关闭同步撤销真实通知回调，不等待 Host 清理完成', async () => {
  let focus = 0;
  let clicked!: () => void;
  let dismissed = 0;
  const notices = new NativeNotices(
    () => true,
    (_title, _body, click) => {
      clicked = click;
      return () => dismissed++;
    },
    () => focus++,
  );
  notices.open('s');
  notices.observe({
    type: 'run.changed',
    receipt: {
      workspaceId: 'w',
      sessionId: 's',
      runId: 'r',
      operationId: 'o',
      phase: 'idle',
      result: 'completed',
    },
  });
  const lifetime = new ControlLifetime(
    () => true,
    () => notices.reset(),
  );
  lifetime.detach();
  clicked();
  expect(focus).toBe(0);
  expect(dismissed).toBe(1);
  await expect(
    lifetime.wait(
      async () => 'late',
      () => true,
    ),
  ).rejects.toThrow('HOST_UNAVAILABLE');
});
