# GitHub Actions 自动发布

工作流文件为 `.github/workflows/release.yml`。推送稳定版本标签后，固定发布源提交，复用 `verify.yml` 执行 Windows/Linux 构建与完整门禁，再在 Ubuntu 构建、打包、依次发布 Core 和 CLI、验证 registry 安装，最后创建 GitHub Release 并附压缩包和 SHA256 校验文件。

## npm 一次性配置

分别在 `@kiturone/kapibala` 和 `@kiturone/kapibala-cli` 的 Settings → Trusted Publisher 中建立连接：

| 字段 | 值 |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `tedburner` |
| Repository | `kapibala` |
| Workflow filename | `release.yml`，不要填写目录 |
| Environment name | 留空，与当前工作流一致 |
| Allowed actions | 勾选 `Allow npm publish` |

发布 job 使用 GitHub 托管 runner、Node 24 和支持 OIDC 的 npm（最低 11.5.1），声明 `id-token: write`。不需要配置 `NPM_TOKEN` Secret，也不调用 `npm login` 或用 `npm whoami` 判断 OIDC 状态。npm 自动生成 provenance。协议与配置要求见 [npm 官方文档](https://docs.npmjs.com/trusted-publishers/)。

## 发布新版本

1. 在 `main` 上准备并提交 `docs/releases/vX.Y.Z.md`，同步迁移与验收说明。可先运行 `pnpm release --scaffold` 生成骨架；发布前必须补全占位内容。补丁位、次版本位只用 0–9，例如 `v0.0.9` 后为 `v0.1.0`。
2. 确保工作区干净且本地 `main` 不落后远端，运行 `pnpm release [version]`。脚本同步根、Core、CLI 的 `package.json` 和 `CLI_VERSION`，运行 `pnpm verify`，经交互确认后创建 `:bookmark: 发布 vX.Y.Z` 提交及附注标签。可先用 `pnpm release --dry-run` 查看计划；非交互调用必须显式传入 `--yes`。
3. 手动推送分两步：先 `git push origin main` 并在 Actions 确认该提交的 Verify 工作流通过，再推标签——标签指向同一提交，提前在 `main` 上暴露门禁失败，避免为过门禁而移动已推送的标签。发布源提交必须先包含在远端 `main`。下例仅说明下一版的操作，不代表当前已经实现 v0.0.4：

```bash
git push origin main
git push origin v0.0.4
```

查看 GitHub Actions → Release。两平台门禁有任何失败，均不会进入 npm 发布 job。实际打包使用 `pnpm pack`，将 CLI 的 `workspace:*` 转换为精确 Core 版本；Core 继续保持运行时零依赖。发布 job 的安装使用 `pnpm install --frozen-lockfile`，不复用构建产物或依赖缓存。

`v0.0.3` 已通过本地流程发布，其标签不包含本自动发布工作流；本工作流从后续包含这些文件的新版本开始使用，不要为验证配置而重发旧版本或移动已有标签。

## 中断与重试

可以在失败运行上选择 Re-run jobs，也可以在 Actions → Release → Run workflow 输入同一个已有标签。重试会重新校验固定源提交与版本；同一时间仅允许一个发布流程运行。

两个包在上传前都要通过 registry 预检。HTTP 404 表示包不存在；网络、鉴权、服务或非法元数据错误会中止，不能伪装成未发布。已经发布的同版本包只有在 SHA512 integrity 与本次产物一致、`latest` 指向正确版本时才跳过，继续完成另一个包；不覆盖已发布版本，也不把 `latest` 回退到旧版本。

npm 接收上传后可能延迟公开，脚本最多等候每个包 10 分钟。registry API 确认可见后，CDN 边缘对 packument 的缓存还可能落后数分钟：冒烟安装对 `ETARGET`/`notarget`（版本尚不可见）做最多 10 次、每次间隔 30 秒的退避重试，网络、鉴权等其他错误仍立即中止。传播超时或重试耗尽后可重试整个工作流；若发现已发布包内容不同，必须人工核实并使用新版本，不能绕过校验。OIDC 不授权 `npm dist-tag` 等设置命令，已有版本的错误标签也需要人工核实修复。

npm 两包均公开、校验值一致且隔离安装通过后才创建 GitHub Release。重试可补齐同标签的 Release 资产并完成未发布的草稿，正式 Release 的正文保留。运行末尾保存打包产物为 Actions artifact，便于检查失败原因。

仓库文件、脚本测试和静态检查通过不等于已实测 npm OIDC；首次真正验证要在配置完成、工作流上传后发布一个新的版本。GitHub/npm 没有跨服务的原子发布事务，Core 已成功而 CLI 失败时保留 Core，按上述规则续跑。
