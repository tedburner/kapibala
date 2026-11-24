# AGENTS.md — `scripts/` 构建、门禁与发布脚本约束

- 版本推演与工作区版本读取的唯一实现在 `scripts/release.ts`（`nextVersion` / `readWorkspaceVersion`），不要在别处另写逻辑；分支与发布编排在 `scripts/flow.ts`。
- `scripts/dev.mjs` 是跨平台开发入口唯一真源（`scripts/dev.sh` 与纯 ASCII 的 `scripts/dev.cmd` 仅薄壳转发）；`--verify-only` 必须与 `pnpm verify` 同源（`typecheck → test → lint`，含 `check-secrets`），严禁漏掉 lint 或密钥扫描。
- 运行构建工具链的子进程必须经 `scripts/process-env.mjs` 的 `toolchainEnv()` 清洗宿主注入的预加载钩子（禁止 `env: { ...process.env }`）；`scripts/build.mjs` 与 `scripts/dev-desktop.mjs` 负责在清洗环境后再拉起打包器，避免宿主删除守卫误拦清理 `dist`。
