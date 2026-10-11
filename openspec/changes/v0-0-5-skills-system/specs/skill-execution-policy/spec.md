# Skill Execution Policy

## Purpose

让技能声明成为运行期间可验证的最小工具限制，与已有模式、审批及路径规则共同裁决执行，使加载多个技能或恢复历史时不会意外扩大权限，并确保所有终止路径回收运行级活动状态。

## ADDED Requirements

### Requirement: Restrictions never grant permission
技能工具声明 MUST 只收紧既有权限，不新增预批准授权；兼容 allowed-tools SHALL 给出语义诊断。未声明不额外限制，显式空列表只允许技能控制工具；多活动技能声明白名单 SHALL 取交集。既有拒绝、路径检查、FullAccess 与审批缓存 MUST 不被绕过。

#### Scenario: Approval cache conflicts with skill
- **WHEN** 宿主缓存允许写文件，而活动技能不允许写工具
- **THEN** 写操作仍被拒绝，不能通过再次审批解除技能限制

#### Scenario: Multiple active skills
- **WHEN** 两个技能分别允许 read_file/write_file 和 read_file/run_command
- **THEN** 业务工具仅 read_file 能进入后续既有权限裁决

### Requirement: Safe tool name normalization
系统 SHALL 支持实际工具名及固定 Read/Write/Glob/Grep/Bash 别名；未知工具或参数模式 MUST 拒绝激活并说明迁移办法。Bash(git:*) MUST NOT 被降级为允许全部命令。控制工具 load_skill/list_skills/read_skill_resource SHALL 不参与业务交集，但继续执行自身和既有权限规则，不能写入或执行代码。

#### Scenario: Parameter-specific imported tool rule
- **WHEN** 技能限制包含 Bash(git:*)
- **THEN** 激活拒绝并提示迁移到精确宿主权限，不允许全量 run_command

### Requirement: Final-input enforcement within batch
执行 SHALL 在最终参数完成钩子改写后裁决。加载收紧 MUST 在最终结果通过结果钩子/执行审计且非错误后、同批后续工具前生效；状态只能由实际工厂定义身份建立，不可按同名或结果文本伪造。提交前不得新增资源资格；失败加载不改变集合，审计/存储失败 MUST 停止后续并闭合结果。

#### Scenario: Load followed by write in one batch
- **WHEN** 同一 assistant 批次先加载只读技能再调用 write_file
- **THEN** 写工具在执行前被拒绝，所有调用都有闭合结果

#### Scenario: Result hook rejects loader result
- **WHEN** loader生成正文后tool:after失败使最终结果为isError
- **THEN** 不安装该技能的活动限制或资源资格，不发布成功事件

#### Scenario: Same-named replacement tool
- **WHEN** 宿主注册同名自定义工具并返回仿技能正文
- **THEN** 不能仅凭名称/文本取得受信任技能活动状态

### Requirement: Read capability and host permission parity
技能控制工具 SHALL 声明只读能力并服从现有模式与宿主deny；技能拒绝 SHALL 作为优先于审批/缓存的硬限制。真实用户加载 SHALL 通过等价权限裁决，不能绕过宿主关闭技能或读取拒绝。

#### Scenario: Loader in Plan mode
- **WHEN** Plan宿主未额外禁止读取且技能可信可用
- **THEN** 只读加载/查询/资源操作不会因遗漏能力声明被误拒，写入与执行仍按原规则禁止

#### Scenario: Explicit invocation conflicts with host deny
- **WHEN** 用户显式调用技能而宿主禁止技能加载或对应读取能力
- **THEN** 用户入口同样拒绝，不因caller=user越过宿主限制

### Requirement: Run-bound activation and cleanup
限制 SHALL 绑定当前运行且只能累加，模型不能解除。结束、取消、异常、clear、切换及迭代器提前退出 MUST 等待工具清理和事务闭合后清空。新运行和历史恢复 MUST 重新激活，旧正文/摘要不作为权限。

#### Scenario: Consumer closes event iterator
- **WHEN** 消费者在工具执行期间提前结束事件迭代
- **THEN** 取消并等待工具清理、闭合历史后清空技能状态再释放会话锁

#### Scenario: New run after restricted task
- **WHEN** 已完成只读技能任务后开始新任务
- **THEN** 上轮限制不泄漏，新任务依据本轮明确激活与原权限执行
