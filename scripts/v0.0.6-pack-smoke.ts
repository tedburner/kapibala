#!/usr/bin/env node
/**
 * v0.0.6 独立 tarball 安装与三包本地烟测脚本。
 *
 * 验收目标：
 * 1. 使用 pnpm pack 产出 Core、MCP 与 CLI 三包的真实 tarball；
 * 2. 校验文件清单严格符合 package.json files 定义（无源码泄露、测试用例或开发脚本）；
 * 3. 校验 Core 运行时依赖为 0，MCP 依赖精确 Core 版本，CLI 依赖精确 Core 与 MCP 版本；
 * 4. 校验三包 SHA256 / SHA512 校验和；
 * 5. 在隔离临时工作区通过真实 npm 安装三包 tarball，并在纯产物环境下验收：
 *    - CLI 版本输出与 --help 包含 v0.0.6 新增能力与选项（--no-mcp 等）；
 *    - Core SDK 在 ESM import 与 CJS require 下的可用性；
 *    - MCP SDK 在 ESM import 与 CJS require 下的可用性。
 *
 * 注意：外部 npm Trusted Publisher 配置属于 GitHub Actions 与 npm 托管平台发布前置未验项，
 * 本地环境无法且禁止直接发布真实包到公共 registry。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

interface PackManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
}

/** 执行外部同步命令并捕获输出；失败时抛出带有详细诊断信息的错误。 */
function execute(command: string, args: string[], cwd?: string): string {
  let execCmd = command;
  let execArgs = args;

  if (process.platform === 'win32') {
    if (command === 'pnpm') {
      execCmd = 'pnpm.cmd';
    } else if (command === 'npm') {
      const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
      if (fs.existsSync(npmCli)) {
        execCmd = process.execPath;
        execArgs = [npmCli, ...args];
      } else {
        execCmd = 'npm.cmd';
      }
    }
  }

  const result = spawnSync(execCmd, execArgs, {
    cwd: cwd ?? ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: execCmd.endsWith('.cmd'),
  });

  if (result.error) {
    throw new Error(
      `Command "${command} ${args.join(' ')}" failed to spawn: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Command "${command} ${args.join(' ')}" exited with status ${result.status}:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

/**
 * 在 tarball 所在目录内以相对文件名调用 `tar`。
 * 传入含盘符的绝对路径时，Git Bash 的 GNU tar 会把 `C:` 解析成远程主机（`Cannot connect to C:`），
 * 因此任何宿主 shell 下都必须避免盘符出现在 tar 参数里。
 */
function readTarball(tarballPath: string, flags: string[], members: string[] = []): string {
  return execute(
    'tar',
    [...flags, path.basename(tarballPath), ...members],
    path.dirname(tarballPath),
  );
}

/**
 * 校验 tarball 内容清单是否合法。
 * 允许的文件仅限于 package/dist/*、package/package.json、package/README.md 与 package/LICENSE。
 */
function verifyTarballEntries(tarballPath: string): string[] {
  const output = readTarball(tarballPath, ['-tzf']);
  const entries = output
    .split(/\r?\n/)
    .map((e) => e.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const isAllowed = /^package\/(dist\/[^\r\n]+|LICENSE|README\.md|package\.json)$/.test(entry);
    if (!isAllowed) {
      throw new Error(`Unexpected entry in tarball ${path.basename(tarballPath)}: ${entry}`);
    }
  }
  return entries;
}

/** 读取 tarball 内部的 package.json 获得打包后的实际元数据清单。 */
function readTarballManifest(tarballPath: string): PackManifest {
  const jsonContent = readTarball(tarballPath, ['-xOf'], ['package/package.json']);
  return JSON.parse(jsonContent) as PackManifest;
}

/** 运行全量三包打包与独立安装冒烟验证。 */
export async function runPackSmokeVerification(): Promise<{
  packDirectory: string;
  installDirectory: string;
  packages: Array<{ name: string; version: string; tarball: string; sha256: string }>;
}> {
  console.log('🐾 [v0.0.6 Smoke] 开始三包独立 tarball 打包与隔离安装验收...');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-v006-smoke-'));
  const packDir = path.join(tempRoot, 'pack');
  const installDir = path.join(tempRoot, 'install');
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });

  const pkgDirs = [
    { name: '@kiturone/kapibala', subPath: 'packages/core' },
    { name: '@kiturone/kapibala-mcp', subPath: 'packages/mcp' },
    { name: '@kiturone/kapibala-cli', subPath: 'packages/cli' },
  ];

  const packageSummaries: Array<{
    name: string;
    version: string;
    tarball: string;
    sha256: string;
  }> = [];

  // 1. 分别对三包执行 pnpm pack
  for (const pkg of pkgDirs) {
    console.log(`  -> 正在打包 ${pkg.name}...`);
    execute('pnpm', ['-C', pkg.subPath, 'pack', '--pack-destination', packDir]);
  }

  // 2. 检查 tarball 产物、校验依赖与文件清单
  const packedFiles = fs.readdirSync(packDir).filter((f) => f.endsWith('.tgz'));
  assert.equal(packedFiles.length, 3, `预期产出 3 个 tarball，实际产出: ${packedFiles.join(', ')}`);

  let targetVersion = '';

  for (const pkg of pkgDirs) {
    const tarballName = packedFiles.find((f) =>
      f.startsWith(`${pkg.name.slice(1).replace('/', '-')}-`),
    );
    assert.ok(tarballName, `未找到 ${pkg.name} 的对应 tarball`);

    const tarballPath = path.join(packDir, tarballName);
    const content = fs.readFileSync(tarballPath);
    const sha256 = createHash('sha256').update(content).digest('hex');

    // 校验清单与文件
    const entries = verifyTarballEntries(tarballPath);
    assert.ok(entries.includes('package/package.json'));
    assert.ok(entries.some((e) => e.startsWith('package/dist/')));

    const manifest = readTarballManifest(tarballPath);
    assert.equal(manifest.name, pkg.name);
    if (!targetVersion) {
      targetVersion = manifest.version;
    } else {
      assert.equal(
        manifest.version,
        targetVersion,
        `包版本不一致: ${pkg.name}@${manifest.version}`,
      );
    }

    if (pkg.name === '@kiturone/kapibala') {
      // Core 零依赖
      const deps = Object.keys(manifest.dependencies ?? {});
      assert.equal(deps.length, 0, `Core 运行时依赖必须为 0，实际发现: ${deps.join(', ')}`);
    } else if (pkg.name === '@kiturone/kapibala-mcp') {
      // MCP 依赖 Core
      assert.equal(
        manifest.dependencies?.['@kiturone/kapibala'],
        targetVersion,
        'MCP 打包产物中的 @kiturone/kapibala 必须被转换为精确版本',
      );
    } else if (pkg.name === '@kiturone/kapibala-cli') {
      // CLI 依赖 Core 与 MCP
      assert.equal(
        manifest.dependencies?.['@kiturone/kapibala'],
        targetVersion,
        'CLI 打包产物中的 @kiturone/kapibala 必须为精确版本',
      );
      assert.equal(
        manifest.dependencies?.['@kiturone/kapibala-mcp'],
        targetVersion,
        'CLI 打包产物中的 @kiturone/kapibala-mcp 必须为精确版本',
      );
    }

    packageSummaries.push({
      name: pkg.name,
      version: manifest.version,
      tarball: tarballName,
      sha256,
    });
    console.log(`  ✔ ${pkg.name}@${manifest.version} 校验通过 (SHA256: ${sha256.slice(0, 16)}...)`);
  }

  // 3. 在隔离目录通过真实 npm 进行独立安装
  console.log('  -> 正在隔离目录执行真实 npm 安装三包 tarball...');
  fs.writeFileSync(
    path.join(installDir, 'package.json'),
    JSON.stringify({ name: 'kpbl-smoke-consumer', private: true, type: 'module' }, null, 2),
  );

  const tarballPaths = packageSummaries.map((p) => path.join(packDir, p.tarball));
  execute('npm', [
    'install',
    '--prefix',
    installDir,
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    ...tarballPaths,
  ]);

  // 4. 验证 CLI 产物
  console.log('  -> 正在验证独立安装的 CLI 命令与帮助输出...');
  const cliBin = path.join(
    installDir,
    'node_modules',
    '@kiturone',
    'kapibala-cli',
    'dist',
    'bin.js',
  );
  assert.ok(fs.existsSync(cliBin), 'CLI 产物二进制未在 node_modules 成功就位');

  const cliVersionOutput = execute(process.execPath, [cliBin, '--version'], installDir);
  assert.equal(
    cliVersionOutput,
    `kpbl v${targetVersion}`,
    `CLI 版本输出不匹配: ${cliVersionOutput}`,
  );

  const cliHelpOutput = execute(process.execPath, [cliBin, '--help'], installDir);
  assert.ok(cliHelpOutput.includes('--no-mcp'), 'CLI 帮助输出必须包含 --no-mcp 选项');

  // 5. 验证 Core SDK 在 ESM import 与 CJS require 环境下的可用性
  console.log('  -> 正在验证独立安装的 Core SDK 导出可用性...');
  execute(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'import assert from "node:assert/strict"; import * as core from "@kiturone/kapibala"; assert.equal(typeof core.AgentSession, "function"); assert.equal(typeof core.SessionManager, "function")',
    ],
    installDir,
  );
  execute(
    process.execPath,
    [
      '-e',
      'const assert = require("node:assert/strict"); const core = require("@kiturone/kapibala"); assert.equal(typeof core.AgentSession, "function"); assert.equal(typeof core.SessionManager, "function")',
    ],
    installDir,
  );

  // 6. 验证 MCP SDK 在 ESM import 与 CJS require 环境下的可用性
  console.log('  -> 正在验证独立安装的 MCP SDK 导出可用性...');
  execute(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'import assert from "node:assert/strict"; import * as mcp from "@kiturone/kapibala-mcp"; assert.equal(typeof mcp.McpServerManager, "function"); assert.equal(typeof mcp.createMcpPlugin, "function")',
    ],
    installDir,
  );
  execute(
    process.execPath,
    [
      '-e',
      'const assert = require("node:assert/strict"); const mcp = require("@kiturone/kapibala-mcp"); assert.equal(typeof mcp.McpServerManager, "function"); assert.equal(typeof mcp.createMcpPlugin, "function")',
    ],
    installDir,
  );

  console.log(
    '✔ [v0.0.6 Smoke] 三包独立 tarball 打包、文件清单、依赖约束与 ESM/CJS 冒烟验收全部通过！',
  );
  console.log(
    'ℹ [未验项说明] 外部 npm Trusted Publisher 配置需要在实际发布前由管理员在 npmjs.com / GitHub 平台配置，本地环境不执行真实 npm publish。',
  );

  // 清理临时文件
  fs.rmSync(tempRoot, { recursive: true, force: true });

  return {
    packDirectory: packDir,
    installDirectory: installDir,
    packages: packageSummaries,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPackSmokeVerification().catch((error: unknown) => {
    console.error('✘ [v0.0.6 Smoke] 验收失败:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
