# 发布验收证据预检

`pnpm verify:release-evidence` 检查技术方案 §12.2 的六类专项。日常 `pnpm verify` 和当前 OS 平台门禁可以留下独立专项 `pending`；正式发布必须提供全部通过、对应同一最终候选 SHA 的审核清单。

预检验证证据索引及人工审核声明，不执行这些专项，也不验证链接内容本身。审核人必须先查看原始日志；不能修改旧报告的 SHA 来冒充新提交的验收。

## 清单格式

根对象包含 `schemaVersion: 1`、`commit`（候选提交完整 40 位小写 SHA）及 `checks` 数组。每个必需 ID 恰好出现一次，不接受未知或重复 ID。

| ID | coverage 必须包含 | 证据范围 |
|---|---|---|
| G-N20 | `node20` | Node 20 实际安装并运行候选三包、CLI 与子路径导入 |
| G-ACL | `windows-cross-user` | Windows 不同用户对凭证、元数据与 pipe 的访问拒绝 |
| G-PTY | `windows-conpty`、`macos-pty`、`linux-pty` | 各终端的分片、粘贴、审批、取消与异常恢复 |
| G-TREE | `windows-git-bash`、`windows-powershell`、`macos`、`linux` | 对应解释器/平台的受管进程树取消和退出 |
| G-MCP | `stdio`、`http` | 授权、调用、撤销、取消、关闭和重试 |
| G-SOAK | `release` | 正式 1000 轮且至少 30 分钟的长跑及审核后的冻结基线 |

每条记录必须包含以下字段：

| 字段 | 要求 |
|---|---|
| `id`、`coverage` | 上表中的专项与完整覆盖范围 |
| `commit` | 与根对象及命令的候选 SHA 完全一致 |
| `status` | 必须为 `passed`；pending、failed 和 not-applicable 均阻断 |
| `worktreeDirty`、`debugOverride` | 必须均为 `false` |
| `environment`、`command` | 实际 OS、Node、终端/解释器及执行命令 |
| `logs` | 至少一个可供审核人访问的 HTTPS 原始报告链接，不包含 URL 凭证 |
| `reviewer`、`reviewedAt` | 审核人及有效时间戳 |
| `rounds`、`durationMs`、`baselineReviewed` | G-SOAK 专用：至少 1000、至少 1800000、必须为 true |

一个专项跨多个环境时，应在 `logs` 中列出各环境的报告，`environment` 写明对应版本。以下仅示意单项格式，省略的五个专项也必须补齐；pending 示例不能通过预检：

```json
{
  "schemaVersion": 1,
  "commit": "<最终候选的完整40位SHA>",
  "checks": [
    {
      "id": "G-ACL",
      "coverage": ["windows-cross-user"],
      "commit": "<同一候选SHA>",
      "status": "pending",
      "worktreeDirty": false,
      "debugOverride": false,
      "environment": "<实际Windows、Node与用户隔离环境>",
      "command": "<实际执行命令>",
      "logs": ["https://<实际报告地址>"],
      "reviewer": "<审核人>",
      "reviewedAt": "<审核时间ISO8601>"
    }
  ]
}
```

## 本地与 CI

将审核清单保存在工作区外或忽略的 `.workbuddy/` 中；清单写入它所证明的提交会产生新的 SHA，不能靠提交自引用清单解决证据绑定。

```sh
pnpm verify:release-evidence --sha "$(git rev-parse HEAD)" --manifest /path/to/acceptance.json
```

Release 工作流从仓库变量 `KPBL_RELEASE_EVIDENCE` 读取同一份 JSON，在 prepare 阶段和发布前分别检查 `RELEASE_SHA`。变量缺失、格式错误、缺项或任何未达标记录都会使工作流失败；检查过程不打印原始清单。用户审核清单后可手动设置变量：

```sh
gh variable set KPBL_RELEASE_EVIDENCE < /path/to/acceptance.json
```

先冻结并提交性能基线，再创建最终升版提交；将该提交推送 main 完成自动门禁，并补齐该 SHA 的人工专项及正式长跑报告。审核并设置清单后才推送版本标签。升版或任何代码变更产生新 SHA 后，需要该 SHA 的真实报告，不能复用旧提交的通过声明。

v0.0.10 已使用维护者审核的完整清单发布，原始报告见[最终验收结果](verification/v0.0.10.md#6-最终发布结果2026-10-23)。新候选须重新采集并审核同 SHA 证据，不复用本版清单，不提供默认放行入口。
