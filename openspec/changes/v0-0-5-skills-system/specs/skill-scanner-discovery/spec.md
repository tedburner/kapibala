# Skill Scanner Discovery

## Purpose

为项目与用户技能建立可预测且有边界的发现行为，使合法技能能够被识别，同时阻止未信任项目、链接越界或无界目录遍历把意外内容送入模型，并向宿主报告无法扫描的原因。

## ADDED Requirements

### Requirement: Skill roots and package boundary
系统 SHALL 发现项目及全局原生 skills 目录、.agents/skills 和显式内置技能。含 SKILL.md 的目录 SHALL 作为单一技能边界并停止向下发现技能；扫描根本身也 SHALL 检查。

#### Scenario: References contain another skill file
- **WHEN** 已发现技能的 references 子目录中存在 SKILL.md
- **THEN** 该文件不另行注册为技能

### Requirement: Trust independent of configuration presence
项目技能进入模型目录或正文前 MUST 通过当前物理项目身份的信任裁决，不得依赖项目 settings 文件存在。非交互或 Headless 宿主未提供信任时 MUST 排除未信任项目技能并报告原因；其他可信来源 SHALL 仍可用。

#### Scenario: Untrusted project without settings
- **WHEN** 仓库只有 .agents/skills，尚未信任且没有项目 settings
- **THEN** 项目技能不进入提示词或可执行集合，宿主可看到信任缺失原因

### Requirement: Bounded deterministic traversal
每个根 SHALL 使用稳定路径顺序，默认深度不超过 6、目录不超过 2000、条目不超过 20000。超限、权限错误和破损链接 SHALL 诊断，循环及重复物理路径 SHALL 跳过；扫描失败不得扩大边界或阻断其他根。

#### Scenario: Directory limit reached
- **WHEN** 当前根扫描到默认目录上限
- **THEN** 停止该根的后续遍历并标记不完整，其他根继续扫描

### Requirement: Physical link boundaries
项目子链接 MUST 留在规范后的项目根内，全局子链接 MUST 留在配置的物理全局根内，目录与文件链接及 Windows junction 均适用。显式根可以自身为链接；防环 MUST NOT 被当作越界授权。

#### Scenario: External junction
- **WHEN** 项目技能路径经 junction 指向项目根外
- **THEN** 不把该候选送入模型且报告路径边界诊断

### Requirement: Scoped ignore rules
系统 SHALL 默认跳过 .git、node_modules、dist，并按声明目录继承 .gitignore 的普通路径、/ 锚点、目录标记、*、**、?、! 和注释/前导转义子集。已排除父目录不递归，兄弟规则不得串用；不支持的模式 MUST 诊断并忽略该条，不宣称完整 Git ignore 兼容。

#### Scenario: Unsupported ignore expression
- **WHEN** .gitignore 使用首期不支持的字符类
- **THEN** 给出兼容诊断并忽略该规则，仍执行默认排除与支持的其他规则
