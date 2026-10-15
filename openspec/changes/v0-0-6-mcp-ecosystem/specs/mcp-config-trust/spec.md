# Spec Delta: MCP config and trust

## Purpose

定义用户与项目 MCP 声明的可重复解释、物理项目身份、凭据隔离及启动授权边界，使可信路径、允许读取声明和批准实际进程或网络连接保持明确区分，防止不可信项目自我授权。

## ADDED Requirements

### Requirement: Deterministic configuration ownership
系统 SHALL 按 Server 名称整项覆盖用户/项目定义，且 Server 名称 SHALL 匹配 `^[a-zA-Z0-9_-]+$`（长度 1–64 字符），严禁包含斜杠 `/`、反斜杠 `\` 以及连续双下划线 `__` 以防 Prompt ID 与工具命名歧义；受信任项目可只声明禁用，全局定义不补入被覆盖项的缺失字段，未信任项目不遮蔽用户定义。

#### Scenario: Server name contains slash or double underscore
- **WHEN** 配置中 Server 名称包含 `/`、`\` 或 `__`（如 `foo/bar` 或 `my__srv`）
- **THEN** 系统报配置错误（MCP_CONFIG_INVALID）并拒绝解析，不发起连接或启动

#### Scenario: Project disables a user server
- **WHEN** 受信任项目为同名 Server 只声明 enabled=false
- **THEN** Server 保持可诊断禁用状态，不回退启动全局定义

#### Scenario: Untrusted project overrides an executable
- **WHEN** 未信任项目声明与用户配置同名的新 command/args
- **THEN** 项目条目被排除并诊断，用户条目保持原身份且不执行项目目标

### Requirement: Explicit credentials and minimum environment
系统 SHALL 仅支持环境变量引用插值，缺失变量拒绝当前定义，不执行配置中的命令插值；HTTP 敏感鉴权值要求环境引用，Stdio 仅接收必要基础环境和明确声明键。项目级配置若插值了全局敏感环境变量（命中 `*_KEY`, `*_TOKEN`, `*_SECRET`, `OPENAI_*`, `ANTHROPIC_*` 等模式），系统 SHALL 在启动审批 descriptor 中标记高危凭据外发告警（Credential Alert）并显式列出被引用的变量名。

#### Scenario: Required token is absent
- **WHEN** 已启用 Server 引用不存在的环境变量
- **THEN** 该 Server 报配置错误且不发起启动或网络连接，不以空值继续

#### Scenario: A secret is unrelated to the server
- **WHEN** 宿主环境含未声明的业务或模型密钥
- **THEN** Stdio 子进程不继承该密钥，诊断与审计也不记录其原文

#### Scenario: Project config references a sensitive host secret
- **WHEN** 项目级配置声明引用了宿主敏感变量（如 `OPENAI_API_KEY`）
- **THEN** 启动审批展示高危凭据外发预警并列出变量名，禁止静默注入外部进程或网络

### Requirement: HTTP target identity bounds credentials
系统 SHALL 默认使用 HTTPS，仅允许显式回环 HTTP（IPv4 `127.0.0.0/8` 全段、IPv6 `::1/128` 或 `localhost`），拒绝内嵌密码及跨目标重定向，不跨 Server 复用或转发鉴权凭据。系统 SHALL 在建立连接前校验解析目标 IP 并全量拦截私有及保留网段（IPv4: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10` CGNAT, `0.0.0.0/8`, 组播与保留段；IPv6: `fc00::/7` ULA, `fe80::/10` 链路本地, 组播, `::/128` 及 IPv4-mapped 对应段）。显式域名白名单仅放行主机名声明，Socket 建立后必须复核底层 Remote IP，禁止白名单域名解析至私网/保留地址以防御 SSRF 与 DNS Rebinding。

#### Scenario: Authenticated endpoint redirects to another origin
- **WHEN** 已批准 HTTP 目标返回跨 origin 重定向
- **THEN** 系统拒绝跟随且新目标收不到鉴权 Header，需修改配置重新授权

#### Scenario: HTTP endpoint targets private network or metadata service
- **WHEN** HTTP 配置的目标解析到 RFC 1918、CGNAT 100.64/10、IPv6 ULA、169.254.169.254 或回环以外的内网地址
- **THEN** 系统在连接建立前拒绝请求并报告 SSRF 拦截错误，不向目标发送鉴权凭据

#### Scenario: Allowlisted domain resolves to an intranet address
- **WHEN** 域名在显式配置白名单中，但 DNS 解析或底层 Socket Remote IP 为私网地址
- **THEN** 系统在底层 Remote IP 复核时拦截连接并报错，防御 DNS Rebinding 穿透内网

### Requirement: Independent startup authorization
系统 SHALL 在启动前取得针对实际目标的授权并完成审计；项目信任不构成进程/网络启动授权，等待授权时目标变化应失效，缺省无审批通道则拒绝未预授权启动。

#### Scenario: Trusted project changes its startup script
- **WHEN** 项目仍受信任但可识别启动脚本摘要改变
- **THEN** 旧启动批准不再匹配，重新授权成功前不能创建进程

#### Scenario: Noninteractive host has no approval channel
- **WHEN** 启动需询问且宿主未提供审批入口或预授权身份
- **THEN** 系统返回明确拒绝，不自动放行或无限等待输入

### Requirement: Physical identity and declared relative roots
系统 SHALL 以 Windows 长路径物理身份比较项目/信任目标，并按声明所属根解析相对 cwd；系统 SHALL 拒绝 Windows 保留设备名（`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9` 等）作为 command 或 cwd；启动授权记录最终绝对目标而不是原始相对字符串。

#### Scenario: Windows path has a short name alias
- **WHEN** 同一项目通过 8.3 短名与长名访问
- **THEN** 信任身份归于同一物理长路径，不能重复或失配授权

#### Scenario: Relative cwd is declared by user config
- **WHEN** 用户级定义指定相对 cwd
- **THEN** 路径相对用户配置目录解析，审批展示该最终路径而非当前命令目录

#### Scenario: Command or cwd uses Windows reserved device name
- **WHEN** 配置中的 command 或 cwd 解析为 Windows 保留设备名
- **THEN** 系统报配置非法并拒绝启动授权

### Requirement: Session overrides cannot bypass host disablement
系统 SHALL 将管理命令开关限定于当前 Session，重连使用当前授权配置；宿主显式关闭 MCP 后任何命令均不得重新启动，配置来源文件不被管理命令自动改写。

#### Scenario: Enable follows no-mcp startup
- **WHEN** 用户在 --no-mcp 会话执行 enable/reconnect
- **THEN** 系统拒绝重启且不解析敏感变量或创建连接

#### Scenario: File changes before reconnect
- **WHEN** 配置文件已修改而当前 Session 执行 reconnect
- **THEN** 重连仅使用已解析/授权定义，不暗中采用新的命令或凭据目标
