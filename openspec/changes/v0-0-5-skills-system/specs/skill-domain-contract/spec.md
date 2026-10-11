# Skill Domain Contract

## Purpose

定义可复用技能文件的格式、公开元数据与调用控制，使模型和宿主可以一致判断技能用途、来源及兼容性，并在格式错误或执行扩展不支持时取得明确诊断，避免缺失指令或静默改变技能原意。

## ADDED Requirements

### Requirement: Common frontmatter forms
系统 SHALL 支持 UTF-8 BOM、LF/CRLF、普通及单双引号字符串、布尔值、引号外注释、字符串数组/列表、一层 metadata 映射，以及 |、|-、|+、>、>-、>+ 块标量。正文中的分隔线 MUST 保留；重复键、畸形结构、非法布尔及 YAML tag/anchor/alias/merge MUST 拒绝且诊断局限于该技能。

#### Scenario: Multiline description
- **WHEN** 技能通过折叠或保留换行的块标量声明 description
- **THEN** 系统按声明语义提取完整描述，不把 > 或 | 当成描述，不损坏正文

#### Scenario: Malformed metadata
- **WHEN** 文件包含重复 disable-model-invocation 或非法布尔
- **THEN** 该技能不可执行并给出解析诊断，其他合法技能仍可发现

### Requirement: Metadata validation
系统 SHALL 拒绝空白/非字符串 description 和非法名称；name 缺省可回退合法目录名并警告，目录名不匹配 SHALL 警告。名称 SHALL 为 1–64 个小写 ASCII kebab-case 字符。description 超过 1024 code points 或 compatibility 超过 500 SHALL 警告并保留原值，目录展示另行缩短。

#### Scenario: Missing name
- **WHEN** name 缺省而目录名合法且 description 有效
- **THEN** 系统以目录名注册并报告兼容回退

### Requirement: Independent invocation controls
系统 SHALL 对模型和用户分别提供可调用性、名称、描述、来源、参数提示和可用原因。disable-model-invocation=true MUST 禁止模型加载但不禁止真实用户入口；user-invocable=false MUST 禁止用户入口但不独立禁止模型。未知普通元数据 SHALL 保留并诊断。

#### Scenario: User-only skill
- **WHEN** disable-model-invocation=true 且 user-invocable 未禁用
- **THEN** 模型目录不展示且模型加载拒绝，宿主用户入口仍可调用

### Requirement: Unsupported execution extensions
系统 MUST 对 context: fork、hooks、model、agent、shell 或动态执行插值等首期不支持的执行语义标记不可执行并给出迁移原因；MUST NOT 静默降级 inline 或执行插值。标准 allowed-tools 字符串及兼容列表 SHALL 保留供限制归一化，并明确不新增预批准授权。

#### Scenario: Fork skill imported
- **WHEN** 技能声明 context: fork
- **THEN** 用户能查看不支持原因，系统不把它当普通 inline 技能执行

### Requirement: Bounded file parsing
系统 SHALL 在受限读取中执行默认 128 KiB 文件、16 KiB frontmatter 上限；超过边界 MUST 拒绝并诊断，不先全量读取后才检查。

#### Scenario: Oversized skill
- **WHEN** SKILL.md 超过文件上限
- **THEN** 不加载正文，返回明确超限诊断且不影响其他技能
