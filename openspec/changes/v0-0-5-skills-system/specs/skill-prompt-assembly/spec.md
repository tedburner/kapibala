# Skill Prompt Assembly

## Purpose

向模型提供轻量、稳定且预算受控的技能发现目录，使中文和特殊字符技能也可预测地占用上下文，并为未进入常驻目录的技能保留查询路径，避免预算控制导致功能永久不可发现。

## ADDED Requirements

### Requirement: Catalog matches actual loader availability
模型技能目录 SHALL 位于工具段之后、环境段之前，且仅在匹配当前技能集合的加载工具可见时出现。空集合、仅用户可调用集合或加载工具不可见时 MUST 省略目录及不可用调用引导。

#### Scenario: Loader hidden by host
- **WHEN** 宿主关闭工具或隐藏加载工具
- **THEN** 提示词不引导模型调用该工具或加载技能

### Requirement: Estimate complete serialized catalog
目录默认 SHALL 使用 min(2000, floor(contextWindow × 1%)) 估算 token 预算，并计入标题、引导、XML、转义、条目及遗漏提示，兼顾请求剩余输入空间。非 ASCII MUST 按现有 Unicode 保守估算；未知窗口 SHALL 使用既有窗口解析并标注估算，不得宣称精确 tokenizer 上限。

#### Scenario: Chinese catalog
- **WHEN** 32K 窗口下的目录主要由中文描述组成
- **THEN** 完整目录估算不超过约 320 tokens，不使用四倍字符预算冒充 1% token 上限

### Requirement: Deterministic complete-entry truncation
目录 SHALL 按来源优先级及名称稳定排序，单条 description 不超过 250 code points；元数据 MUST XML 转义，不切割完整 Unicode 字符。超限 MUST 删除完整条目并预留遗漏提示；最小目录放不下时 SHALL 省略目录而保留工具查询引导。

#### Scenario: Description contains XML delimiters
- **WHEN** 描述含 <、>、& 或引号
- **THEN** 生成可闭合的转义目录，预算计入转义后的文本

### Requirement: Search omitted skills
模型 SHALL 通过 list_skills 的 query/cursor/limit 查询预算遗漏技能；默认每页最多20、请求最大50，完整响应默认最多1000估算tokens且受请求剩余空间限制。游标 MUST 按实际返回推进，最小响应放不下 MUST 明确报错。查询不得加载正文或激活权限。失效快照游标 MUST 明确拒绝，加载集合 SHALL 包含可信查询可见的遗漏技能。

#### Scenario: Skill omitted from L2.5
- **WHEN** 已发现的可信模型可调用技能因目录预算未展示
- **THEN** 模型仍能查询并按名称加载它，正文保持按需读取
