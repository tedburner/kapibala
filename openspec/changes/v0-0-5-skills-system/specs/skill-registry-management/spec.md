# Skill Registry Management

## Purpose

为不同来源的技能提供稳定的名称解析、搜索和诊断，使宿主能够解释哪个版本生效、哪些候选被覆盖，以及当前运行为何不能加载某个技能，同时防止会话之间共享活动权限或运行中混用目录版本。

## ADDED Requirements

### Requirement: Explicit source precedence
同名有效可信候选 SHALL 按 project-native > project-agents > global-native > global-agents > builtin 胜出；同层候选 SHALL 按路径 code point 排序稳定裁决。无效或未信任候选不得覆盖有效低层候选；有效高层显式禁用 MUST 保持禁用，不回退启用低层副本。

#### Scenario: Native project skill wins
- **WHEN** 项目原生目录、项目 .agents 及全局目录均有同名技能
- **THEN** 项目原生候选生效，并提供胜出与被覆盖路径诊断

#### Scenario: High-priority skill disabled
- **WHEN** 有效高层同名技能被显式禁用
- **THEN** 该名称保持禁用，不启用全局副本

### Requirement: Physical deduplication preserves precedence
系统 SHALL 先按来源优先级确定物理候选身份，再去重同物理文件，避免低优先级链接先扫描而抢占高层身份。

#### Scenario: Same file through multiple roots
- **WHEN** 全局链接与项目路径指向同一文件
- **THEN** 只注册一次并保留按明确优先级胜出的来源

### Requirement: Search and diagnostics surfaces
宿主 SHALL 查询名称、完整描述、来源、调用控制、参数提示、不可用/被覆盖原因和目录遗漏状态。模型查询 MUST 仅返回可信、模型可调用且未被禁用的候选。诊断输出 SHALL 可安全展示。

#### Scenario: Model requests user-only skill listing
- **WHEN** 模型搜索仅允许用户触发的技能
- **THEN** 模型列表不返回该技能，宿主仍可查看其状态

### Requirement: Per-run immutable snapshot
系统 SHALL 在运行开始刷新候选并固定本轮来源和正文摘要。加载发现路径或内容变化 MUST 返回 SKILL_CHANGED，不混用新正文；下一运行 SHALL 刷新。并发会话 SHALL 隔离活动状态，恢复 SHALL 重新发现并使用当前信任。

#### Scenario: File changes during a run
- **WHEN** 快照建立后 SKILL.md 被修改
- **THEN** 本轮加载报告变化，下一运行重新建立快照

### Requirement: Disabling only narrows project configuration
技能配置 SHALL 支持enabled默认true与disabled默认空；已信任项目只能进一步关闭或增加禁用，全局/项目enabled取逻辑与、disabled取并集。关闭不得删除历史。Headless宿主 SHALL 明确提供根/启用/禁用/信任，不隐式扫描home；非法类型 MUST 走既有配置错误路径。

#### Scenario: Project tries to re-enable globally disabled skills
- **WHEN** 全局关闭技能而项目enabled=true，或项目清空disabled
- **THEN** 全局关闭/禁用仍生效，项目不能扩大可用集合
