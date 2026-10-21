# ADDED Requirements

### Requirement: 版本协商与校验

服务端 MUST 在执行任何业务请求前完成认证与协议版本协商，所有 wire 输入 MUST 从 unknown 做运行时校验，拒绝 batch。

#### Scenario: major 不匹配

- **WHEN** 客户端声明不支持的 major
- **THEN** 返回 PROTOCOL_MISMATCH，不创建会话或执行工具

#### Scenario: 非法消息

- **WHEN** 客户端发送 batch、缺字段或非法参数
- **THEN** 返回标准 JSON-RPC 错误，敏感输入不回显

### Requirement: 纯协议子路径

CLI MUST 提供独立 protocol 子路径，且 MUST NOT 导入 Node、Core 实现、终端或启动副作用；Node client 子路径 MUST 独立可导入。

#### Scenario: 安装后导入

- **WHEN** 从 CLI tarball 安装后导入 protocol/client
- **THEN** DTO 声明与 ESM 路径可解析，无 REPL、配置读取或进程启动

#### Scenario: 依赖违规

- **WHEN** protocol 引入 node:fs 或终端模块
- **THEN** 架构与独立类型门禁失败

### Requirement: 事件身份与错误

事件 MUST 带 instance/session/streamEpoch/seq；seq MUST 在流内递增，业务错误 MUST 使用稳定 data.code。

#### Scenario: 旧流事件

- **WHEN** 客户端重建后收到旧 instance 或 epoch 的通知
- **THEN** 不修改当前视图

#### Scenario: 重复与缺号

- **WHEN** 事件重复或跳过 seq
- **THEN** 重复忽略，缺号暂停应用并请求重同步

