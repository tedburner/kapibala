# Spec Delta: MCP connection lifecycle

## Purpose

定义每个 MCP Server 的传输协商、可查询状态、连接代次和资源回收语义，使一个 Server 的启动或断连故障可局部诊断，同时保证超时和会话销毁不会留下不受管的本地请求或进程。

## ADDED Requirements

### Requirement: Two transports with explicit protocol modes
系统 SHALL 支持 Stdio 与 Streamable HTTP，并提供经过验收的 legacy/modern 协议模式；HTTP auto 协商和 Stdio 默认 legacy 的最终时代可诊断，不自动回退旧 HTTP+SSE。

#### Scenario: Modern server is explicitly selected
- **WHEN** 有效配置显式选择 modern 且服务端支持对应协议
- **THEN** 系统连接成功并报告该时代，不发送 legacy 请求冒充兼容

#### Scenario: Old SSE endpoint is configured
- **WHEN** 配置只提供不受支持的旧 SSE 传输
- **THEN** 系统报告传输不支持，不暗中探测其他端点或改写 URL

### Requirement: Bounded independent startup
系统 SHALL 对每 Server 启动和整体等待设置期限与有限并发；optional 失败保留诊断并允许内置任务，required 未就绪阻止任务，失败资源必须回收。

#### Scenario: Optional server never completes negotiation
- **WHEN** optional Server 到达启动截止仍未完成协商
- **THEN** 该 Server 标失败并清理，其他可用能力可继续，任务不会无限挂起

#### Scenario: Required discovery fails
- **WHEN** required Server 的初始工具目录失败或未在整体截止前就绪
- **THEN** 任务在模型请求前失败并给出诊断，不把空工具集当作成功

#### Scenario: Human startup authorization takes time
- **WHEN** 用户阅读启动审批超过连接技术期限
- **THEN** 不自动批准或拒绝，批准后再开始连接截止计时，审批仍可取消

#### Scenario: Server exposes prompts without tools
- **WHEN** Server 仅声明受支持 Prompt 能力并成功完成其目录发现
- **THEN** Server 可就绪且不强行调用未声明的工具发现方法

### Requirement: Connection readiness is separate from capability readiness
系统 SHALL 分离连接状态（disabled、blocked、connecting、ready、failed、disconnected、closing）与各能力状态（unsupported、pending、ready、stale、unavailable），连接 ready 不代表目录 ready。required Server 声明 Tools 时 SHALL 要求 Tools ready；Prompt-only Server SHALL 要求 Prompts ready。混合 Server 的 Prompt 失败不得撤销 ready Tools 或仅因 Prompt 失败阻止普通工具任务，但用户执行 Prompt 必须要求其 Prompts 目录 ready。

#### Scenario: Required mixed server has a failed prompt catalog
- **WHEN** required Server 的连接和 Tools ready，但 Prompts unavailable
- **THEN** 普通任务可使用已就绪 Tools，Prompt 获取被拒绝且目录失败如实显示，不将其冒充空目录或撤销 Tools

#### Scenario: Required prompt-only catalog is stale
- **WHEN** required Prompt-only Server 连接 ready，但其 Prompts 因通知未复核而 stale
- **THEN** required 判定不通过，新任务在模型请求前失败，不能仅凭连接状态放行

#### Scenario: Prompts cannot compensate for an unavailable required Tools capability
- **WHEN** required Server 声明 Tools 且其 Tools unavailable，而 Prompts ready
- **THEN** required 判定仍失败，不以 Prompt 可用替代 Tools 就绪

### Requirement: Stale connections cannot publish state
系统 SHALL 拒绝旧连接代次的关闭、目录响应或通知更新当前连接状态；Tools 与 Prompts 分别维护 catalogEpoch 和 refreshToken，每次重连建立独立身份。目录成功、目录失败及恢复资格的回调 SHALL 同时核对 client、connectionGeneration、能力类型、epoch 和 refreshToken，只有当前完整复核可提交；一类能力通知不改变另一类能力的 epoch 或 ready 状态。

#### Scenario: Old close event arrives after reconnect
- **WHEN** 新连接已就绪后旧连接发出迟到关闭回调
- **THEN** 新连接状态及工具目录保持不变

#### Scenario: Old discovery result arrives last
- **WHEN** 新连接目录已发布后旧连接发现响应到达
- **THEN** 旧目录被丢弃，不覆盖当前可用能力

#### Scenario: Prompt refresh failure is stale while Tools remain ready
- **WHEN** 旧 Prompt refreshToken 的失败在新 Prompt 目录发布后到达且 Tools 一直 ready
- **THEN** 新 Prompt 状态和 Tools 状态均不变，旧失败不能污染任一当前能力

### Requirement: Bounded teardown owns all resources
系统 SHALL 幂等关闭连接、监听器、定时器、本地在途请求及所拥有 Stdio 进程树；超期限强制回收并报告未清理失败，不以等待结束冒充回收成功。

#### Scenario: Wrapper owns a child server process
- **WHEN** Windows 或 POSIX 包装进程创建子 Server，随后 Session 销毁
- **THEN** 真实进程验收证明包装及所属子进程均被回收，销毁可安全重复

#### Scenario: Setup partially fails
- **WHEN** 插件取得部分资源后初始化抛错而未进入已装插件列表
- **THEN** 初始化路径自行清理已取得资源，不依赖之后的 Session teardown

### Requirement: Local cancellation does not imply remote rollback
系统 SHALL 为调用取消释放有界本地等待，必要时关闭连接；单次取消无需默认销毁所有 Server，远端副作用没有响应证据时不能声称回滚成功。

#### Scenario: Server ignores cancellation
- **WHEN** 已发送调用取消后 Server 不回应
- **THEN** 系统在本地清理期限内收口并按结果未知记录，不无限等候或报告未执行
