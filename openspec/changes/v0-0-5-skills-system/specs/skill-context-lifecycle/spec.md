# Skill Context Lifecycle

## Purpose

跟踪已加载技能正文在实际模型上下文中的有效性，使运行中的技能指导不会在压缩后悄然消失，并让重复加载和历史恢复依据当前内容与权限重新判断，避免仅凭曾经加载记录继续执行。

## ADDED Requirements

### Requirement: Projection-aware activation records
系统 SHALL 关联技能来源、正文摘要、运行身份及消息/工具调用来源，并按实际模型请求判断正文 present 或 requires_reload。文本标签、旧调用名或历史加载记录 MUST NOT 独立证明正文有效或授权。

#### Scenario: Only old load call survives
- **WHEN** 投影只保留历史调用名称而没有正文
- **THEN** 技能标记 requires_reload，不返回“正文已在上下文”去重结果

### Requirement: Protect active instruction units
当前运行已激活正文所属完整工具事务或宿主注入单元 MUST 不被一级剪裁或二级摘要覆盖。保留正文后仍无法满足输入预算 MUST 显式结束为预算超限，不能丢掉指导继续执行，也不得破坏工具闭合、签名或不透明续答约束。

#### Scenario: Active bodies cannot fit
- **WHEN** 当前活动正文与必要上下文超过输入预算
- **THEN** 返回预算超限并保持完整历史，不移除活动规则后继续任务

### Requirement: Reload marker after older context removal
旧运行正文可随完整轮次压缩；移出时 SHALL 保留明确正文丢失/使用前重载标记。成功压缩 SHALL 更新投影状态并失效去重；失败压缩 SHALL 保留有效旧投影与状态，不制造正文丢失事实。

#### Scenario: Old skill body summarized
- **WHEN** 完整旧轮次被摘要覆盖且其中含技能正文
- **THEN** 当前上下文提示相应技能需重载，后续加载返回完整正文

### Requirement: Deduplication requires current content
重复加载仅当同来源/contentDigest 的完整正文仍在实际投影且当前运行激活合法时 SHALL 可返回 already_present 引用，仍需闭合新调用。正文移出、来源改变或新运行未激活 MUST 重新核验与激活，不用“曾经加载”替代。

#### Scenario: Same body requested twice
- **WHEN** 本轮再次加载相同且仍在投影中的已提交技能
- **THEN** 可返回关联来源引用，不重复注入正文，新的工具事务仍完整落盘

### Requirement: Restore facts without replay or permission
会话恢复 SHALL 使用当前项目、目录快照和信任，恢复正文来源事实但不恢复活动授权，MUST NOT 重放工具。新运行使用历史技能指导前 SHALL 重新激活。

#### Scenario: Session resumed in another workspace
- **WHEN** 历史会话在不同项目目录恢复
- **THEN** 不沿用旧技能目录授权，不重放旧脚本，根据当前项目重新发现与激活

### Requirement: Content-block provenance compatibility
来源 SHALL 使用既有文本/工具结果块可选skillSource v1并记录原文件及完整包装正文摘要，不增加消息角色、块类型、会话记录类型或schema版本。两种内置Store往返 SHALL 保留来源，规范化 SHALL 保留块与原消息关联，Provider仅发送既有正文。缺来源/未知版本/摘要不匹配 SHALL 保留历史文本但禁用有效正文去重和恢复授权。

#### Scenario: Legacy JSONL round trip
- **WHEN** 带技能来源的正文通过旧JSONLMessageStore保存和恢复
- **THEN** content内来源可往返，无需会话顶层新字段或schema迁移

#### Scenario: Custom store strips optional metadata
- **WHEN** 自定义Store恢复正文时丢弃skillSource
- **THEN** 历史仍可阅读，但使用技能需重新加载，不从正文标签猜测授权

#### Scenario: Text altered while source survives
- **WHEN** 请求投影里的正文被改写但旧skillSource仍在
- **THEN** renderedDigest不匹配，判requires_reload而不是already_present
