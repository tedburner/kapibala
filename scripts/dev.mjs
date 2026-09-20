#!/usr/bin/env node
/**
 * Kapibala 本地一键开发脚本（跨平台唯一真源）
 *
 * 设计要点：
 * 1. 所有逻辑只写在这里，`dev.sh` / `dev.cmd` 只是转发参数的薄壳。
 * 2. 全程使用 spawnSync + 显式 shell:true，不依赖 bash / cmd 语义差异。
 * 3. 输出统一走 process.stdout.write，避免 Windows ANSI 兼容问题。
 *
 * 用法：node scripts/dev.mjs [选项]
 * 详见 --help。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const IS_WINDOWS = process.platform === 'win32';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

const say = (msg = '') => process.stdout.write(`${msg}\n`);

let stepNo = 0;
const step = (title) => {
  stepNo += 1;
  say(`\n${C.cyan}${C.bold}[${stepNo}/${TOTAL}] ${title}${C.reset}`);
};
const ok = (msg) => say(`${C.green}  ✔ ${msg}${C.reset}`);
const warn = (msg) => say(`${C.yellow}  ⚠ ${msg}${C.reset}`);
const fail = (msg) => say(`${C.red}  ✘ ${msg}${C.reset}`);

const HELP = `
🐾 Kapibala 本地开发启动脚本 (kpbl)

用法:
  node scripts/dev.mjs [选项]
  bash scripts/dev.sh [选项]        # macOS / Linux / Git Bash
  dev.cmd                           # Windows 双击或 cmd

流程:
  预检 → 依赖安装(按需) → 工作区链接自愈 → 编译 → 校验(typecheck+test+lint) → 启动

选项:
  -p, --prompt <text>   单次问答模式，直接输出结果后退出（不进入 REPL）
  -m, --model <id>      指定模型 profile（透传给 kpbl）
      --api-key <key>   临时指定 API 密钥（透传，不写入本地配置）
      --base-url <url>  临时覆盖模型 API 端点（透传）
      --debug           透传 --debug，输出调试日志
      --no-build        跳过编译（复用上次 dist）
      --no-verify       跳过 typecheck + test + lint
      --verify-only     只跑完整校验（typecheck + test + lint），不编译、不启动
      --no-start        跑完全流程但不进入 REPL，停在启动前（= pnpm dev:build）
      --skip-install    即使缺少 node_modules 也不自动安装
      --clean           启动前清理 dist 与 tsup 缓存
      --global          构建后注册全局 kpbl 命令（等价于 pnpm link:cli）
  -h, --help            显示本帮助

示例:
  node scripts/dev.mjs                       # 全量流程后进入交互式 REPL
  node scripts/dev.mjs --no-verify           # 跳过校验，最快进入 REPL
  node scripts/dev.mjs --no-start            # 只构建 + 校验，不启动
  node scripts/dev.mjs -p "看看当前目录"      # 单次问答
  node scripts/dev.mjs -m deepseek-v4-pro    # 指定模型启动
`;

function parseArgs(argv) {
  const opts = {
    prompt: null,
    model: null,
    apiKey: null,
    baseUrl: null,
    debug: false,
    build: true,
    verify: true,
    verifyOnly: false,
    install: true,
    clean: false,
    global: false,
    noStart: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        fail(`选项 ${arg} 需要一个参数`);
        process.exit(2);
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-p':
      case '--prompt':
        opts.prompt = next();
        break;
      case '-m':
      case '--model':
        opts.model = next();
        break;
      case '--api-key':
        opts.apiKey = next();
        break;
      case '--base-url':
        opts.baseUrl = next();
        break;
      case '--debug':
        opts.debug = true;
        break;
      case '--no-build':
        opts.build = false;
        break;
      case '--no-verify':
        opts.verify = false;
        break;
      case '--verify-only':
        opts.verifyOnly = true;
        opts.build = false;
        break;
      case '--no-start':
        opts.noStart = true;
        break;
      case '--skip-install':
        opts.install = false;
        break;
      case '--clean':
        opts.clean = true;
        break;
      case '--global':
        opts.global = true;
        break;
      default:
        fail(`未知选项: ${arg}`);
        say('  使用 --help 查看支持的选项。');
        process.exit(2);
    }
  }

  return opts;
}

/**
 * 执行外部命令并继承 stdio（进度实时可见）。
 * Windows 上 pnpm 实际是 .cmd，必须经 shell 才能解析，因此统一 shell:true。
 * 返回 true 表示退出码为 0。
 */
function run(command, args) {
  say(`${C.dim}  $ ${command} ${args.join(' ')}${C.reset}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
  });

  if (result.error) {
    fail(`${command} 执行失败: ${result.error.message}`);
    return false;
  }
  return result.status === 0;
}

function detect(bin, args = ['--version']) {
  const result = spawnSync(bin, args, { stdio: 'pipe', shell: true, encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || result.stderr || '').trim().split('\n')[0];
}

/** 统计 node_modules 里已安装的包数量，用于「依赖是否已装」的粗判。 */
function hasDependencies() {
  const nm = join(ROOT, 'node_modules');
  if (!existsSync(nm)) return false;
  try {
    return readdirSync(nm).length > 0;
  } catch {
    return false;
  }
}

/** 读取 packages/* 下所有 workspace 包的名称与目录。 */
function readWorkspacePackages() {
  const base = join(ROOT, 'packages');
  if (!existsSync(base)) return [];

  const found = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(base, entry.name);
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const json = JSON.parse(readFileSync(manifest, 'utf8'));
      if (typeof json.name === 'string' && json.name.length > 0) {
        found.push({ name: json.name, dir });
      }
    } catch {
      // package.json 读不出内容时跳过，不影响后续流程
    }
  }
  return found;
}

/**
 * 修复 workspace 软链（Windows 上的已知坑）。
 *
 * 现象：本机 pnpm 为 workspace 依赖创建链接时会「成功」返回，但产物是一个空目录
 * 而非真实链接，于是运行时 `import '@kiturone/kapibala'` 报 ERR_MODULE_NOT_FOUND。
 * 普通（非 workspace）依赖的链接不受影响。
 *
 * 处理：仅针对「已存在于 node_modules 下、但既不是链接、又完全为空」的目录，
 * 删掉后用 junction 重建（junction 在此环境无需管理员权限，已验证可用）。
 * 非空目录一律不动，避免误伤 pnpm 的正常产出。
 */
function repairWorkspaceLinks() {
  const packages = readWorkspacePackages();
  if (packages.length === 0) return [];

  // 可能引用 workspace 包的 node_modules：仓库根 + 各 workspace 包自身
  const holders = [ROOT, ...packages.map((p) => p.dir)];
  const repaired = [];

  for (const holder of holders) {
    for (const pkg of packages) {
      const link = join(holder, 'node_modules', ...pkg.name.split('/'));
      if (!existsSync(link)) continue;

      let stat;
      try {
        stat = lstatSync(link);
      } catch {
        continue;
      }
      // 已是真实链接则无需处理
      if (stat.isSymbolicLink()) continue;
      // 只处理空目录：非空说明是正常产物（如拷贝安装），不动
      try {
        if (readdirSync(link).length > 0) continue;
      } catch {
        continue;
      }

      try {
        rmSync(link, { recursive: true, force: true });
        symlinkSync(pkg.dir, link, IS_WINDOWS ? 'junction' : 'dir');
        if (existsSync(join(link, 'package.json'))) {
          repaired.push(`${relative(holder)} -> ${pkg.name}`);
        }
      } catch (err) {
        warn(`重建 ${pkg.name} 链接失败: ${err.message}`);
      }
    }
  }

  return repaired;
}

function relative(dir) {
  return dir === ROOT ? '.' : dir.slice(ROOT.length + 1);
}

// ---------------------------------------------------------------- 主流程

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  say(HELP.trim());
  process.exit(0);
}

// 预检 → 依赖 → [清理] → 链接 → 编译 → 校验 → [全局] → 启动
// 步骤总数随选项动态变化，避免出现 [5/6] 之后还有一步这类错位。
const TOTAL =
  (opts.verifyOnly ? 3 : 5) +
  (opts.clean ? 1 : 0) +
  (!opts.verifyOnly && opts.global ? 1 : 0) +
  (!opts.verifyOnly && !opts.noStart ? 1 : 0);

say(`${C.bold}🐾 Kapibala 本地开发启动${C.reset}`);
say(`${C.dim}  工作区: ${ROOT}${C.reset}`);
say(`${C.dim}  平台:   ${process.platform} / node ${process.version}${C.reset}`);

// 1. 环境预检
step('环境预检');

const nodeVersion = detect('node');
if (!nodeVersion) {
  fail('未检测到 node，请先安装 Node.js 18+。');
  process.exit(1);
}
ok(`node ${nodeVersion.replace(/^v/, '')}`);

const pnpmVersion = detect('pnpm');
if (!pnpmVersion && !opts.verifyOnly) {
  fail('未检测到 pnpm，请先执行: npm i -g pnpm');
  process.exit(1);
}
if (pnpmVersion) ok(`pnpm ${pnpmVersion}`);

const depsReady = hasDependencies() || opts.verifyOnly;
if (pnpmVersion && depsReady) ok('依赖已就绪');

// 2. 依赖安装（按需）
if (!opts.verifyOnly) {
  step('依赖检查');
  if (depsReady) {
    say('  已存在 node_modules，跳过安装（如需强制重装请手动删除后重跑）。');
  } else if (!opts.install) {
    fail('缺少 node_modules 且指定了 --skip-install，无法继续。');
    process.exit(1);
  } else if (!run('pnpm', ['install'])) {
    fail('依赖安装失败。');
    process.exit(1);
  } else {
    ok('依赖安装完成');
  }
}

// 3. 清理构建产物（可选）
if (opts.clean) {
  step('清理构建产物');
  for (const pkg of readWorkspacePackages()) {
    for (const dir of ['dist', '.tsup']) {
      const target = join(pkg.dir, dir);
      if (!existsSync(target)) continue;
      // dist / .tsup 均在 .gitignore 内，删除安全。
      rmSync(target, { recursive: true, force: true });
      say(`  已移除 ${relative(pkg.dir)}/${dir}`);
    }
  }
  ok('清理完成');
}

// 4. 工作区链接自愈（Windows 上 pnpm 会退化成空目录）
step('工作区链接');
const repaired = repairWorkspaceLinks();
if (repaired.length === 0) {
  ok('workspace 链接正常');
} else {
  ok(`已重建 ${repaired.length} 个 workspace 链接`);
  for (const item of repaired) say(`    ${C.dim}${item}${C.reset}`);
}

// 5. 校验 / 编译
if (opts.verifyOnly) {
  step('校验');
  // 与仓库门禁同源：pnpm verify = typecheck → test → lint（含 check-secrets 密钥扫描）。
  // 早前这里只跑 typecheck + test 便报告「校验全部通过」，会把 lint 错误和密钥泄露一起漏过去。
  if (!run('pnpm', ['verify'])) {
    fail('校验未通过（typecheck / test / lint）。');
    process.exit(1);
  }
  ok('校验通过');
  say(`\n${C.green}${C.bold}校验全部通过 ✔${C.reset}`);
  process.exit(0);
}

step('编译');
if (!opts.build) {
  say('  已指定 --no-build，跳过编译。');
} else if (!run('pnpm', ['build'])) {
  fail('编译失败。');
  process.exit(1);
} else {
  ok('编译完成');
}

step('校验');
if (!opts.verify) {
  warn('已指定 --no-verify，跳过 typecheck / test / lint。');
} else if (!run('pnpm', ['verify'])) {
  // 门禁不通过时不进入 REPL：避免「带着类型错误或红灯测试开始对话」，
  // 否则运行时行为不可信，排查成本远高于此刻中断。
  fail('校验未通过，已中断启动。');
  say(`  ${C.dim}如需跳过校验请使用 --no-verify。${C.reset}`);
  process.exit(1);
} else {
  ok('校验通过');
}

// 6. 全局注册（可选）
if (opts.global) {
  step('注册全局命令');
  if (!run('pnpm', ['link:cli'])) {
    warn('全局 link 失败，可继续使用 node 直跑方式启动。');
  } else {
    ok('已注册全局命令 kpbl');
  }
}

const BIN = join(ROOT, 'packages', 'cli', 'dist', 'bin.js');
if (!existsSync(BIN)) {
  fail(`未找到 CLI 产物: ${relative(BIN)}`);
  say(`  ${C.dim}请去掉 --no-build 重新执行以完成编译。${C.reset}`);
  process.exit(1);
}

// 收尾：--no-start 时到此为止，不进入 REPL
if (opts.noStart) {
  if (opts.prompt) {
    warn('已指定 --no-start，忽略 -p/--prompt（不会发起单次问答）。');
  }
  say(`\n${C.green}${C.bold}构建与校验完成，按 --no-start 未启动。${C.reset}`);
  say(`${C.dim}  产物: ${relative(BIN)}${C.reset}`);
  say(`${C.dim}  启动: node ${relative(BIN)}${C.reset}`);
  process.exit(0);
}

// 7. 启动
step(opts.prompt ? '单次问答' : '交互式 REPL');

// 直接用 node 执行产物，避免依赖全局 link（未 link 时 kpbl 命令并不存在）。
const cliArgs = [BIN];
if (opts.prompt) cliArgs.push('-p', opts.prompt);
if (opts.model) cliArgs.push('-m', opts.model);
if (opts.apiKey) cliArgs.push('--api-key', opts.apiKey);
if (opts.baseUrl) cliArgs.push('--base-url', opts.baseUrl);
if (opts.debug) cliArgs.push('--debug');

const result = spawnSync('node', cliArgs, {
  cwd: process.cwd(),
  stdio: 'inherit',
  shell: false,
});

if (result.error) {
  fail(`启动失败: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 0);
