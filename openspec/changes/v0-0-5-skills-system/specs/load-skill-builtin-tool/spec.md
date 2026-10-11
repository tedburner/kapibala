# Load Skill Builtin Tool

## Purpose

为模型按需加载与用户显式调用提供一致的技能校验和正文注入行为，使加载结果能够在完整会话历史中被追溯，并在失败、取消或持久化异常时保留合法工具事务和清楚的可用状态。

## ADDED Requirements

### Requirement: Shared validated loading
模型与宿主用户入口 SHALL 共享来源、信任、调用控制、正文摘要及预算校验。模型 schema MUST NOT 接受 caller、trusted 或任意根路径，不能伪装真实用户入口。不存在、不可用、禁止调用或文件变化 SHALL 返回结构化错误。

#### Scenario: Model tries user-only skill
- **WHEN** 模型通过工具请求用户专用技能
- **THEN** 返回明确错误且不激活，真实用户入口仍按用户控制校验

### Requirement: Full bounded body and resource hint
成功加载 SHALL 返回完整正文、名称、来源、contentDigest、compatibility、资源基准和最多 20 个资源路径及遗漏标记，不预读资源。正文无法放入输入预算 MUST 拒绝，不截断后声称成功。重复返回引用必须满足当前投影有效性规则。

#### Scenario: Body exceeds remaining input space
- **WHEN** 完整技能正文无法放入当前输入预算
- **THEN** 返回预算错误且不创建成功活动状态，不注入部分指令

### Requirement: Canonical persistence for both callers
模型加载 MUST 按普通工具闭合tool_use/tool_result，有Store时消息级append，无Store时提交完整内存历史。用户显式路径 MUST 在同一条本轮user消息保存原始任务块和带来源的技能正文块，一次提交后才开始模型；不得伪造无对应调用的工具结果。所有Provider SHALL 消费规范化历史，来源不得进入wire或转换成system授权。

#### Scenario: User explicitly activates a skill
- **WHEN** 宿主处理合法用户技能命令
- **THEN** 原任务与技能正文来源可追溯，模型无需再调用工具，历史不出现孤立 tool_result

### Requirement: Durable success event
系统 SHALL 在消息提交后记录skill.loaded审计，包含身份、摘要、来源、调用方及运行/消息关联，不包含正文。skill_loaded MUST 在关联消息与审计成功后发布；有Store时需append成功，无Store时需完整内存事务提交并标识persistence=memory。失败 MUST 停止后续调用、闭合事务并清理状态，已落盘真实结果不得回滚。

#### Scenario: Persistence fails after loader execution
- **WHEN** 正文生成后消息存储失败
- **THEN** 宿主不收到成功加载事件，后续工具不执行，事务按已有失败规则处理

#### Scenario: Headless session without message store
- **WHEN** 未配置MessageStore的宿主成功加载并把完整事务加入内存历史
- **THEN** 可提交本轮活动状态与资源资格，事件明确内存模式，不宣称已落盘

#### Scenario: Commit audit fails
- **WHEN** 消息append成功但skill.loaded审计失败
- **THEN** 保留已提交真实消息，不发成功事件或继续执行，本轮状态清理

### Requirement: Session-bound loader instances
不同会话 SHALL 绑定各自发现集合、活动状态、审计和信任；不得共享全局可变加载状态。无模型可调用技能时 SHALL 不注册空加载工具。

#### Scenario: Concurrent sessions load same name
- **WHEN** 两个会话在不同项目加载同名技能
- **THEN** 各自使用自己的胜出正文和权限状态

### Requirement: Structured retry boundaries
未提交资源和过期游标 SHALL 标为immediate，允许下一步修正且不进入never缓存；目录变化、信任缺失和正文预算不足 SHALL 为after_user_action，需新运行。未知/禁止/不支持/非法参数/资源越界/技能拒绝 SHALL 为never。加载器 MUST 不自行循环重试，审计/存储失败沿用既有类别。

#### Scenario: Resource requested before commit then retried
- **WHEN** 同批次资源调用返回SKILL_NOT_COMMITTED且批次随后成功提交
- **THEN** 下一步合法资源调用可以成功，不被相同失败参数缓存永久拦截
