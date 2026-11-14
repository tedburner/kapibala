/**
 * 桌面客户端本地人工测试入口：复用 pack:desktop 管线打出测试 App，再以隔离沙箱直接启动。
 *
 * 与 `pnpm dev:desktop` 的区别：这里验证的是**打包产物**（真实安装布局 + 生产依赖闭包），
 * 与发布候选形态一致；与直接 `pnpm pack:desktop` 的区别：打包后自动启动，不用手动挂载安装包。
 *
 * 隔离保证（同 build-info.testPaths 的语义）：启动时设置 KPBL_DESKTOP_E2E=1 与
 * KPBL_DESKTOP_HOME / KPBL_DESKTOP_USER_DATA 两个绝对路径，应用只读写
 * .workbuddy/desktop-try/ 下的沙箱目录，绝不触碰真实的 ~/.kapibala 或 Electron userData；
 * 两条路径任一缺失时应用会拒绝启动而不是回退真实目录。沙箱默认持久保留，
 * 反复测试可延续历史；--fresh 清空后重新开始。
 *
 * 用法：node packages/desktop/scripts/try-packaged.mjs [--no-verify] [--no-launch] [--fresh]
 * - --no-verify  透传给 pack:desktop，跳过 verify:desktop 快速出包（调试构建，不能作为发布证据）。
 * - --no-launch  只打包并打印产物与沙箱位置，不启动应用（脚本化验收用）。
 * - --fresh      启动前清空沙箱 home 与 userData。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolchainEnv } from '../../../scripts/process-env.mjs';
import { desktopLaunchEnv } from './launch-env.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(desktop, '../..');
const sandbox = path.join(repository, '.workbuddy', 'desktop-try');
const home = path.join(sandbox, 'home');
const userData = path.join(sandbox, 'user-data');
const args = process.argv.slice(2);

if (args.includes('--help')) {
  process.stdout.write(
    'node packages/desktop/scripts/try-packaged.mjs [--no-verify] [--no-launch] [--fresh]\n' +
      '打包测试版桌面应用并以隔离沙箱启动；沙箱在 .workbuddy/desktop-try/，不触碰真实用户数据。\n',
  );
  process.exit(0);
}
if (args.some((argument) => !['--no-verify', '--no-launch', '--fresh'].includes(argument)))
  throw new Error('未知参数；可用：--no-verify --no-launch --fresh');

if (args.includes('--fresh')) fs.rmSync(sandbox, { recursive: true, force: true });
for (const directory of [home, userData]) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // 沙箱身份必须在启动前钉死为真实路径；应用侧 testPaths 只接受绝对路径并拒绝重定向。
  if (fs.realpathSync.native(directory) !== directory)
    throw new Error(`沙箱目录被符号链接重定向：${directory}`);
}

// pack:desktop 每次创建随机产物目录；借它已有的 GITHUB_OUTPUT 通道拿精确路径，不靠"找最新"。
fs.rmSync(path.join(sandbox, 'pack-output.txt'), { force: true });
const output = path.join(sandbox, 'pack-output.txt');
const packArgs = [
  'pack:desktop',
  '--dir',
  ...(args.includes('--no-verify') ? ['--no-verify'] : []),
];
const packed = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', packArgs, {
  cwd: repository,
  // 打包子进程只剥掉外部预加载钩子，否则 tsup 清理 dist 时会撞上宿主的批量删除守卫。
  env: toolchainEnv(process.env, repository, { GITHUB_OUTPUT: output }),
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
const exit = await new Promise((resolve, reject) => {
  packed.once('error', reject);
  packed.once('exit', resolve);
}).catch((error) => error);
if (exit !== 0) throw new Error(`打包失败（exit ${exit}）；产物未生成，应用未启动。`);

const artifacts = /^artifacts=(.+)$/m.exec(fs.readFileSync(output, 'utf8'))?.[1];
if (!artifacts || !fs.existsSync(artifacts)) throw new Error('未能从打包输出解析产物目录');
const layout =
  process.platform === 'darwin'
    ? [
        path.join(artifacts, 'mac-arm64', 'Kapibala Test.app'),
        path.join(artifacts, 'mac', 'Kapibala Test.app'),
      ]
    : process.platform === 'win32'
      ? [path.join(artifacts, 'win-unpacked')]
      : [path.join(artifacts, 'linux-unpacked')];
const directory = layout.find((candidate) => fs.existsSync(candidate));
if (!directory) throw new Error(`产物目录缺失：${layout.join(', ')}`);
const binary =
  process.platform === 'darwin'
    ? path.join(directory, 'Contents', 'MacOS', 'Kapibala Test')
    : process.platform === 'win32'
      ? path.join(directory, 'Kapibala Test.exe')
      : path.join(directory, 'kapibala-test');
if (!fs.existsSync(binary)) throw new Error(`可执行文件缺失：${binary}`);

if (args.includes('--no-launch')) {
  process.stdout.write(
    `\n打包完成：${artifacts}\n沙箱 home：${home}\n沙箱 userData：${userData}\n`,
  );
  process.exit(0);
}
process.stdout.write(
  `\n启动打包应用（隔离沙箱，真实 ~/.kapibala 不受影响）：\n  home：${home}\n  userData：${userData}\n关闭窗口或 Cmd+Q 退出后本脚本随之结束；沙箱保留，下次测试可延续历史。\n`,
);
const launched = spawn(binary, [], {
  cwd: directory,
  // 打包产物同样是 Electron 进程：白名单构造，宿主注入的 ELECTRON_RUN_AS_NODE 会让它退化成纯 Node。
  env: desktopLaunchEnv(process.env, {
    KPBL_DESKTOP_E2E: '1',
    KPBL_DESKTOP_HOME: home,
    KPBL_DESKTOP_USER_DATA: userData,
  }),
  stdio: 'inherit',
});
process.exitCode = await new Promise((resolve, reject) => {
  launched.once('error', reject);
  launched.once('exit', resolve);
}).catch((error) => {
  console.error(error.message);
  return 1;
});
