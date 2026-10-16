import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('Real multi-layer process group termination', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-proc-kill-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function isPidAlive(pid: number): boolean {
    if (process.platform === 'win32') {
      const res = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      return res.stdout.includes(String(pid));
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it('terminates real multi-layer process tree cleanly without orphaned grandchildren', async () => {
    // 编写一个父子多层 node 脚本：父进程启动子进程，子进程启动孙进程，持续休眠
    const grandChildScript = path.join(tempDir, 'grandchild.mjs');
    const childScript = path.join(tempDir, 'child.mjs');
    const pidsFile = path.join(tempDir, 'pids.json');

    fs.writeFileSync(
      grandChildScript,
      `
      setInterval(() => {}, 1000);
      `,
    );

    fs.writeFileSync(
      childScript,
      `
      import { spawn } from 'node:child_process';
      import fs from 'node:fs';
      const grandChild = spawn(process.execPath, [${JSON.stringify(grandChildScript)}], {
        detached: false,
        windowsHide: true,
      });
      fs.writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({
        childPid: process.pid,
        grandChildPid: grandChild.pid,
      }));
      setInterval(() => {}, 1000);
      `,
    );

    const child = spawn(process.execPath, [childScript], {
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    // 等待两层进程都就绪并写入 PID
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(pidsFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(fs.existsSync(pidsFile)).toBe(true);
    const { childPid, grandChildPid } = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));

    expect(childPid).toBeGreaterThan(0);
    expect(grandChildPid).toBeGreaterThan(0);
    expect(isPidAlive(childPid)).toBe(true);
    expect(isPidAlive(grandChildPid)).toBe(true);

    // 执行多层进程回收：
    // 在 Windows 下使用 taskkill /PID <childPid> /T /F；在 POSIX 下使用 process.kill(-childPid, 'SIGKILL')
    if (process.platform === 'win32') {
      const killRes = spawnSync('taskkill', ['/PID', String(childPid), '/T', '/F'], {
        windowsHide: true,
      });
      expect(killRes.status).toBe(0);
    } else {
      try {
        process.kill(-childPid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }

    // 等待最多 3 秒确认两层进程都已死亡
    const verifyDeadline = Date.now() + 3000;
    let childDead = false;
    let grandChildDead = false;

    while (Date.now() < verifyDeadline) {
      childDead = !isPidAlive(childPid);
      grandChildDead = !isPidAlive(grandChildPid);
      if (childDead && grandChildDead) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // 断言子进程与孙进程均已被回收，无孤儿残留
    expect(childDead).toBe(true);
    expect(grandChildDead).toBe(true);
  }, 25_000);
});
