# Proposal: v0.0.5 技能体系与过程输出折叠

## Why

Kapibala 需要把项目与个人工作规程从常驻系统提示词拆成可发现、按需加载的技能，并为长工具任务提供清楚的过程摘要。完整能力还必须覆盖资源访问、执行权限和压缩后的有效性，避免“正文已加载却无法读引用”或“规则已丢失仍继续执行”。

## What Changes

- 支持 Agent Skills 常用 Frontmatter 子集、用户/模型调用控制和兼容诊断；不承诺完整 YAML、fork、动态 shell 或任意厂商插件执行。
- 有界发现项目/全局原生及 .agents 目录，项目原生优先；信任独立于 settings 文件，同名覆盖与物理去重可诊断。
- L2.5 以 UnicodeTokenEstimator 估算完整片段，默认 min(2000, floor(contextWindow × 1%)) tokens；新增 list_skills 查询预算遗漏。
- 共享加载服务支持 load_skill 与宿主显式调用，完整正文有大小/输入预算约束，历史闭合、消息提交、审计及 skill_loaded 事件保持一致；来源放在现有文本/工具结果块的可选字段，不新增会话schema，兼容旧Store与无Store宿主。
- 技能 allowedTools 在当前 run 只收紧权限，多技能取交集；同一工具批次后续调用即受限制，结束/取消/异常/切换后清理。
- 新增 read_skill_resource 读取已提交活动技能的引用，允许受控全局资源访问；保持普通文件沙箱与脚本审批边界。
- 关联正文来源与实际模型投影，保护活动正文，压缩后标记重载并失效去重；恢复不恢复授权、不重放工具。
- CLI 支持 /skills [query]、/skill <name> <task...>、来自注册表的补全、当前轮次摘要/详情切换和 --output-detail summary|detailed。任务保留原始文本并经活动会话控制器，非TTY detailed提供完整公开过程，debug保持独立。新增skills.enabled/disabled配置，项目只进一步关闭或禁用；--disable-shell不整体关闭技能。
- 输出缓存与重绘有界，统一输入所有权，错误/审批/回答显式可见；完整历史 TUI 仍留在 v0.0.8。

## Capabilities

### New Capabilities

- `skill-domain-contract`: 格式、元数据、调用控制及兼容诊断。
- `skill-scanner-discovery`: 信任、有界扫描、忽略与物理路径边界。
- `skill-registry-management`: 确定性覆盖、快照、查询与诊断。
- `skill-prompt-assembly`: 估算目录预算、转义与遗漏发现。
- `load-skill-builtin-tool`: 共享加载、完整正文、事务、落盘及事件。
- `skill-execution-policy`: 仅收紧的运行级限制与清理。
- `skill-resource-access`: 受控资源读取和独立脚本执行边界。
- `skill-context-lifecycle`: 正文有效性、压缩、去重和恢复。
- `cli-skills-commands`: 列表、显式任务调用、补全及忙碌约束。
- `cli-output-folding`: 有界过程展示、输入协调及非 TTY 完整详情。

### Modified Capabilities

无。当前 openspec/specs 清单为空，本变更以新增能力定义上述契约；既有历史、权限和 Headless 不变量继续作为约束，不借本变更重写其他版本的未归档规范。

## Impact

- Core 新增 capabilities/skills、会话绑定工具工厂和公开宿主接口；接入 PromptAssembler、AgentSession、ToolExecutor、ContextManager 与 SessionEvent。运行时不新增外部依赖。
- CLI 修改 index/tool-registration/project-trust/input-coordinator/ui/events，新增技能命令及详情选项。默认思考展示由全文改为摘要，用户可显式选择详细模式。
- 不迁移历史工具执行状态；恢复使用当前项目和信任裁决。目录缺失时原问答可继续。
- 实施门禁为 pnpm verify（typecheck → test → lint，含架构/密钥检查），并补充多协议、资源、权限、压缩、取消与真实终端集成验收。
- 架构依据见 [技术方案](../../../docs/superpowers/specs/2026-10-08-v0-0-5-skills-system-design.md)，可执行决策见 [design](design.md)，进度见 [tasks](tasks.md)。
