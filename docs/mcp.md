# MCP 生态接入与受控执行边界（v0.0.6）

Kapibala 采用独立扩展包 `@kiturone/kapibala-mcp` 受控接入 Model Context Protocol (MCP) 规范。通过同一个 `AgentSession` 消费外部服务暴露的 Tools 与 Prompts，同时维持 Headless Core 零外部依赖、权限审批、安全审计、完整工具事务及消息级持久化契约。

## 范围与阶段边界

| 维度 | 当前已实现 / 本版范围 | 明确延期 / 不支持范围 |
| --- | --- | --- |
| **包结构** | 独立 `@kiturone/kapibala-mcp`，Core 运行时零依赖 | Core 内部不引入 SDK 或网络/进程依赖 |
| **配置与命名** | `mcp.json` 判别联合、严格正则命名、整项覆盖、禁用不回退 | 不提供自动化向导修改外部配置文件 |
| **启动安全** | 独立启动授权、会话缓存、Credential Alert、Windows 设备名防御 | 项目信任不等于免审启动；FullAccess 不豁免硬拒绝 |
| **传输协议** | Stdio 进程与 Streamable HTTP（计划第 4、7 组） | 旧版 HTTP+SSE 弃用；不自动降级不安全传输 |
| **能力发现** | Tools 有界目录、Prompts 模板任务准备（计划第 5、8 组） | 暂不提供 Resources 动态读取、OAuth 认证流、Sampling、Elicitation、MCP Apps |

## 配置文件位置与命名规范

Kapibala 依次发现并合并两处配置文件：
1. **全局用户配置**：`~/.kapibala/mcp.json`
2. **项目级配置**：`<projectRoot>/.kapibala/mcp.json`

当两处配置文件均不存在或内容为空时，MCP 子系统自动禁用，不发起任何网络连接或进程探测，不增加模型问答延迟。

### 命名铁律

Server 名称必须满足严格命名规范：
- 必须严格匹配正则表达式：`^[a-zA-Z0-9_-]+$`；
- 长度限制为 1 至 64 个字符；
- **显式禁止**包含斜杠 `/`、反斜杠 `\` 以及连续双下划线 `__`。

> [!IMPORTANT]
> 为什么禁止这些字符？
> MCP 工具命名规范为 `mcp__<server>__<tool>`，Prompt 唯一标识为 `<server>/<prompt>`。包含斜杠或连续双下划线将彻底破坏双向逆向解析映射，引入命名碰撞与提权安全隐患。违规命名在配置解析阶段直接被判定为 `MCP_CONFIG_INVALID` 并拒绝加载。

### 整项覆盖与禁用不回退

- **整项覆盖**：受信任项目中的同名 Server 配置直接整项替换全局同名配置。显式禁止属性浅合并、数组拼接或跨来源补字段，防止环境变量与参数被隐式杂糅。
- **禁用不回退**：项目配置声明 `{ "enabled": false }` 即可安全停用全局同名服务；禁用状态保留生效，绝不隐式回退到全局启用的服务。
- **项目信任边界**：未受用户信任的项目，其项目级配置全量排除，严禁未信任项目的配置声明覆盖全局服务。

## 最小配置示例

```json
{
  "mcpServers": {
    "git-tools": {
      "type": "stdio",
      "command": "node",
      "args": ["./scripts/mcp-git.js"],
      "env": {
        "GIT_PREFIX": "kapibala"
      },
      "enabled": true,
      "required": false
    },
    "remote-search": {
      "type": "http",
      "url": "https://mcp.internal.example.com/sse",
      "headers": {
        "Authorization": "Bearer ${SEARCH_API_TOKEN}"
      },
      "enabled": true
    },
    "legacy-service": {
      "enabled": false
    }
  }
}
```

## 路径安全与 Windows 设备名防御

1. **Native 物理路径解析**：
   Windows 8.3 短名会导致路径匹配或沙箱身份失配。所有路径统一走 `fs.realpathSync.native` 展开真实物理长路径。
2. **Windows 保留设备名防御**：
   严禁将 `CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9` 及其带扩展名变体（如 `con.exe`, `nul.txt`）作为可执行程序名或工作目录路径。违规路径在进入进程调用前直接拒绝，防止 Windows 内核挂起或设备锁死。
3. **工作目录确定性根解析**：
   项目配置声明的相对 `cwd` 强制基于真实项目根解析；全局配置的相对 `cwd` 基于全局配置目录解析；缺省统一使用当前项目根。

## 环境变量隔离与 Credential Alert

1. **Stdio 最小化继承**：
   子进程不继承整份宿主环境，仅保留平台运行必需的最小白名单（如 `PATH`、`TEMP`、`SystemRoot` / `HOME` 等）以及配置显式声明的键。
2. **严格变量插值**：
   仅支持 `${VAR_NAME}` 变量插值，严禁执行命令替换（`$()`、反引号）或模板脚本。引用的变量在宿主中缺失或为空时，直接报错阻断，严禁用空字符串静默放行。
3. **高危凭据外发预警（Credential Alert）**：
   项目级配置若通过插值引用了全局敏感环境变量（匹配 `*_KEY`, `*_TOKEN`, `*_SECRET`, `OPENAI_*` 等），启动审批时会显著标出引用的敏感变量名，提醒用户防止恶意仓库钓鱼窃取开发机核心凭据。

## 启动授权与执行防漂移

1. **两级独立授权**：
   启动授权（建立连接/创建进程）与工具执行授权（调用特定 tool）严格分离。启动授权仅授权连接建立，内部敏感工具仍需经受 Core 的通用权限裁决与用户审批。
2. **审批串行化**：
   多个服务同时就绪时，启动审批请求强制串行排队展示，避免终端或界面发生多弹窗竞争打架。
3. **会话缓存深度哈希**：
   `ServerStartupApprovalCache` 深度哈希 Server 名称、来源、目标路径、工作目录、参数和脚本摘要。目标或绑定的本地脚本内容发生任何修改，会话批准立即失效，重新触发用户审查。
4. **批准后计时**：
   技术连接与启动超时（默认 10s）在用户确认授权完成后才开始计时，用户阅读和审阅审批描述符的时间绝不扣除技术超时。

## Stdio 进程传输与生命周期管理

### 1. 进程启动与环境安全
- **可执行文件与路径解析**：基于真实物理 native 路径（`toNativePhysicalPath`）与受控 PATH 解析，绝不调用未受控 shell 解释器；
- **最小化环境变量继承**：仅继承操作系统最小必需变量（如 `PATH`、`SystemRoot`、`TEMP`、`HOME` 等）与配置显式列出的变量，阻止无关主机凭据向子进程泄露；
- **设备名与字符注入防御**：严格拦截 Windows 保留设备名（`CON`, `PRN`, `AUX`, `NUL` 等），参数严格校验转义。

### 2. 协议与能力协商
- **协议时代**：支持 `legacy` (2024-11-05)、`modern` (2025-11-25) 与 `auto` (自动降级)；
- **能力判定与 Prompt-only 服务**：服务端未声明 `capabilities.tools` 时，系统判定为 `toolsState = 'unsupported'`，**绝不发送 `tools/list` 请求**；对于 Prompt-only 服务，以 `promptsState === 'ready'` 判定服务就绪；
- **混合服务容错**：同时支持 Tools 与 Prompts 的服务，若 Prompts 目录发现失败，**绝不撤销已成功的 Tools**，普通工具调用仍可正常推进。

### 3. 超时机制与并发限制
- **并发调度**：默认并发上限 4（`maxConcurrentStartups = 4`），避免多服务同时启动压垮系统资源；
- **总体截止**：会话级总体启动截止时间 15s（`overallDeadlineMs = 15000`）；
- **单服务超时**：启动握手超时 10s（`startupTimeoutMs = 10000`），目录发现超时 10s（`catalogTimeoutMs = 10000`），本地清理超时 5s（`cleanupTimeoutMs = 5000`）。

### 4. Required 门禁与全量回滚
- **核心服务保障**：声明 `required: true` 的服务若启动失败或未达到可用就绪状态，整体启动宣告失败；
- **完全回滚（Rollback）**：启动失败时自动触发回滚，回收并强制终止已启动的全部子进程与网络连接，确保无孤儿进程遗留，失败资源具备明确所有者；
- **可选服务隔离**：未声明 required 的可选服务启动失败仅记录错误诊断，不阻断其他服务正常工作，且失败的可选服务底层句柄已被及时关闭。

### 5. 代次防护与手动重连
- **内存配置复用**：手动重连（`reconnectServer`）严格沿用当前会话已授权的内存配置，**绝不重新读取磁盘配置文件**；
- **双重代次防护**：连接代次（`connectionGeneration`）与能力纪元（`catalogEpoch` / `refreshToken`）单调递增，过期连接的迟到退出事件与异步刷新回调会被自动忽略，彻底杜绝状态污染；
- **独立能力更新**：Tools 变更通知仅刷新 Tools 目录，绝不撤销或影响 Prompts；反之亦然。

### 6. 有界 stderr 诊断与进程树清理
- **有界错误输出**：子进程 stderr 实时捕获至 8 KiB（8192 字节）尾部环形缓存，剥离 ANSI 控制符用于诊断，不占用非受限内存，严禁将 stderr 误转为模型指令；
- **进程树升级清理**：先通过 transport 优雅关闭（关闭 stdin，发送 SIGTERM）；若进程或其衍生后代仍存活，Windows 平台升级调用 `taskkill.exe /PID <pid> /T /F`，POSIX 平台向进程组递送信号；确认退出后方才完成收口，失败不冒充完成；
- **幂等销毁**：`teardown()` 保证幂等执行，重复调用安全无副作用。

## 工具目录、预算截取与权限契约

### 1. 工具命名与稳定映射
- **规范格式**：统一命名为 `mcp__<server>__<tool>`，字符集严格限制在 `[a-zA-Z0-9_]`；
- **64 字符上限与防碰撞**：当工具名包含特殊字符被清洗、或者总长超过 64 字符时，系统以 `mcp__<server>__<cleanTool>_<digest8>` 的确定性格式补齐 8 位 SHA-256 短哈希；
- **发现次序无关**：映射完全由原始 Server 与 Tool 身份确定，正序与倒序发现生成的规范名称保持绝对一致，杜绝模型协议前缀漂移。

### 2. 输入 Schema 约束与安全
- **单工具尺寸上限**：`inputSchema` 序列化尺寸上限为 32 KiB（32768 字节）；
- **嵌套深度上限**：严格限制在 20 层以内，防御深层递归栈溢出；
- **禁止远端 `$ref`**：严禁包含指向外部网络（`http://`, `https://`）的 `$ref` 引用，彻底防御 SSRF 攻击；
- **约束零静默丢弃**：严禁为了迎合大模型而静默删除约束规则；校验不通过时整项拒绝该工具并记录诊断。

### 3. 模型 MCP 定义预算与精确过滤
- **总预算硬界**：模型可见的 MCP 工具定义总大小上限为 64 KiB（65536 字节），数量上限为 64 个工具；
- **整项省略（Whole-Item Omission）**：超限工具整项省略，绝不向模型输出破碎的残缺 JSON；
- **稳定排序**：候选工具按 Server 配置名升序、规范工具名升序排序，保证跨轮次定义次序稳定；
- **白名单与黑名单**：支持配置 `includeTools`（仅白名单暴露）与 `excludeTools`（黑名单剔除）。

### 4. Core Tool 适配与微任务发送复核
- **通用权限与危险标记**：声明 `external:call` 权限（HTTP 叠加 `net:outbound`），默认 `dangerous: true` 与 `managesTimeout: true`；
- **无副作用 `validateInput`**：在审批前利用 Standard Schema 预检参数快照；参数不合法时直接拒绝，零审批零发送；
- **发送前同步微任务复核**：在异步审批与审计全部完成后、底层出队发送前同一同步微任务中完成复核（无 `await` 让步）；若观察到断连或目录变更，严格零发送并报错拒绝，绝不替换同名新实例。

### 5. Skill 兼容性
- 既有 Skill 若声明了当前未连接的 MCP 工具，系统拒绝执行并提示：先通过 `/mcp reconnect <server>` 恢复连接后再重新激活 Skill。

## 结果净化、执行元数据与取消收口契约

### 1. 20 KiB 预算保留与 4 MiB 传输硬界
- **单结果保留上限**：默认 20 KiB（20480 字节）UTF-8，防止超大工具返回占用过多上下文；
- **传输硬界**：传输总线硬上限为 4 MiB（4194304 字节），超过直接报错拦截；
- **安全截断**：长文本保留头部（60%）与尾部（40%），并在中间注入 `... [omitted N bytes] ...` 省略标记；结构化 JSON 保证完整对象项截断，不破坏 JSON 语法；
- **多媒体脱敏**：图片（image）、音频或内嵌二进制只保留元数据占位符（如 `[Embedded Image: image/png, ~N bytes not retained]`），**严禁落盘裸 Base64**，严禁发起外部网络下载；
- **私有 `_meta` 剔除**：服务端返回的内部 `_meta` 字典在进入历史与模型前被彻底剔除。

### 2. `execution v1` 错误分类与远端事实保留
- **业务失败（`isError: true`）**：标记为 `dispatchOutcome: 'failed'`，错误码 `MCP_TOOL_ERROR`，保留错误信息供模型自我修正，但不承诺无副作用；
- **业务成功（`!isError`）**：标记为 `dispatchOutcome: 'succeeded'`；
- **投影转换异常**：若远端已经成功返回，但宿主在做结果解析/投影时发生异常，系统坚决保持 `dispatchOutcome: 'succeeded'`（**绝不因宿主错误改写远端已成功的事实！**），附加 `hostError: { phase: 'projection', code: 'MCP_RESULT_INVALID' }` 并以 `after_user_action` 暂停等待用户确认，严禁自动重放；
- **发送前拦截**：参数校验失败或发送前微任务复核发现变更，标记为 `dispatchOutcome: 'not_sent'`；
- **状态未决**：超时、断连或连接重置导致无法判定服务端真实状态时，标记为 `dispatchOutcome: 'unknown'` 与 `OUTCOME_UNKNOWN`，采用 `after_user_action` 暂停，**绝无隐式自动重放**。

### 3. 适配器调用期限与取消收口
- **自主管理期限（`managesTimeout: true`）**：由 MCP 工具适配器自身管理单次调用的超时时间与取消信号，禁止外部通用 `Promise.race` 提前释放锁；
- **取消收口等待**：取消触发时委托底层 SDK 发送取消通知并等待本地有界收口（最多 5s）；若取消前远端调用实际已完成，系统保留其真实的成功结果。

## Streamable HTTP 传输与安全网关契约

### 1. 协议与传输支持矩阵
- **规范传输支持**：采用官方 `StreamableHTTPClientTransport`，支持 `legacy` (2024-11-05)、`modern` (2025-11-25) 与 `auto` 协议协商；
- **拒绝旧版 SSE**：明确拒绝旧版 HTTP+SSE 传输协议（如 `sse://`、`http+sse://`），配置包含此类协议时直接报错拒绝；
- **OAuth 延期说明**：本版明确延期 OAuth 2.0 动态交互鉴权流；HTTP 凭据统一采用 `${VAR_NAME}` 环境变量引用的固定 Header（如 `Authorization: Bearer ${API_KEY}`）；
- **凭据隔离不串用**：每个 HTTP Server 独立配置与维护传输实例，Server 间凭据相互隔离，绝不交叉串用。

### 2. 静态安全网关与 SSRF 全网段拦截
- **HTTPS 强制**：对外网络端点强制要求 HTTPS 协议；
- **回环 HTTP 特例**：仅回环地址（`localhost`、`127.0.0.0/8`、`::1/128`）允许显式配置 `http://`；非回环目标使用 HTTP 直接抛出安全违规异常；
- **禁止 URL 内嵌凭据**：URL 中若包含 `user:password@` 格式的认证信息，在解析阶段直接拒绝；
- **全量私网与保留网段拦截**：
  - **IPv4**：RFC 1918 私网（`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`）、链路本地与云元数据（`169.254.0.0/16`，含 `169.254.169.254`）、CGNAT（`100.64.0.0/10`）、当前网络（`0.0.0.0/8`）、组播（`224.0.0.0/4`）与保留地址（`240.0.0.0/4`）；
  - **IPv6**：RFC 4193 唯一本地 ULA（`fc00::/7`）、链路本地（`fe80::/10`）、组播（`ff00::/8`）、未指定地址（`::/128`）以及 IPv4 映射形式（`::ffff:0:0/96`，解包为 IPv4 后同等校验）。

### 3. DNS Rebinding 防御与 Socket Remote IP 二次复核
- **双重校验**：不仅在发起请求前对目标域名进行 DNS 预检解析，还在底层 TCP/TLS Socket 建立后监听 `connect` 事件；
- **真实底层 IP 复核**：复核底层 Socket 的真实 `socket.remoteAddress`，若发现域名解析到公网但实际 TCP 连接到了内网私有地址（DNS Rebinding 攻击），立即销毁底层 Socket 并中止请求。

### 4. 跨 Origin 重定向与鉴权隔离
- **敏感鉴权头强制剥离**：遇到 HTTP 重定向（301, 302, 303, 307, 308）且目标跨 Origin（协议、主机或端口变更）时，强制剥离 `Authorization`、`Proxy-Authorization`、`Cookie`、`X-Api-Key` 等所有鉴权头，确保新目标收到零凭据请求；
- **禁止协议降级**：严禁由 HTTPS 重定向降级为不安全的 HTTP；
- **重定向深度上限**：最多允许 5 次重定向，防止重定向死循环。

### 5. 业务调用至多一次与幂等重试
- **业务 `tools/call` 至多发送一次**：无论遇到 401 鉴权挑战、404 会话丢失还是断流/超时，已发送的业务 `tools/call` 绝无自动或隐式重放，彻底防止非幂等副作用；
- **有限幂等重试**：仅初始握手与幂等目录查询（`tools/list`、`prompts/list`）在原截止时间内允许最多 2 次重试。

## Prompt 任务准备与历史来源契约（Prompt & promptSource v1）

### 1. Prompt 标识与纯元数据搜索
- **稳定唯一 ID**：统一采用 `<server>/<prompt>`（如 `git/review-pr`），与工具命名 `mcp__<server>__<tool>` 明显区分；
- **轻量元数据搜索**：`McpPromptRegistry.search(query)` 仅基于内存中已缓存的名称与描述快速检索，**绝不发起网络调用预取远端模板正文**；
- **跨 Server 同名隔离**：不同 Server 暴露的同名 Prompt 通过所属 Server 名称严格隔离。

### 2. 严格参数校验与权限门禁
- **参数输入**：支持 JSON 字符串或键值字典（值必须为字符串）；
- **必填项检测**：未提供必填参数（`required: true`）时直接报错拒绝；
- **未知参数拦截（零静默丢弃）**：传入未在 Prompt 定义中声明的未知键时，直接报错拦截，**严禁静默丢弃未知字段**；
- **模式限制**：`Plan` 模式始终拒绝执行 Prompt；对应 Server 的 prompts 能力非 `ready` 状态时拒绝获取。

### 3. 角色标签降级与正文约束
- **角色标签降级**：服务端返回的 user 与 assistant 消息序列按顺序组装为一段带 `Role: <user|assistant>` 标签的纯文本上下文，**绝不伪造真实的 assistant 消息，绝不提升为 system 消息**；
- **纯文本约束**：仅支持文本内容；若返回无可读文本或包含必需的二进制块（如无法展示的图片/音频），直接报错 `MCP_PROMPT_UNSUPPORTED`，拒绝把残缺模板当做完整成功；
- **辅助说明（Instructions）**：服务端汇报的 instructions 仅作为独立辅助说明文本呈现。

### 4. 提交前同步复核（verifyIdentity）与原子提交
- **防通知竞态**：在调用 Core `runPreparedTask` 时传入 `verifyIdentity` 回调；在正式写入持久化存储之前，同步复核目标 Prompt 的 `generation`、`promptsCatalogEpoch` 与 `contentDigest`；
- **变更阻断**：若在获取模板或预算等待期间服务端发生了目录变更通知，复核立即返回 false，Core 拒绝提交并报错 `MCP_PROMPT_CHANGED`，保护上下文不被漂移内容污染；
- **单条 User 消息构成**：包含不带 arguments-json 的命令标识（`/prompt <server>/<name>`）、用户显式附加的任务正文（如有）以及挂载了 `promptSource v1` 的模板内容块；
- **隐私边界说明**：模板回填后的正文会持久化进入消息历史，本版不承诺对用户主动提交的敏感正文进行自动脱敏，且终端输入回显或外部 Shell 历史不受本子系统控制。

### 5. `promptSource v1` 溯源、事件与跨会话恢复
- **来源元数据**：`promptSource` 包含 `{ version: 1, server, name, scope, contentDigest }`，供历史追踪与审计摘要；不发送到 Provider wire，不从历史恢复权限；
- **加载事件与审计**：消息成功落盘后（或无 Store 内存会话写入后），系统派发 `mcp_prompt_loaded` 会话事件并记录 `mcp.prompt_loaded` 安全审计；
- **写入失败保护**：若 Store append 失败，**零派发加载事件、零发起大模型调用**，保持历史原子性；
- **跨会话只读恢复**：恢复旧会话历史时只读取已保存的正文文本与 promptSource 摘要，**绝不重新连接外部端点获取 Prompt，绝不恢复旧授权**。

## CLI 管理命令与会话交互

Kapibala CLI 提供了轻量、安全的统一斜杠命令支持 MCP 生态运维与交互：

### 1. 服务状态与工具查询（纯只读，会话忙碌可用）
- `/mcp`：查看当前活动会话中所有 MCP 服务的连接状态（ready / connecting / disabled / failed）、Tools 目录状态与 Prompts 目录状态；
- `/mcp tools <server>`：列出指定服务在当前会话中成功注册并暴露的工具（附带 `[只读]` 标记及描述）；
- **只读快照保证**：上述只读命令仅查询内存快照，绝不发起网络调用或握手，在模型生成与任务执行期间允许随时执行。

### 2. 会话级运维操作（变更操作，忙碌拒绝）
- `/mcp reconnect <server>`：手动重新连接指定服务，单调自增代次（generation）并重新协商能力；
- `/mcp enable <server>`：在当前活动会话内临时启用服务（纯内存生效，绝不修改磁盘配置文件）；
- `/mcp disable <server>`：在当前活动会话内临时禁用服务，自动回收子进程与连接，并注销相关工具与提示词（纯内存生效，绝不修改磁盘配置文件）；
- **忙碌保护**：变更操作在任务执行、用户审批或清理期间被直接拒绝。

### 3. 提示词检索与受控执行
- `/prompts [query]`：基于内存元数据快速搜索匹配的提示词模板（展示参数名与必填标记），绝不产生网络开销；
- `/prompt <server>/<name> [arguments-json]`：执行受控提示词任务。参数支持带空格的完整 JSON 格式，严格校验必填项与未知字段，通过 Core 的 `runPreparedTask` 统一受控准备与执行，支持 Ctrl+C 取消。

### 4. 宿主禁用与会话隔离
- **`--no-mcp` 启动开关**：启动命令添加 `--no-mcp`（如 `kpbl --no-mcp`）可在当前进程中彻底关闭 MCP 生态，零连接零探测开销；此时禁止通过 `/mcp enable` 绕过宿主限制；
- **一 Session 一插件生命周期**：每次会话新建（`/new`）或恢复（`/resume`）时，为目标会话创建独立的 MCP 插件实例与启动授权缓存；切换成功后旧连接自动回收，若 required 服务启动失败则保留旧会话；
- **未交付边界明确声明**：本版仅交付受控 Tools 与 Prompts 能力，明确延期 Resources 动态拉取、OAuth 流程与独立 TUI 面板，保持极简终端交互。


