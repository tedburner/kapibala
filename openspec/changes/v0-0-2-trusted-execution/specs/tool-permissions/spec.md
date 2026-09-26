# Spec Delta

## Purpose

在每一次工具执行前对实际工具和最终参数作统一裁决，让用户能够按会话模式控制自动执行范围，同时确保项目内容和模型输出不能自行扩大权限。

## ADDED Requirements

### Requirement: 四态会话模式具有稳定含义
系统 SHALL 提供 `Approval`、`Plan`、`Auto`、`FullAccess` 四态。`Approval` 默认放行沙箱内只读操作并询问写入、执行、网络和危险工具；`Plan` 拒绝写入、执行、网络而不弹审批；`Auto` 默认放行沙箱内读写并询问执行、网络和危险工具；`FullAccess` 默认放行已注册且已声明能力的工具。模式切换 MUST NOT 自动注册工具或绕过宿主硬边界。

CLI 的 `FullAccess` SHALL 只允许当前会话主动选择：`/mode full-access` 需明确确认，命令行 `--permission full-access` 视为本次显式选择；用户级默认设置及项目设置 MUST NOT 自动进入该模式。宿主 SHALL 持续展示当前模式；SDK 宿主须在本次会话显式设置 `FullAccess`。

#### Scenario: Plan 拒绝写入
- **WHEN** 模型在 `Plan` 下调用写入工具
- **THEN** 工具未执行，返回权限拒绝的错误结果，不弹人工审批

#### Scenario: FullAccess 不覆盖显式关闭
- **WHEN** 宿主显式关闭 `run_command`，随后会话切换至 `FullAccess`
- **THEN** `run_command` 不出现在可用工具列表，也不能执行

#### Scenario: 配置文件要求默认 FullAccess
- **WHEN** 用户级或项目级设置包含 `FullAccess` 默认模式
- **THEN** CLI 不自动进入 `FullAccess`，采用 `Approval` 并显示配置诊断

### Requirement: 模型工具清单反映当前可执行范围
每次模型请求的工具清单 SHALL 根据当前模式、显式关闭和整项 `deny` 规则生成。`Plan` 中禁止执行的工具及被整项拒绝的工具不得向模型展示；直接通过 SDK 或旧历史引用这些工具仍 SHALL 经执行前权限门拒绝。空闲时切换模式后下一次模型请求 MUST 使用更新后的清单。

#### Scenario: Plan 模式下命令工具不可见
- **WHEN** `run_command` 已注册且会话处于 `Plan`
- **THEN** 下一次模型请求不包含 `run_command`；若仍收到该工具调用，执行前返回拒绝结果

### Requirement: 明确规则先于模式默认值
对一次调用，系统 SHALL 先应用宿主硬限制与 `Plan` 限制，再应用任何匹配的 `deny`（含会话拒绝缓存），然后应用显式 `ask`，最后考虑已批准的会话缓存、可信来源的 `allow` 与模式默认值。项目指令文本 MUST NOT 成为授权规则；未获信任的项目配置 MUST NOT 贡献 `allow`。未声明能力的工具 MUST NOT 因 `FullAccess` 自动放行。

#### Scenario: FullAccess 中的显式拒绝
- **WHEN** 已注册工具在 `FullAccess` 下命中显式 `deny`
- **THEN** 调用被拒绝并记录命中规则，不进入人工审批

#### Scenario: FullAccess 中的显式询问
- **WHEN** 已注册工具在 `FullAccess` 下命中显式 `ask`
- **THEN** 系统请求人工审批；无法交互时拒绝执行

#### Scenario: 未声明能力
- **WHEN** 工具未声明所需能力
- **THEN** 系统要求人工审批；无法交互时拒绝执行，不从模式推断安全性

### Requirement: Shell 规则不得依赖不可靠前缀分析
v0.0.2 的 `run_command` 规则 SHALL 只支持整项工具 `deny/ask`，以及绑定解释器和规范化工作目录的完整命令 `allow/ask/deny`。Shell 命令前缀和通配符规则 MUST NOT 用于授权或拦截；泛化的工具名或 `exec` capability 的 `allow` MUST NOT 越过命令的默认询问，除非会话明确处于 `FullAccess`。若配置含不支持的 Shell 前缀或通配符规则，加载 SHALL 明确失败并定位该规则，不得忽略后继续执行命令。

#### Scenario: 组合命令试图绕过拒绝
- **WHEN** 配置含不支持的 `rm` 前缀拒绝规则，而模型准备提交 `echo ok; rm -rf target`
- **THEN** 系统在接受该配置时已明确失败，不能以规则被忽略的状态进入可执行会话

#### Scenario: 泛化 allow 规则
- **WHEN** `Approval` 下配置只含工具名或 `exec` capability 的 `allow`，模型调用 `run_command`
- **THEN** 该命令仍需人工审批，除非另有匹配最终命令、解释器与工作目录的精确允许规则

### Requirement: 按最终调用内容授权
系统 SHALL 在所有允许修改工具参数的前置处理完成后，对最终工具名、能力和参数裁决；裁决后执行所用参数 MUST 与已授权参数一致。Shell 审批 SHALL 显示最终完整命令、规范化工作目录、实际解释器及授予范围，并生成绑定这些字段、受限环境指纹和执行策略的指纹；启动前重算，发生变化时重新裁决。每个工具调用均 SHALL 经过该入口，包括 SDK 注册工具。

#### Scenario: Hook 改写路径
- **WHEN** 前置处理将读取路径改写为另一目标
- **THEN** 权限策略基于改写后的目标重新裁决，原参数的批准不覆盖新目标

#### Scenario: 审批后工作目录改变
- **WHEN** 用户批准 Shell 命令后，启动前工作目录真实路径或解释器身份发生变化
- **THEN** 原批准无效，命令不以变化后的目标启动，并重新请求审批或返回明确错误

### Requirement: 人工审批与会话记忆
审批通道 SHALL 由宿主注入，支持仅本次允许、本会话允许和本会话拒绝。会话记忆 SHALL 绑定工具、能力及规范化后的调用范围，并且 MUST NOT 覆盖显式 `deny`、显式 `ask` 或硬限制。Shell 的会话允许 SHALL 额外绑定解释器身份、真实工作目录、完整命令、受限环境指纹及执行策略；对无法可靠绑定的外部脚本目标只能提供仅本次允许。非交互环境对需要询问的调用 SHALL 默认拒绝。

#### Scenario: 缓存范围改变
- **WHEN** 用户曾允许某个文件写入调用，但下一次调用的目标路径不同
- **THEN** 旧批准不自动覆盖新路径

### Requirement: 现有文件边界继续生效
模式自动放行和人工批准 SHALL 仅决定是否执行工具，不替代内置文件工具的物理路径校验。项目配置和 `AGENTS.md` MUST NOT 扩大文件沙箱根目录。

#### Scenario: 批准越界写入
- **WHEN** 一次越界写入获得人工批准或处于 `FullAccess`
- **THEN** 内置文件工具仍拒绝越界路径
