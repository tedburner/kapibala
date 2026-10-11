# Tasks: v0.0.5 技能体系与过程输出折叠

状态：实现与本地验收于2026-10-11完成，并随 v0.0.5 发布（远端验收见验收记录文末）。按 design 的 D1–D10 与 specs 验收；功能、三协议、失败恢复、Windows/POSIX进程与终端、两项已授权真实模型验收证据及限制见 [验收记录](../../../docs/verification/v0.0.5.md)，兼容边界见 [迁移说明](../../../docs/migration/v0.0.5.md)。

## 1. 领域模型与 Frontmatter（skill-domain-contract；D1/D2）

- [x] 1.1 新增技能元数据、来源、调用控制、可用性、诊断、内容摘要和活动记录类型；验证 Core 根导出类型检查与中文 JSDoc。
- [x] 1.2 实现有界 Frontmatter 子集，覆盖 BOM/CRLF、引号/注释、块标量尾部语义、字符串/列表和一层 metadata；用真实多行样例及格式用例验证正文不损坏。
- [x] 1.3 实现缺省名称回退、描述长度诊断、重复键/非法布尔/畸形/YAML不支持结构拒绝；验证单技能失败不影响其他技能。
- [x] 1.4 实现调用控制和执行扩展兼容诊断，禁止 fork/hooks/动态 shell 等静默 inline；测试用户-only、模型-only及不可执行状态。
- [x] 1.5 实现128KiB文件/16KiB头部读取上限及 contentDigest；测试超限在受限读取中拒绝，并同步模块兼容说明。

## 2. 扫描、信任与注册表（skill-scanner-discovery / skill-registry-management；D3）

- [x] 2.1 实现根规范化与项目/全局原生及.agents发现，最大深度6/目录2000/条目20000及SKILL.md边界；测试根自身、权限错误、超限诊断和其他根继续。
- [x] 2.2 实现目录/文件软链与junction防环和物理边界；测试项目内链接可用、外部/破损链接拒绝及目录重复不遍历。
- [x] 2.3 实现默认忽略与声明目录隔离的.gitignore子集；验证否定规则、父目录排除、兄弟隔离及不支持模式诊断，说明非完整Git兼容。
- [x] 2.4 实现五级优先顺序、稳定排序、同物理文件去重与胜出/覆盖诊断；测试无效高层不遮蔽、有效禁用不回退和低层链接不抢身份。
- [x] 2.5 扩展CLI项目信任处理并提供Headless信任配置；验证无settings但有技能时需信任，非交互排除未信任来源且全局仍可用。
- [x] 2.6 提供Registry搜索/诊断/不可变快照，run开始刷新与变化错误；测试运行中编辑返回SKILL_CHANGED、并发Session隔离和恢复使用当前项目，更新宿主接口说明。
- [x] 2.7 接入skills.enabled/disabled默认值、类型校验及全局/已信任项目收紧合并；测试项目不能重启全局禁用、关闭不删历史和Headless不隐式读home，同步配置说明。

## 3. 目录预算与查询（skill-prompt-assembly；D4）

- [x] 3.1 实现L2.5整段Unicode估算预算、250 code points摘要及XML转义；验证中文32K窗口、特殊字符、完整标签、未知窗口和请求剩余空间。
- [x] 3.2 实现确定性整条遗漏及最小目录降级；测试空集合/加载工厂不可见/用户-only目录省略，遗漏提示成本计入预算。
- [x] 3.3 新增会话绑定list_skills工具工厂，query/cursor/limit默认20最大50与响应预算；验证遗漏技能可发现、旧游标拒绝、查询不读取正文或激活。
- [x] 3.4 同步PromptAssembler及会话实际请求/统计入口，不只改单次assemble；通过集成测试确认目录与实际加载集合一致，并更新预算说明。

## 4. 共享加载、落盘与事件（load-skill-builtin-tool；D1/D5）

- [x] 4.1 实现共享loader及load_skill工厂，校验调用方/信任/摘要/预算，返回完整正文与最多20资源名；测试错误为isError、正文预算拒绝和无资源预读。
- [x] 4.2 在AgentSession提供getSkills/runSkill宿主契约，共用run锁和生命周期；测试预检失败不追加任务、真实用户-only成功、模型不能伪造caller与跨会话隔离。
- [x] 4.3 在既有TextBlock/ToolResultBlock添加skillSource v1与原文件/包装文本摘要，用户原任务和正文分块在同一user消息一次append；验证两种Store往返、连续user规范化保留来源、Provider不发来源到wire且无孤立tool_result，不增加schema/记录类型。
- [x] 4.4 在最终非错误结果通过结果钩子/执行审计后按实际工具定义身份安装pending，消息提交后记skill.loaded并发skill_loaded；测试同名工具不能伪造、结果钩子/审计/存储失败不激活且不续执行，已落盘真实结果不回滚。
- [x] 4.5 在CLI tool-registration绑定会话工厂，覆盖无模型可调用技能、禁用工具和用户显式加载后资源工具可用；测试注册一致性并同步Headless用法。
- [x] 4.6 验证无Store以内存完整事务提交活动状态、事件标记memory且资源可用，旧/未知来源和自定义Store丢字段保留文本但不恢复授权；补充SDK内存/旧Store兼容用法。

## 5. 技能权限与资源（skill-execution-policy / skill-resource-access；D6/D7）

- [x] 5.1 实现固定工具别名及只收紧语义归一化；测试未知工具、Bash(git:*)拒绝及兼容诊断，不宽化执行能力。
- [x] 5.2 实现动态白名单交集，经PermissionPolicy.hardDenied裁决最终参数，技能控制工具声明builtin/fs:read并保留宿主deny；验证Plan不误拒、显式入口权限一致、未声明/空列表、交集及FullAccess/缓存不绕过。
- [x] 5.3 实现同批load成功后立即收紧、资源等落盘提交；验证load→write被拒、load→resource返回SKILL_NOT_COMMITTED且下一步可重试，失败加载不改变集合。
- [x] 5.4 新增read_skill_resource工厂及64KiB分段读取；验证全局references可读、普通read_file仍拒绝、绝对/UNC/盘符/../junction/二进制拒绝与截断标记。
- [x] 5.5 集成资源身份/正文摘要重核和读取审计；测试根或SKILL.md变化拒绝、资源更新记录本次事实，脚本执行仍走旧目标/审批规则。
- [x] 5.6 在完成/取消/异常/clear/切换/迭代提前结束后统一清理活动状态；测试等待工具回收及事务闭合再解锁，新任务不继承限制，更新权限/资源边界说明。
- [x] 5.7 落实错误类别/retryPolicy表并禁止加载器内部循环重试；验证未提交资源/过期游标immediate不进never缓存，变化/信任/正文预算after_user_action停止本轮，确定性非法/越界为never。

## 6. 上下文、压缩与恢复（skill-context-lifecycle；D8）

- [x] 6.1 接入实际模型投影与renderedDigest校验的present/requires_reload判定；测试旧调用存在但正文缺失、内容被改写但来源仍在和未知来源版本不误判有效，消息关联可追溯。
- [x] 6.2 保护当前run活动正文的完整事务和注入单元；测试一级/二级压缩、多个正文超预算明确结束、不破坏最近任务及工具闭合。
- [x] 6.3 实现旧轮次正文移出的结构化重载标记与去重失效；测试压缩成功需重载、压缩失败保留投影、重复有效加载可引用而仍闭合新事务。
- [x] 6.4 实现恢复当前发现/信任和新run重新激活；测试跨目录续答不恢复旧授权、不重放脚本，同步历史兼容与恢复说明。
- [x] 6.5 回归Anthropic签名与OpenAI不透明continuation约束；验证技能加载/资源/压缩/重复返回引用不重排被保护的前缀或工具链。

## 7. CLI 命令与有界视图（cli-skills-commands / cli-output-folding；D9）

- [x] 7.1 在COMMAND_CATALOG注册/skills只读和/skill变更rawTail，经ActiveSessionController.runSkill及宿主回调消费任务流；测试引号/空白/换行保留、用户-only/模型-only、缺任务/非法名称、忙碌/取消/切换、技能关闭可检查及--disable-shell不误关文件技能。
- [x] 7.2 在EventRenderer实现按真实block/tool事件关联的当前轮次过程缓存，默认1MiB；测试摘要/展开及截断标记，不影响Core历史。
- [x] 7.3 实现所有text_delta完整流式显示、错误/取消/预算/审批显式输出和skill_loaded展示；测试不把中途assistant文本当可隐藏过程。
- [x] 7.4 将Ctrl+O绑定CliInputCoordinator单一输入所有者；测试菜单/密钥/审批期间禁用、无秘密回显、Ctrl+C/EOF清理和finish幂等解绑。
- [x] 7.5 实现有界过程区重绘/resize与锚点失效详情快照降级；测试不擦写答案/审批/提示符/旧轮次，文档明确不回收任意scrollback。
- [x] 7.6 实现--output-detail summary|detailed并接入REPL/one-shot和帮助/薄壳参数转发；测试非TTY无ANSI、detailed无1MiB缓存截断、debug独立stderr及非法值运行前退出。
- [x] 7.7 同步用户命令、技能格式子集、权限差异、资源/脚本与终端详情文档；以用法检查及与specs交叉核对验收，不提前宣传未实现能力。

## 8. 跨领域验收与门禁

- [x] 8.1 执行pnpm verify（typecheck → test → lint，含check-architecture/check-secrets）；记录真实结果，不以build成功替代类型门禁。
- [x] 8.2 执行三协议工具/用户加载、错误/取消、压缩/恢复集成回归；确认canonical历史、消息级落盘和权限状态在全部入口一致。
- [x] 8.3 执行Windows/POSIX真实终端及非TTY进程验收，覆盖Ctrl+O/resize/审批/秘密输入/EOF与完整详情重定向；记录环境和无法覆盖项。
- [x] 8.4 在已配置模型上验证真实技能发现、触发、正文遵循和资源读取，覆盖用户显式及中文多行样例；记录模型/输入/结果与模型质量限制。
- [x] 8.5 完成v0.0.5迁移/验证记录与路线图状态同步，重新执行OpenSpec严格校验及能力映射；以已完成验收事实更新，不改基线章节编号、不执行Git提交或发布。

## Workflow follow-up

- 实施全部通过后，按用户后续指令处理规格同步、归档和发布；此处不提前归档或更新版本号。
