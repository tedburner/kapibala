# Spec Delta: MCP package delivery

## Purpose

定义 MCP 扩展的可安装包边界、公开契约兼容和完整工程门禁，使新增能力在本地工作区、编译产物与用户安装环境中表现一致，并保留 Core 的零运行时依赖及宿主隔离承诺。

## ADDED Requirements

### Requirement: Independent headless extension package
系统 SHALL 交付独立 MCP 包且只通过 Core 公共导出接入；Core 保持无外部运行时依赖，扩展包不依赖 CLI/终端或 Core 内部路径，SDK 类型不泄漏至 Core。

#### Scenario: Consumer installs only Core
- **WHEN** SDK 消费者只安装 Core 并创建无 MCP 会话
- **THEN** 不需要 MCP SDK、扩展包或终端依赖，旧问答可以运行

#### Scenario: Extension imports host internals
- **WHEN** 扩展代码新增 CLI/终端或 Core 内部路径依赖
- **THEN** 架构门禁失败，不能凭构建成功作为通过

### Requirement: Workspace verification covers the new package
工程门禁 SHALL 实际收集新增包的类型、测试和架构/密钥检查；开发入口按现有跨平台规则修复新增 workspace 链接并能完成构建验证。

#### Scenario: New extension contains a type error
- **WHEN** 新包源代码或测试有类型错误而打包器仍能构建
- **THEN** pnpm verify 的 typecheck 阶段失败，不能漏掉新包

#### Scenario: Windows dependency link is an empty directory
- **WHEN** CLI/MCP 的多层 workspace 依赖链接（CLI→MCP、MCP→Core、CLI→Core）退化为空目录
- **THEN** 开发入口（scripts/dev.mjs）按统一拓扑映射检测并用 Windows native junction 全部自愈重建，后续模块解析可用

### Requirement: Published artifacts form one compatible release
发布验证 SHALL 统一覆盖五处版本真源（根 `package.json`、Core、MCP、CLI 的 `package.json` 及 `CLI_VERSION`），按 Core→MCP→CLI 顺序交付并检查打包后内部依赖精确版本、产物清单与安装运行结果；外部可信发布配置缺失必须报告未验收。

#### Scenario: MCP artifact has a mismatched Core dependency
- **WHEN** 打包后的 MCP 依赖版本与当前发行版不一致或五处版本真源未对齐
- **THEN** 发布前检查拒绝产物，不在发布时临时忽略

#### Scenario: Clean installation consumes all three packages
- **WHEN** 在独立临时目录安装本地打包或已发布的三包产物
- **THEN** CLI 版本、MCP 公共 API 和一次受控工具调用均可运行，Core 无运行时依赖

### Requirement: Documentation distinguishes planning and evidence
文档 SHALL 明确规划、实现、验收和发布状态，记录模拟与真实 Server/模型验证边界；新增公开契约同步中文职责/约束注释，规划不自动变更版本或执行 Git 提交/推送。

#### Scenario: Only mock integration has passed
- **WHEN** 本地模拟用例通过而外部 Server 或付费模型未验证
- **THEN** 验收记录明确未验证项，不称作外部兼容或发布完成
