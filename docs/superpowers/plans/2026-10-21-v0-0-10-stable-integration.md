# v0.0.10 稳定整合实施计划

设计真源：[技术方案](../../design/003-v0.0.10-stable-integration.md)。状态：T01–T12 实现与本地门禁完成，任务项按已取得的本地证据勾选，不代表版本已发布；发布阻断项见 [验收记录](../../verification/v0.0.10.md)。保留现有工作区改动，不自动提交、推送或升版。

## 全局约束

Core Headless/零依赖；显式根兼容 rootDir；工具历史闭合；租约通过宿主/runner 内存上下文传递。wire 1.0 和历史 v2 不变；原请求选择响应 Schema；缺号/attach 失败使整个连接失效。使用已协商预算。旧端只取固定发布 tarball，候选从当前源码构建。Windows/Node 20/终端专项无证据不标通过。

## 任务与顺序

- [x] T01 固定 v0.0.9 三包 tarball、integrity、原始声明/文件清单；实现当前源码声明比较与通配入口盘点。先测缺失/篡改基线、声明差异和陈旧 dist，再实现；期望检查不写旧输入。
  证据：`scripts/fixtures/public-api/{v0.0.9,current.json,migration.json}` + `scripts/tests/public-api.test.ts`；`pnpm check-public-api` 通过，只读不写旧输入。
- [x] T02 记录最低 Node、ACL、PTY、进程树、MCP 与 soak 的可用环境/独立阻断项；无平台时记录 pending，不阻断无关编码。
  证据：`pnpm verify:platform` 的 `node20-channel`/`posix-pty` pending 与 `windows-acl`/`windows-conpty` not-applicable 独立登记；CI `minimum-runtime` 与三平台 matrix 通道已配置（尚未远端执行）。
- [x] T03 SessionConfig 根字段联合、SessionOptions 和迁移类型用例。先验证缺根/接口扩展类型失败、rootDir-only 与冲突运行行为；期望兼容有效旧调用。
  证据：`packages/core/tests/session-config.types.ts`（缺根/接口扩展编译失败、rootDir-only 有效）与 `stable-integration.test.ts`、`workspace-identity.test.ts` 运行用例。
- [x] T04 去除全局协调器；Session/CLI/daemon/SpawnContext/runner 显式传递。先写真实父子共享、独立 Session、不传/不一致零副作用用例；期望互斥/取消释放/引用不落盘。
  证据：`packages/core/tests/agent-runtime.test.ts`、`agent-budget-approval.test.ts`、`packages/cli/tests/local-host-resources.test.ts` 覆盖父子共享、独立会话、缺参零副作用拒绝；`sharedWorkspaceLeaseCoordinator` 已从公共面移除并登记。
- [x] T05 完整响应、快照类型/Schema/等价断言、原请求感知校验、cursor overload、attach 原子安装与失败收口、协商预算及 transport.setLimits。先重现每项缺陷；期望 V02/V03/V05/V06/V07 均覆盖且 wire 字段不变。
  证据：`packages/cli/tests/protocol-results.test.ts`、`client-results.types.ts`、`local-client.test.ts`、`local-host-session.test.ts` 覆盖 Schema 等价、cursor overload、attach 原子安装与整连接收口、协商预算与 `setLimits`；`pnpm check-protocol-contract` 冻结 v1.0。
- [x] T06 Core/Host code-first 错误与映射，取消四态/清理围栏。先写不同 message 同 code、未知异常脱敏、已结束 RUN_NOT_FOUND 用例；期望 V04/V08 及既有清理回归通过。
  证据：`packages/core/tests/session-errors.test.ts` 与 `packages/cli/src/protocol/errors.ts` 映射表；不同 message 同 code、未知异常脱敏、已结束 run 的 `RUN_NOT_FOUND`、`SESSION_CLEANUP_FAILED` 用例通过。
- [x] T07 固定旧新客户端/宿主四组合与 stdio/socket 兼容；保留旧 cursor 缺陷的版本相关预期。先测版本/契约不匹配；期望正常路径一致、非法路径明确失败。
  证据：`pnpm verify:compat` 4 组合 × 2 传输（normal + cursor）全部通过，旧 cursor 缺陷按版本相关预期断言；证据见 `.workbuddy/v0.0.10-compat/`。
- [x] T08 历史/配置迁移语料及源哈希、失败原子、重复恢复零重放。先覆盖旧输入和失败注入；期望 V11 与现有恢复/密钥分组测试通过。
  证据：`packages/core/tests/session-compat-corpus.test.ts` 与 `packages/cli/tests/settings-compat-corpus.test.ts` + `fixtures/compat/manifest.json`（sha256 固定、失败原子、重复恢复零重放）。
- [x] T09 复用确定性 Provider/本地三协议流，构建 12 类 SDK/CLI/host 组合回归。先断言缺陷及真实副作用；期望不需密钥且脚本完全消费。
- [x] T10 干净构建/三包隔离安装/导入和声明、三平台/Node 门禁。期望 pnpm verify/build 和可用真实平台通过，未知平台保留阻断证据。
  证据：`pnpm verify:platform` 在 macOS/Node 26.12.0 通过 environment/build/artifacts/stdio/daemon/tree/mcp；三包隔离安装与 ESM/CJS/声明/浏览器边界通过；Node 20、Windows、PTY 保持 pending 阻断证据。
- [x] T11 PR 10 轮/nightly 100/release 1000 且 30 分钟资源验证及边界预算。先测超额/泄漏检测，再实现分档工具；期望有原始日志和同 SHA 证据。
  证据：`pnpm verify:soak`（PR 10 轮）与 `--tier nightly`（100 轮）通过，`scripts/tests/verify-soak.test.ts` 证明泄漏/超额/残留被拒绝；release 档 1000 轮且 ≥30 分钟与冻结阈值仍 pending。
- [x] T12 SDK/协议/迁移/验收/发布文档、完整门禁与最终审查。期望所有已实现项可复查，未取得的发布证据明确列出，不提前发布。
  证据：`docs/sdk-compatibility.md`、`docs/local-protocol.md`、`docs/migration/v0.0.10.md`、`docs/verification/v0.0.10.md`、`docs/releases/v0.0.10.md`（标注未发布）+ 现役说明更新；`examples/` 补齐共享租约、受控取消、本地客户端三类装配。

## 接口依赖与预检

T03→T04：联合类型保留 rootDir，生产装配显式注入。T04→T09：runner context 只在内存传递，工具输入不可提供。T05→T06/T07：保持已发布 wire 码和方法形状，pending 保留请求变体。T01→T07/T10：固定旧 tarball 与候选构建分离。T05→T11：同一个 negotiatedLimits 驱动预算。T02→T10/T11：环境证据独立登记，不能从模拟测试推断通过。

工作日志位于忽略目录 `.workbuddy/v0.0.10-execution/progress.md`，记录 RED→GREEN、实际命令、裁决和未完成项。当前环境缺少 OpenSpec CLI 及 executing-plans 的部分共享辅助脚本，因此直接按本文件记录，不手工伪造 OpenSpec change，也不安装无关工具。
