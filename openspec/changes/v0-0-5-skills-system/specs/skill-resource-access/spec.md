# Skill Resource Access

## Purpose

为技能配套文本资源建立独立且受控的读取入口，使全局技能的引用可以在工作区之外按需访问，同时维持普通文件工具的工作区沙箱，防止资源路径或链接被用于读任意文件、写入或绕过脚本审批。

## ADDED Requirements

### Requirement: Active committed skill resources
系统 SHALL 提供read_skill_resource(name,path,startLine?,endLine?,offset?)，只读取当前运行已提交活动技能的文本资源。根 MUST 由可信技能身份解析，模型不得指定任意根。未提交状态 MUST 返回SKILL_NOT_COMMITTED，完整事务提交后下一步可重试；有Store需append成功，无Store需内存历史完整提交。

#### Scenario: Global reference read
- **WHEN** 已提交的全局技能引用 references/guide.md
- **THEN** 可受控读取该资源，而普通 read_file 仍拒绝工作区外路径

#### Scenario: Same batch premature resource request
- **WHEN** 同批次刚加载技能但工具结果尚未落盘即读取其资源
- **THEN** 返回 SKILL_NOT_COMMITTED，不提前授予资源资格

### Requirement: Lexical and physical boundaries
资源访问 MUST 拒绝绝对路径、盘符/UNC、.. 越界、目录、二进制文本读取以及离开技能根的软链/junction。访问前 SHALL 重核真实根与活动正文摘要；根或 SKILL.md 变化 MUST 要求新运行刷新，不能继续沿旧身份授权。

#### Scenario: Symlink escapes skill root
- **WHEN** references 文件实际指向技能根外
- **THEN** 读取拒绝并给出边界错误，不返回目标正文

### Requirement: Bounded partial resource reads
单次资源文本 SHALL 默认最多 64 KiB，支持行范围和后续分段读取；截断 MUST 明确标记并返回 UTF-8 字符边界的 nextOffset。offset SHALL 用于字节续读且不得与行范围混用，以支持超长单行资源。清单不得预读资源。资源本身变更 SHALL 记录本次读取事实，不暗中修改活动技能指令。

#### Scenario: Large reference document
- **WHEN** 引用文件超过单次返回上限
- **THEN** 返回有界内容与截断提示，调用方可继续读取后续范围

### Requirement: Read permission is not execution permission
资源入口 MUST 只读，不执行脚本或动态插值，不扩大普通文件工具范围。脚本执行 SHALL 经过既有命令工具、活动技能限制、目标校验和审批；不支持的项目外执行 SHALL 明确提示工作区迁移，不自动批准。

#### Scenario: Skill references an external script
- **WHEN** 全局技能要求运行 scripts/action.py
- **THEN** 资源可按规则读取，执行不能借加载权限免审批或绕过执行目标限制
