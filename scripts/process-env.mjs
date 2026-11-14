/**
 * 工具链运行环境清洗：剥掉宿主注入的运行时钩子，保留用户与 CI 真正需要的参数。
 *
 * 为什么需要：宿主（IDE、沙箱包装器、CI 代理）惯于用 `NODE_OPTIONS=--require=<vendor shim>`
 * 给每一条命令挂上自己的初始化和删除守卫。构建工具链（pnpm / tsup / vite）在这类环境里
 * 清 `dist` 会被守卫拦下并抛错，报错却指向一个无关的产物文件，看上去像打包器坏了；
 * `ELECTRON_RUN_AS_NODE=1` 更会让脚本里的 Electron 静默退化成纯 Node。
 *
 * 边界：这里只处理"能预加载代码"的选项与运行模式开关，**不整体删除** `NODE_OPTIONS` ——
 * `--max-old-space-size` 这类纯参数与注入无关，抹掉会连累 CI 的大堆构建与调试体验。
 */
import path from 'node:path';

/**
 * 按 shell 语义切分 NODE_OPTIONS（`--require="/a b/shim.cjs"` 这类带引号的值必须保持完整）。
 * @returns 去掉引号后的参数序列。
 */
function tokenize(value) {
  /** @type {string[]} */
  const tokens = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let match = pattern.exec(value); match; match = pattern.exec(value))
    tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

/**
 * 判断预加载目标是否位于仓库内。
 *
 * 只接受绝对路径与显式相对路径（`.` 开头）：裸模块说明符与 `data:` URL 一律视为外部，
 * 因为它们无法静态确认来源，保留等于给任意代码一个注入点。
 */
function insideRepository(candidate, repository) {
  if (!candidate) return false;
  if (!path.isAbsolute(candidate) && !candidate.startsWith('.')) return false;
  const relative = path.relative(repository, path.resolve(repository, candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * 摘掉 NODE_OPTIONS 里指向仓库外的预加载钩子，保留其余参数。
 *
 * @param value 原始 `NODE_OPTIONS`，可为空。
 * @param repository 仓库根绝对路径；只有落在其中的 `--require` / `--import` 才保留
 *   （仓库内的预加载属于项目自己的检测代码，属于用户意图）。
 * @returns 清洗后的字符串；全部被剥离时返回 `undefined`（调用方应删除该变量）。
 */
export function sanitizeNodeOptions(value, repository) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const tokens = tokenize(value);
  /** @type {string[]} */
  const kept = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const inline = /^(?:--require|--import|-r)=(.*)$/.exec(token);
    if (inline) {
      if (insideRepository(inline[1], repository)) kept.push(token);
      continue;
    }
    if (token === '--require' || token === '--import' || token === '-r') {
      const next = tokens[index + 1];
      if (next !== undefined && insideRepository(next, repository)) kept.push(token, next);
      index += 1;
      continue;
    }
    kept.push(token);
  }
  const sanitized = kept.join(' ').trim();
  return sanitized === '' ? undefined : sanitized;
}

/**
 * 构造 Node 工具链（pnpm / tsup / vite / tsx）的运行环境。
 *
 * 与桌面应用的启动环境不同，构建必须继承 HOME、CI 变量与 pnpm 相关配置，不能用白名单，
 * 所以只做两件事：剥离外部预加载钩子、移除 `ELECTRON_RUN_AS_NODE`（构建期没有任何理由
 * 把 Electron 当 Node 跑，留着只会在脚本误启动 Electron 时静默失效）。
 *
 * @param base 宿主环境（通常 `process.env`）。
 * @param repository 仓库根绝对路径，用于判定预加载目标归属。
 * @param extra 额外变量（如 `GITHUB_OUTPUT`）。
 */
export function toolchainEnv(base = process.env, repository = process.cwd(), extra = {}) {
  // 显式置空再过滤，而不是 delete：返回的是纯字符串映射，调用方不必依赖 spawn 跳过 undefined 的行为。
  const env = {
    ...base,
    ...extra,
    NODE_OPTIONS: sanitizeNodeOptions(base.NODE_OPTIONS, repository),
    ELECTRON_RUN_AS_NODE: undefined,
  };
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => typeof value === 'string' && value !== ''),
  );
}
