# Spec Delta

## Purpose

开箱即用地提供可授权、可回溯的跨平台命令执行。宿主在启动时确定实际执行环境；没有安装 Bash 的 Windows 用户仍能使用 PowerShell。命令以当前系统用户身份运行，中止与超时必须可观察。

## ADDED Requirements

### Requirement: 命令工具默认可用且可显式关闭
跨平台命令工具 SHALL 命名为 `run_command`。宿主启动时发现可用执行环境后，SHALL 默认注册该工具，并在允许命令执行的模式下向模型提供，无需额外启用参数；`Plan` 下模型工具清单仍须隐藏它。CLI SHALL 提供 `--disable-shell`，用户级设置与 SDK 宿主也 SHALL 能显式关闭工具；关闭后不得注册或执行。工具 SHALL 声明执行能力与危险标记；切换至 `FullAccess` 本身 MUST NOT 覆盖显式关闭。项目配置与 `AGENTS.md` MUST NOT 更改注册状态。

#### Scenario: 默认会话
- **WHEN** 用户以默认配置启动会话且宿主有可用执行环境
- **THEN** 模型工具清单和工具注册表均包含 `run_command`，用户无需额外启用

#### Scenario: 显式关闭
- **WHEN** 用户传入 `--disable-shell` 或宿主配置禁用命令工具
- **THEN** 模型工具清单和工具注册表均没有 `run_command`，切换至 `FullAccess` 也不会重新启用

### Requirement: 启动时确定执行环境
宿主 SHALL 支持 `--shell auto|bash|wsl|pwsh|powershell` 及显式解释器可执行文件全路径（用户级配置提供同等选择）。发现 SHALL 只依赖 `PATH` 环境变量与用户显式给出的路径，MUST NOT 写死任何安装目录。bash 家族候选 SHALL 经运行时探针（`uname`）分类：报告 MINGW/MSYS/Cygwin 的为 native Bash，Windows 上报告 Linux 的为 WSL launcher（独立 `wsl` 执行环境）。`auto` 在 POSIX 选择可用 Bash；在 Windows 按 native Bash → WSL → PowerShell 7 (`pwsh`) → Windows PowerShell (`powershell.exe`) 的顺序选择首个通过工作目录探针的环境。显式选择的环境不存在或类型不符时 MUST 明确报错，且 MUST NOT 悄然改用另一种语法；`auto` 未找到任何可用环境时宿主 SHALL 报告诊断并从工具清单移除命令工具，不得阻止其余工具启动。选择结果 SHALL 在工具说明、状态和审计事件中呈现；模型不能通过工具参数改变执行环境。`run_command` 的输入命令 SHALL 按选定环境的语法执行。

#### Scenario: 没有可用执行环境
- **WHEN** `auto` 未找到可用 Bash 或 PowerShell
- **THEN** 宿主报告明确的诊断，且不向模型提供无法执行的 `run_command`，其余工具照常可用

#### Scenario: 用户显式提供解释器全路径
- **WHEN** 用户的 PATH 上没有 Bash，但在 `--shell` 或用户级配置中给出 `bash.exe` 的全路径
- **THEN** 宿主以该路径为执行环境并经运行时探针验证后注册 `run_command`

#### Scenario: Windows 没有 Bash
- **WHEN** Windows 用户使用默认配置与 `auto`，机器上没有 Bash，但存在 PowerShell
- **THEN** `run_command` 注册为 PowerShell 执行环境，模型能执行 PowerShell 命令，状态和审计均标明实际环境

#### Scenario: Windows 只有 WSL Bash
- **WHEN** Windows 自动探测在 PATH 上只找到 WSL 的 `bash.exe`（运行时报告 Linux）和可用 PowerShell
- **THEN** 宿主选择 `wsl` 执行环境，工作目录由 WSL launcher 映射为 POSIX 路径，状态和审计均标明实际环境

#### Scenario: 强制选择缺失的 Bash
- **WHEN** 用户在没有 Bash 的 Windows 主机上指定 `--shell bash`，且没有显式关闭命令工具
- **THEN** 启动时明确报错，不注册工具，也不将 Bash 命令交给 PowerShell 解释

### Requirement: 命令遵守统一审批与日志入口
每条 `run_command` 调用 SHALL 在进程启动前经过最终参数授权及审计持久化。`Approval` 与 `Auto` 默认询问；`Plan` 拒绝；`FullAccess` 在无显式 `deny/ask` 时默认放行。审批界面 SHALL 展示最终完整命令、真实工作目录、解释器与允许范围。会话缓存和精确命令规则 SHALL 绑定执行环境、工作目录、最终命令和执行策略，切换执行目标后旧批准不得复用。审批结果与进程结果 SHALL 使用同一操作标识和执行指纹关联，并记录人工或自动来源与执行环境。

#### Scenario: FullAccess 中显式询问命令
- **WHEN** 命令工具已注册且命令命中显式 `ask` 规则
- **THEN** 即使处于 `FullAccess`，进程仍等待人工批准

#### Scenario: 审批后目标变化
- **WHEN** 审批完成后解释器、真实工作目录或可绑定的脚本目标在启动前发生变化
- **THEN** 命令不得按旧批准执行，系统重新裁决或返回明确的目标变化错误

### Requirement: 执行边界准确呈现
命令 SHALL 以当前操作系统用户身份运行。产品文案和诊断 MUST 明确：工作目录设置及内置文件工具的 `PathSandbox` 不构成命令进程的文件或网络隔离；不得向用户宣称命令被限制在工作区。

#### Scenario: 查看命令能力说明
- **WHEN** 用户查看 `run_command` 说明或当前执行环境
- **THEN** 说明明确列出实际执行环境、宿主用户权限及文件沙箱不覆盖命令进程

### Requirement: 命令有输出与生命周期上限
命令 SHALL 设置命令长度、执行时长和输出字节数上限。默认超时为 120 秒，调用可在宿主配置的最大 10 分钟范围内指定 `timeout_ms`，该参数属于审批指纹。超时或中止时系统 SHALL 先请求停止整个子进程树，经过有限宽限期后强制终止并等待进程退出；工具结果不得仅因外层 `Promise.race` 超时就宣称命令已结束。若无法确认进程树已回收，MUST 返回结果未知并报告该限制，不得标记为成功或自动重试。Windows PowerShell 和 POSIX Bash 均须通过真实子进程测试。

#### Scenario: 用户中止运行
- **WHEN** 命令正在运行且会话收到中止信号
- **THEN** 工具返回中止错误，审计记录中止和进程回收结果

### Requirement: 命令输出安全回填
命令执行期间 SHALL 向宿主提供时间、输出字节数等有界进度事件，允许用户中止，不把未经脱敏的原始输出写入日志。工具结果 SHALL 有截断标记与退出状态，最多回填 64 KiB 输出给模型；较大输出 SHALL 在工作区 `.kapibala/tool-results/` 下写入有界文件并在工具结果中给出路径，可经现有文件工具按范围读取。单次文件保存上限 16 MiB，超过后继续排空子进程输出但停止保存，明确标记文件也已截断；宿主 SHALL 清理过期结果文件。发送到终端的输出 SHALL 过滤控制序列；日志默认只记录安全摘要，不记录命令完整输出或继承的密钥环境变量。PowerShell 与 Bash 的输出 SHALL 统一转为 UTF-8 文本并有界处理。

#### Scenario: 命令输出超限
- **WHEN** 命令输出超过上限
- **THEN** 工具返回有界结果、可读取的受控输出路径和明确的截断状态；若保存文件也达到上限，则说明后续输出已丢弃，审计记录超限状态
