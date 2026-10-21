# ADDED Requirements

### Requirement: 有界 JSONL

传输 MUST 用 UTF-8 增量解码及 LF 分帧、兼容 CRLF；单帧 MUST 不超过 1MiB，EOF 半帧 MUST 失败。

#### Scenario: Unicode 分片

- **WHEN** 中文 UTF-8 被拆包且字符串含 U+2028/U+2029
- **THEN** 完整解码，只按 LF 分帧

#### Scenario: 畸形流

- **WHEN** 发送超长无换行输入或 EOF 半帧
- **THEN** 有界失败，不无限保留输入

### Requirement: 认证与实例身份

socket/pipe MUST 初始化认证，token MUST 不进入 argv/日志/历史；daemon MUST 通过启动锁和实例握手识别进程。

#### Scenario: 无凭证连接

- **WHEN** socket 客户端未认证即请求会话
- **THEN** 拒绝且不泄露会话数据

#### Scenario: 重复启动与 PID 复用

- **WHEN** 启动记录存在且 PID 被复用
- **THEN** 不杀无关进程；仅健康实例匹配才复用

#### Scenario: stdio 关闭

- **WHEN** 父进程管道结束
- **THEN** 取消运行并清理，stdout 只包含协议帧

### Requirement: 预算与背压

服务端 MUST 集中公布并执行预算：5 秒初始化、64 在途请求/连接、16 连接、8 会话、4 运行、128 审批/会话、8MiB 快照/连接、4MiB 发送队列。

#### Scenario: 慢客户端

- **WHEN** write 返回 false 且对端仍发送 cancel
- **THEN** 读循环继续处理 cancel，队列溢出断开并要求重同步

#### Scenario: 资源耗尽

- **WHEN** 新请求超过会话或运行上限
- **THEN** 返回 RESOURCE_LIMIT，不隐式关闭既有会话

