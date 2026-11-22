/**
 * 「escape 类」敏感路径清单（016 §4.2 / §13.1 决议 3）：向这些位置写入等于取得 CI 执行权
 * 或完成凭据注入，属「跨边界」行为而非普通工作区写入。
 *
 * 与硬禁区（`sandbox.ts` 的 `isProtectedWorkspacePath`）刻意区分：
 * - 硬禁区命中 → 三档一致直接 `deny`，不进入审批（写入即不可逆提权）；
 * - 本清单命中 → 风险类别升为 `escape`，Auto / Approval 一律询问，FullAccess 放行并审计。
 *
 * 边界：纯函数、只做词法匹配，不读取文件系统；按 `/` 归一并统一小写，
 * Windows 大小写变体与嵌套目录（如 `sub/.npmrc`）同样命中——宁可多问一次，不可漏判。
 */
export function isEscapeClassPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  // `.github/workflows/**`：写入即定义 CI 流程，推送后获得远程代码执行面。
  if (normalized.startsWith('.github/workflows/') || normalized.includes('/.github/workflows/'))
    return true;
  // 凭据与注册表配置按 basename 匹配（与 `.env` 同口径，任意目录深度）。
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base === '.npmrc' || base === '.netrc' || base === '.git-credentials';
}
