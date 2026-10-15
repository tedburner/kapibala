import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isWindowsReservedDeviceName,
  resolveCommandTarget,
  resolveServerCwd,
  toNativePhysicalPath,
  verifyCommandTarget,
} from '../src/path.js';

describe('MCP Path Resolution, Reserved Device Defenses & Drift Detection (Task 3.3)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-mcp-path-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Windows 保留设备名防御
  // =========================================================================
  describe('isWindowsReservedDeviceName', () => {
    it('detects bare DOS/Windows reserved device names regardless of case', () => {
      expect(isWindowsReservedDeviceName('CON')).toBe(true);
      expect(isWindowsReservedDeviceName('con')).toBe(true);
      expect(isWindowsReservedDeviceName('Prn')).toBe(true);
      expect(isWindowsReservedDeviceName('AUX')).toBe(true);
      expect(isWindowsReservedDeviceName('nul')).toBe(true);
      expect(isWindowsReservedDeviceName('com1')).toBe(true);
      expect(isWindowsReservedDeviceName('COM9')).toBe(true);
      expect(isWindowsReservedDeviceName('lpt1')).toBe(true);
      expect(isWindowsReservedDeviceName('LPT9')).toBe(true);
    });

    it('detects reserved device names with arbitrary extensions', () => {
      expect(isWindowsReservedDeviceName('con.exe')).toBe(true);
      expect(isWindowsReservedDeviceName('NUL.txt')).toBe(true);
      expect(isWindowsReservedDeviceName('aux.bat')).toBe(true);
      expect(isWindowsReservedDeviceName('prn.cmd')).toBe(true);
      expect(isWindowsReservedDeviceName('com3.log')).toBe(true);
    });

    it('detects reserved device names within subdirectories of a path', () => {
      expect(isWindowsReservedDeviceName('C:/safe_dir/con/child.exe')).toBe(true);
      expect(isWindowsReservedDeviceName('./subdir/nul.txt')).toBe(true);
      expect(isWindowsReservedDeviceName('F:\\project\\aux\\script.js')).toBe(true);
    });

    it('does not falsely flag non-reserved words containing device names as substrings', () => {
      expect(isWindowsReservedDeviceName('constant.js')).toBe(false);
      expect(isWindowsReservedDeviceName('console')).toBe(false);
      expect(isWindowsReservedDeviceName('auxiliary')).toBe(false);
      expect(isWindowsReservedDeviceName('null')).toBe(false);
      expect(isWindowsReservedDeviceName('printer')).toBe(false);
      expect(isWindowsReservedDeviceName('community')).toBe(false);
    });
  });

  // =========================================================================
  // cwd 声明根解析
  // =========================================================================
  describe('resolveServerCwd', () => {
    it('defaults to native physical projectRoot when cwd is omitted', () => {
      const projectRoot = tempDir;
      const globalConfigDir = path.join(tempDir, 'global_config');
      fs.mkdirSync(globalConfigDir);

      const resolved = resolveServerCwd(undefined, 'project', projectRoot, globalConfigDir);
      expect(resolved.error).toBeUndefined();
      expect(resolved.cwd).toBe(toNativePhysicalPath(projectRoot));
    });

    it('resolves relative cwd against projectRoot for project-level source', () => {
      const projectRoot = tempDir;
      const sub = path.join(projectRoot, 'my_sub');
      fs.mkdirSync(sub);
      const globalConfigDir = path.join(tempDir, 'global_config');
      fs.mkdirSync(globalConfigDir);

      const resolved = resolveServerCwd('./my_sub', 'project', projectRoot, globalConfigDir);
      expect(resolved.error).toBeUndefined();
      expect(resolved.cwd).toBe(toNativePhysicalPath(sub));
    });

    it('resolves relative cwd against globalConfigDir for global-level source', () => {
      const projectRoot = tempDir;
      const globalConfigDir = path.join(tempDir, 'global_config');
      fs.mkdirSync(globalConfigDir);
      const globalSub = path.join(globalConfigDir, 'shared_server');
      fs.mkdirSync(globalSub);

      const resolved = resolveServerCwd('./shared_server', 'global', projectRoot, globalConfigDir);
      expect(resolved.error).toBeUndefined();
      expect(resolved.cwd).toBe(toNativePhysicalPath(globalSub));
    });

    it('rejects cwd targeting Windows reserved device names', () => {
      const resolved = resolveServerCwd('con', 'project', tempDir, tempDir);
      expect(resolved.error).toMatch(/forbidden Windows reserved device name/i);
    });

    it('returns error when resolved cwd does not exist on disk', () => {
      const nonExistent = path.join(tempDir, 'does_not_exist_xyz');
      const resolved = resolveServerCwd(nonExistent, 'project', tempDir, tempDir);
      expect(resolved.error).toMatch(/does not exist/i);
    });
  });

  // =========================================================================
  // command 实际目标解析与授权前后防漂移 (Drift Detection)
  // =========================================================================
  describe('Command target resolution and drift detection', () => {
    it('resolves node executable and binds local script digest', () => {
      // 在临时目录创建一个测试脚本
      const scriptPath = path.join(tempDir, 'test-server.js');
      fs.writeFileSync(scriptPath, 'console.log("running mcp server");');

      const { target, error } = resolveCommandTarget(
        process.execPath, // 保证可解析存在的 Node 可执行文件
        tempDir,
        ['./test-server.js'],
      );

      expect(error).toBeUndefined();
      expect(target).toBeDefined();
      expect(target?.executablePath).toBe(toNativePhysicalPath(process.execPath));
      expect(target?.scriptDigest).toBeDefined();
      expect(target?.scriptPath).toBe(toNativePhysicalPath(scriptPath));

      // 验证未修改前复核成功
      const verifyInitial = verifyCommandTarget(target!);
      expect(verifyInitial.valid).toBe(true);

      // 模拟修改脚本内容：导致授权后摘要漂移！
      fs.writeFileSync(scriptPath, 'console.log("malicious injected code");');

      const verifyDrifted = verifyCommandTarget(target!);
      expect(verifyDrifted.valid).toBe(false);
      expect(verifyDrifted.reason).toMatch(/content digest changed after approval/i);
    });

    it('detects drift when executable file is deleted or modified after approval', () => {
      const mockExe = path.join(tempDir, 'mock_app.bat');
      fs.writeFileSync(mockExe, '@echo off\r\necho hello');

      const { target, error } = resolveCommandTarget('./mock_app.bat', tempDir, []);

      expect(error).toBeUndefined();
      expect(target).toBeDefined();

      // 验证正常
      expect(verifyCommandTarget(target!).valid).toBe(true);

      // 删除可执行文件
      fs.unlinkSync(mockExe);
      const verifyDeleted = verifyCommandTarget(target!);
      expect(verifyDeleted.valid).toBe(false);
      expect(verifyDeleted.reason).toMatch(/no longer accessible/i);
    });

    it('strictly rejects command using Windows reserved device name', () => {
      const result = resolveCommandTarget('con.exe', tempDir, []);
      expect(result.target).toBeUndefined();
      expect(result.error).toMatch(/forbidden Windows reserved device name/i);
    });
  });
});
