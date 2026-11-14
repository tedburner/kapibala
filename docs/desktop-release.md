# 桌面候选构建与发布

当前代码已接入签名、候选、附件校验及发布编排，尚未使用真实证书运行远端候选。不能据本地策略测试宣称签名、公证、跨平台安装或正式发布完成。桌面版本随工作区同步（以各包清单与 `CLI_VERSION` 为准）；desktop 保持 private，npm 发布集合仍是 Core、MCP、CLI 三包。

## 发布口径（2026-11-14，先读这一节）

维护者决定 v0.1.0 以**未签名个人自用版**交付：代码签名、公证、桌面人工安装证据与六类人工验收清单都不再是发布前置。未签名在 Electron 开源项目里是常规形态，Gatekeeper/SmartScreen 只是首次打开多一步，不构成发布门槛。

- `release.yml` 默认跳过 `verify:release-evidence`（只打印 workflow warning），把仓库变量 `KPBL_RELEASE_STRICT` 设为 `true` 即恢复六类专项的同 SHA 审核清单强制检查；
- 桌面附件默认不随 Release 附带（跳过 `desktop-candidate download`），需要时把仓库变量 `KPBL_DESKTOP_RELEASE` 设为 `true`；
- 未签名测试包由维护者本机 `pnpm pack:desktop` 生成后手工上传，产物名带 `Test`、appId 为 `dev.kapibala.desktop.test`；
- **自动化门禁一项没放宽**：`verify` 工作流的 ubuntu/macos/windows 矩阵（含 Windows ConPTY 与进程树断言）、Node 20 安装、compat、release 长跑、`verify:desktop` 的 mac/win e2e 与 registry 安装 smoke 仍然必须通过；
- 本文第 1 至 3 节描述的是**签名候选**的严格流程，仍然有效，但不是 v0.1.0 的阻塞项。

未签名包在 macOS 需右键打开或 `xattr -dr com.apple.quarantine`，Windows 会触发 SmartScreen。仓库不得据此宣称桌面正式发布、签名或跨平台安装验收完成。

## 1. 受控候选

`.github/workflows/desktop-candidate.yml` 仅手动触发，不发布 npm 或 GitHub Release。首次需维护者审核并手动提交、推送到 main，使工作流可见。版本发布流程会同步根、Core、MCP、CLI、desktop 五份清单和 CLI_VERSION，版本计算仍只在 `scripts/release.ts`。

先完成发布文档，经维护者运行既有 `pnpm release 0.1.0` 交互升版，再手动推送 main 等待 Verify。以升版提交的完整 SHA 触发候选，暂不推送版本标签。入口要求分支为 main、输入 SHA 等于触发时 main HEAD，工作区干净；不能从任意 PR 或本机环境带入证书生成正式候选。main 后续变动时不能用变更后的工作流触发旧 SHA 构建，需明确重定候选或保留原冻结运行。

四个原生任务：macos-15/arm64、macos-15-intel/x64、windows-2025/x64、ubuntu-24.04/x64。每个任务核验 `process.platform/arch`，Linux 使用 xvfb，不加 `--no-sandbox`。runner 标签依据 [GitHub 官方清单](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)，平台范围仍须实际安装验收。

配置 GitHub Environments，并限制为 main、启用所需人工保护：

| 环境 | 必需凭证 |
|---|---|
| `desktop-macos` | `CSC_LINK`（证书）、`CSC_KEY_PASSWORD`、`CSC_NAME`（完整 Developer ID Application 主体）、`APPLE_TEAM_ID`、`APPLE_API_KEY_BASE64`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER` |
| `desktop-windows` | `CSC_LINK`、`CSC_KEY_PASSWORD`、`KPBL_WINDOWS_SIGNER_THUMBPRINT`（审核的签名证书指纹） |
| `desktop-linux` | 无 OS 代码签名凭证，仍执行来源、验证与附件门禁 |

macOS API key 仅写入 runner 临时文件，结束后删除。候选子进程仅显式继承签名所需字段，不继承模型凭证或发布令牌；测试打包仍剥离签名字段。证书身份、公证配置参考 [electron-builder macOS](https://www.electron.build/v26/docs/mac/)及[公证文档](https://www.electron.build/v26/docs/notarization/)。

候选命令禁止 `--dir`、`--no-verify`、`--native-dmg`。CSC_NAME 保存完整审核主体；传给 builder 的 selector 单独去掉 Developer ID Application 类型前缀，最终 codesign Authority 仍核对完整主体，不要求维护者修改凭证展示名称。macOS 启用 hardened runtime、entitlements 和 Developer ID 签名，验证应用团队/主体、codesign、Gatekeeper 和装订；DMG 另提交 notarytool，要求 Accepted 后装订并验证。Windows 开启代码签名，核验应用和 NSIS 签名状态与预期指纹。缺凭证或验证失败均阻断，不能自动变成正式未签名包。

安装副本 smoke 使用标准 `HOME/USERPROFILE` 与 `--user-data-dir` 隔离，并断言实际 userData；不启用候选禁止的专用测试目录覆盖。它不代替 NSIS 安装/升级/卸载、Gatekeeper 下载隔离标志、通知权限或人工平台验收。

## 2. 不可变附件与审核

> 本节只在启用签名附件流程（`KPBL_DESKTOP_RELEASE=true`）时构成发布要求；未签名自用版跳过本节，改由本机 `pnpm pack:desktop` 产出并手工上传测试包。

上传 artifact 名称固定 `desktop-<platform>-<arch>-<完整SHA>-<runAttempt>`，30 天保留，包含安装器、ZIP、许可、哈希和 `candidate-build.json`。过期后不能重建替代已审核附件；应重新生成并审核候选。`candidate-build.json` 记录完整 SHA、dirty=false、验证状态、平台/架构、run ID/attempt、实际签名身份，以及缺失许可状态。生成许可不等于人工审核。

审核人先下载实际四个平台附件，执行安装、启动、升级、卸载、用户数据保留与原生交互验收，再向原 `KPBL_RELEASE_EVIDENCE` JSON 增加 `desktop` 对象：

- `schemaVersion: 1`、`commit`、`version`、`reviewer`、`reviewedAt`、`licenseReviewed: true`。
- `gates` 必须有 `FLOW / IPC / STATE / CONFIG / LIFECYCLE / RENDER / PACKAGE / SOAK`。每项要求 passed、同 SHA、四个目标 coverage、HTTPS logs、worktreeDirty=false、debugOverride=false；SOAK 至少 1000 轮/30 分钟。该要求不替代原六类专项。
- `artifacts` 恰好覆盖 `darwin-arm64 / darwin-x64 / win32-x64 / linux-x64`。每条有 `target / runId / runAttempt / artifactId / artifactName / artifactDigest`、`installationReviewed: true`、`signing: {verified:true, identity:<实际主体或指纹>}`；Linux 的 identity 为 `not-required`。
- 每条 `files` 列出 artifact 中所有普通文件的原始相对名称与 SHA256，包括 `candidate-build.json` 和许可附件；不可只列安装器。artifactDigest 使用上传结果的 `sha256:...`，不能用某个内部文件摘要代替整个 archive 摘要。

```sh
pnpm verify:release-evidence --sha <完整候选SHA> --desktop-version 0.1.0 --manifest <审核清单>
```

原六项不齐、任意桌面专项 pending、缺平台、未审许可或附件不匹配都阻断。本文不是通过清单，不提供默认通过的示例值。

## 3. 发布同一批字节

人工审核并设置证据变量后，维护者再手动推送同一标签。Release 在 prepare 与 publish 两次检查证据：默认跳过（个人自用版口径），`KPBL_RELEASE_STRICT=true` 时按六类原专项强制校验；`KPBL_DESKTOP_RELEASE=true` 时才下载审核的 artifact ID，核对仓库、工作流路径、workflow_dispatch、成功结论、SHA、run attempt、archive digest、候选元数据及逐文件哈希；拒绝额外文件、替换字节、目录逃逸或符号链接。

校验完成后才发布原三份 npm 包，桌面不重新构建、签名或上传新候选。GitHub Release 中桌面附件加 `desktop-<target>__` 前缀并将子目录分隔替换为 `__`，避免四平台的同名许可/清单冲突；只复制、改上传名称，字节和 SHA256 保持不变。命名映射须结合审核的原始 `files` 使用。artifact 的机制与生命周期参考 [GitHub 官方说明](https://docs.github.com/en/actions/tutorials/store-and-share-data)。

所有提交、推送、环境/凭证配置和最终发布仍由维护者执行。本地自动验证只证明实现拒绝了错误输入，不证明这些外部步骤已经完成。
