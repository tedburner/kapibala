# Kapibala 全仓可靠性与安全加固设计

## 背景

本轮工作源自一次全仓代码审查。目标不是扩展产品范围，而是修复已确认的安全、协议一致性、错误传播和可观测性缺陷，同时保持 Kapibala v0.0.1 的轻量边界与既有公开事件兼容性。

本设计覆盖以下问题：

1. 未经信任的项目配置可以覆盖模型端点和密钥来源。
2. `tool_use` 在对应 `tool_result` 产生前暴露给外部消费者，提前终止可能破坏历史闭合。
3. JSONL 历史恢复接受迟到或重复的 `tool_result`。
4. `grep` 在主线程执行任意正则，存在 ReDoS 风险。
5. 单次模式收到错误事件后仍可能以退出码 0 结束。
6. OpenAI 兼容 SSE 的 HTTP 200 错误帧可能被静默忽略。
7. 同一 Session 的并发运行或重置可能交错修改历史。
8. API Key 输入可见，且已有模型缺少明确的密钥更新入口。
9. 指标仅记录最后一个内部步骤，不能代表一次完整用户请求。

## 设计原则

- 历史闭合是硬约束：assistant 的 `tool_use` 一旦进入可持久化历史，对应 `tool_result` 必须紧随其后。
- 项目配置在显式信任前是完全不可信输入，不能影响模型、端点或密钥解析。
- 保持运行时零第三方依赖，不为单个安全问题引入大型权限或正则引擎。
- 公开 API 采用增量扩展；保留既有 `turn_finish` 与 `lastMetrics` 语义。
- 密钥由用户明确配置后持久化到全局配置，不写入项目配置。
- 所有行为变更先由失败测试证明，再实现最小修复。

## 1. 项目配置永久信任

### 1.1 配置分层

配置加载拆成两个阶段：

1. 读取内置默认值与全局 `~/.kapibala/settings.json`。
2. 检测当前工作目录的 `.kapibala/settings.json`，仅在项目已受信任时合并。

全局配置新增可选字段：

```ts
interface UserSettings {
  // 现有字段省略
  trustedProjects?: string[]
}
```

`trustedProjects` 只从全局配置读取。项目配置中的同名字段必须忽略，不能让仓库自行授权。

同 ID 的 profile 按字段合并：受信任项目可以覆盖端点、模型名等项目字段，但未声明的全局 `apiKey` 继续继承。任何 `/model` 或向导写操作都重新读取仅含内置＋全局层的配置再保存，不能把项目覆盖项反向固化到全局文件。

### 1.2 项目标识

- 项目标识使用当前工作目录经过 `realpath` 解析后的绝对路径。
- Windows 比较路径时忽略大小写，但保存时保留规范化后的真实路径。
- 目录移动、重命名或经不同真实路径访问后，信任自动失效。

### 1.3 首次确认

CLI 启动发现未受信任的项目配置时，仅提供两个选择：

1. 信任并永久记住：把规范路径写入全局配置，然后重新加载并应用项目配置。
2. 不信任：立即退出，不创建 Provider 或 Session。

空输入和取消均按“不信任”处理。非 TTY 环境无法确认时直接失败并返回非零退出码。

交互确认只存在于 CLI 启动边界；底层配置解析保持同步、无交互、可单测。

## 2. API Key 生命周期与模型配置

### 2.1 首次配置

- 启动时优先使用目标 profile 已保存的 `apiKey`。
- 若 profile 没有持久化密钥，再按既有同厂商环境变量规则解析。
- 仅在两者都不可用且模型需要密钥时进入补录流程。
- API Key 使用隐藏输入，输入过程中不回显明文。
- 写入前明确提示保存位置；确认后写入全局 profile 的 `apiKey`。
- 全局配置文件在写入后再次尝试收紧权限；不宣称 Windows POSIX mode 能提供完整 ACL 隔离。

### 2.2 `/model` 行为

- 普通切换：已有密钥直接切换；缺少密钥时先隐藏式补录、保存，再切换。
- `/model key`：更新当前模型密钥。
- `/model key <profile-id>`：更新指定模型密钥。
- 交互菜单增加“更新当前模型 API Key”。
- `/model setup` 新增或编辑 profile；编辑已有 profile 时默认保留密钥，只有明确更新才覆盖。
- 当前活动模型密钥更新后立即重建 Provider，无需重启 CLI。

密钥配置逻辑提取为可注入输入函数，测试使用假的 secret reader，不操纵真实终端。

## 3. 历史闭合与 Session 并发

### 3.1 闭合边界

`AgentLoop` 负责内存历史闭合，`AgentSession` 负责闭合消息的落盘与对外可见性。处理含工具调用的模型步骤时：

1. 接收模型增量事件并照常向外流式传递文本与思考内容。
2. `model:after` 在 assistant 进入历史前执行；钩子失败时不接纳半成品消息。
3. 工具执行完成后，`AgentLoop` 在同一个同步临界段把 assistant 与全部 tool messages 连续加入历史，然后才发出 `message_stop`。
4. Session 收到含 `tool_use` 的完成事件后暂存相关事件，按 assistant、tool messages 的顺序调用 `MessageStore.append`。
5. 内存历史闭合并完成落盘尝试后，再按原顺序释放暂存事件。

这样，外部消费者只能在两种安全状态中中止：assistant 尚未进入历史，或工具调用历史已经闭合。

若工具调度或其他非预期路径在 assistant 已进入历史后异常，Session 会为仍未闭合的调用合成 `isError` 工具结果，完成内存闭合和消息级落盘后再传播错误。

磁盘写入本身不是事务：如果 assistant 已写入而 tool message 写入失败，下次加载由严格恢复机制补齐；当前进程的内存历史仍保持闭合。

### 3.2 单会话互斥

这里的“单会话”专指一个 CLI 进程内的一个 `AgentSession` 实例，不是进程间、项目间或全局互斥。两个项目分别启动 CLI 时会创建彼此独立的 Session，可以同时对话和执行工具，不会相互阻塞。

Session 实例增加显式忙状态：

- 同一时刻仅允许一个 `run`。
- 活跃运行期间再次 `run`、`reset` 或切换模型，抛出 `SessionBusyError`。
- 互斥状态在异步生成器正常结束、抛错、取消或调用方提前 `return` 时均通过 `finally` 释放。
- `destroy` 保持幂等；若仍有活跃运行则明确拒绝，避免在执行中拆卸插件。

该机制不创建锁文件，也不锁定全局配置目录。不同 CLI 进程只有在用户同时修改全局模型配置或项目信任记录时才会访问同一个 `~/.kapibala/settings.json`；普通对话不会写该文件。

### 3.3 JSONL 严格恢复

恢复器改为状态扫描，而不是使用“历史上曾声明过”的全局 ID 集合：

- assistant `tool_use` 打开一个只针对紧随其后 tool messages 的待满足集合。
- 每个 ID 最多接受一个结果。
- 迟到、重复、未知或孤立结果被剔除。
- 遇到下一条非 tool 消息或文件结尾时，为所有缺失 ID 补充错误结果。
- 混合了合法与非法 block 的 tool message 仅保留合法 block。

## 4. 错误传播

### 4.1 SSE 错误帧

OpenAI 兼容 Provider 在解析每个 SSE JSON frame 后，先检查顶层 `error`。存在错误时抛出模型错误，保留可用的 message、type 与 code，但不记录请求中的 API Key 或 Authorization header。

只有既无错误又有合法 choice/delta 的 frame 才进入正常增量解析。HTTP 200 不再等价于业务成功。

### 4.2 单次模式退出码

- `runOneShot` 记录运行期间是否出现 `error` 事件。
- 任意错误事件都使本次执行在 Session 清理完成后返回失败状态。
- SIGINT 保持退出码 130。
- REPL 仍渲染错误并继续运行。

退出状态与事件渲染分离，以便单测，不在事件处理分支内提前 `process.exit`。

## 5. 请求级指标

保留现有 `TurnMetrics` 与 `turn_finish`，新增：

```ts
interface RunMetrics {
  startTime: number
  endTime: number
  totalDurationMs: number
  modelDurationMs: number
  toolDurationMs: number
  ttftMs?: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  turns: number
  toolCalls: number
  status: 'completed' | 'failed' | 'aborted'
}
```

`SessionEvent` 新增一次请求仅发出一次的 `run_finish`。Session 汇总所有 `turn_finish`：

- 各步骤模型耗时、工具耗时、Token 和工具调用数求和。
- TTFT 取本次请求第一个模型输出的 TTFT。
- 总耗时使用请求入口到结束的墙钟时间。
- 若收到错误事件则状态为 `failed`；中止为 `aborted`；正常最终回答为 `completed`。

`SessionStats` 新增 `lastRunMetrics` 和对应查询方法；既有 `lastMetrics` 继续代表最后一个内部步骤。

普通 CLI 仅渲染 `run_finish` 汇总。`turn_finish` 保留给 API、插件和 debug 日志使用。

## 6. `grep` 字面量搜索

- `pattern` 保留字段名，但语义改为大小写不敏感的普通文本。
- 使用 `line.toLowerCase().includes(pattern.toLowerCase())`，不构造 `RegExp`。
- 文件 glob、忽略目录、流式逐行读取和最多 50 条结果保持不变。
- 工具说明明确正则元字符没有特殊含义。
- 空 pattern 继续视为非法输入，避免匹配每一行。

这是有意的安全性行为变更。v0.0.1 不增加 worker、RE2 依赖或不完备的“安全正则”启发式。

## 7. 测试与验收

采用测试驱动顺序，每项先补失败用例：

### CLI

- 未信任项目不会合并任何项目字段。
- 信任后记录规范绝对路径并永久应用配置。
- 拒绝、取消与非 TTY 均失败退出。
- 已有密钥启动时不询问。
- 缺失密钥首次补录并持久化。
- `/model key` 更新当前或指定 profile，并重建活动 Provider。
- 单次模式收到错误事件后返回失败状态。

### Core

- 消费者在工具步骤前后提前结束均不产生悬空历史。
- `model:after` 异常仍补齐工具结果。
- 并发 `run`、运行中 `reset` 和模型切换被拒绝，结束后锁释放。
- JSONL 恢复剔除迟到、重复和孤立结果，并补齐缺失结果。
- HTTP 200 SSE 错误帧产生错误事件，不产生空成功消息。
- `run_finish` 正确聚合多步骤 Token、耗时和工具调用数。
- `grep` 将复杂正则字符作为字面量，并继续满足大文件与取消测试。

### 完整门禁

实现完成后运行：

1. `pnpm verify`
2. `pnpm build`
3. `pnpm check-secrets`
4. `git diff --check`
5. 对整个仓库重新执行代码审查，而不仅检查本次 diff

## 非目标

- 不引入操作系统 Keychain 或新的第三方凭据依赖。
- 不实现完整权限规则引擎。
- 不为 JSONL 存储增加多文件事务或数据库。
- 不恢复正则搜索的部分子集。
- 不修改现有设计文档的章节编号和交叉引用。

## 兼容性与迁移

- 没有项目配置的用户不受信任提示影响。
- 已有全局 `apiKey` 继续直接使用。
- 项目配置首次使用会新增一次明确的永久信任确认。
- `grep` 正则语义改为字面量语义，需要依赖正则的调用方改用精确文本。
- 既有 `turn_finish`、`lastMetrics` 和 `getLastMetrics` 保留；新指标均为增量 API。
