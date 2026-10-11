# 技能使用与宿主边界（v0.0.5）

技能是按需加载的文件指令包。发现元数据、加载正文、工具权限和消息提交沿用同一个 AgentSession；技能文本本身不授予执行权限。

工作区实现及本地验收已完成，尚未发布；兼容边界见 [迁移说明](migration/v0.0.5.md)，证据与测试限制见 [验收记录](verification/v0.0.5.md)。

## 放置与信任

CLI 依次选择项目 `.kapibala/skills`、项目 `.agents/skills`、全局 `~/.kapibala/skills`、全局 `~/.agents/skills`、宿主提供的内置来源。项目根按当前工作目录的 Git 根检测，无 Git 时使用当前目录；恢复历史仍使用本次项目与信任。

项目技能需要用户永久信任真实项目根，只有技能而没有 settings 文件也会询问。非交互启动或拒绝技能信任时，排除项目技能执行，继续使用全局来源；未信任的项目 settings 文件仍按既有规则阻止启动。只将信任路径写入原始全局配置，不反写合并后的内置模型清单。

同名有效高优先级来源胜出；无效、不可执行或未信任候选不遮蔽合法低层来源。显式禁用按名称生效，不回退到低层副本。`/skills [query]` 可查看来源、调用控制、不可用原因、覆盖诊断、目录遗漏数和本轮活动状态。

```json
{
  "skills": { "enabled": true, "disabled": ["deploy-production"] }
}
```

缺省开启、禁用列表为空。已信任项目配置使用 enabled 逻辑与、disabled 集合并集，只能收紧全局限制。关闭不删除历史、技能文件或配置。

## SKILL.md 格式

```markdown
---
name: review-guide
description: >-
  审查代码的权限边界和错误处理，
  用于用户要求代码审查时。
allowed-tools: [Read, Glob, Grep]
metadata:
  author: local-team
---
先读取 references/checklist.md，再按实际证据说明问题。
```

每个包必须包含 SKILL.md。支持 UTF-8/BOM、LF/CRLF、字符串、单双引号、引号外注释、布尔值、字符串列表、一层字符串 metadata、`|`/`>` 及 `+`/`-` 尾部语义。双引号转义采用 JSON 子集。不是完整 YAML：嵌套对象、标签、锚点、别名、合并键和复杂结构拒绝；单文件失败不影响其他来源。

name 为最多64字符的小写字母/数字及单连字符，缺省回退目录名并产生诊断。description 必填；长描述保留，模型目录只使用最多250 code points 的摘要。license、compatibility、when/when_to_use、argument-hint 可选。未知普通字段只诊断。context/fork、hooks、model、agent、shell 和动态 shell 表达式不可执行，不能静默转成 inline。

`disable-model-invocation: true` 表示仅供用户显式调用；`user-invocable: false` 禁止用户入口，两者独立。`/skill <name> <task...>` 必须带任务，保留任务引号、空格和换行，不执行 shell 参数插值。

## 发现与预算

文件上限128 KiB，Frontmatter 上限16 KiB；单根最多深度6、目录2000、条目20000。找到 SKILL.md 后停止递归发现其内部技能。忽略 `.git`、`node_modules`、`dist`；支持声明目录隔离的 .gitignore 子集：`*`、`?`、`**`、目录模式、根锚定和否定规则；父目录已排除时不下钻。字符组、复杂转义等不支持并诊断，不承诺完整 Git 兼容。

符号链接/junction 按物理边界校验并防环；规则匹配声明目录下的词法路径，不让兄弟目录规则相互污染。运行开始刷新快照，加载与资源读取重新核验发现根、文件身份和原始字节摘要；变动返回 SKILL_CHANGED，需开始新运行。

模型目录 L2.5 整段估算不超过 min(2000 tokens, 窗口1%) 和请求可用空间，包含标签、转义和遗漏提示。目录不足时按稳定顺序整条省略，模型可用 list_skills 分页搜索；缺省20、上限50，响应预算1000 tokens，过期游标可重试。查询不激活技能。正文预算包含完整包装、来源元数据、JSON 序列化换行转义和事务余量；剩余空间还须扣除在途 assistant 消息及同批已完成工具结果，成功技能正文只预留一次。临时预算视图不提前写入正式历史。无法放入剩余输入预算时拒绝，不能截断后继续执行。

## 权限、资源与审计

allowed-tools 只收紧权限，不代表预批准。固定别名 Read/Write/Glob/Grep/Bash 映射到既有工具；未知工具和 Bash(git:*) 等参数模式拒绝。多个活动技能取白名单交集；未声明不增设限制，空列表禁止业务工具。FullAccess、普通 allow 或会话缓存均不能绕过技能硬拒绝。

load_skill 成功通过结果钩子和执行审计后立即安装 pending 限制，同批后续写操作已受约束。正文消息完整提交并完成 skill.loaded 审计后才发布 skill_loaded 与资源资格；同批提前读取返回 SKILL_NOT_COMMITTED，可在下一步重试。失败不回滚已提交的真实历史，也不把失败加载当作授权。

控制工具以真实定义实例豁免技能白名单，仍受宿主 deny/ask/Plan 等读取权限裁决。`--disable-shell` 只关闭命令工具，文件技能仍可用。脚本执行仍走原命令目标识别、内容摘要及审批流程。

read_skill_resource 只读取本轮已提交技能目录内的相对文本资源，不扩大普通 read_file 沙箱。绝对路径、UNC、盘符、越界、外部 junction、二进制与非法 UTF-8 拒绝。支持 startLine/endLine，每页最多64 KiB UTF-8；超限返回 truncated/nextOffset，用 offset 接续（不可与行范围混用）。发现只列最多20个资源名，不预读资源正文。资源更新可以读取，审计记录本次返回片段摘要、范围与字节数，不记录正文。

取消、异常、clear、切换和提前结束迭代都先等工具回收并闭合事务，再清除活动资格及释放锁。新任务必须重新激活，历史 source 字段不恢复权限。

| 错误 | retryPolicy | 调用方处理 |
| --- | --- | --- |
| SKILL_NOT_COMMITTED / SKILL_CURSOR_EXPIRED | immediate | 等待提交后下一步读取，或重新查询游标；不进入确定性失败缓存 |
| SKILL_CHANGED / SKILL_UNTRUSTED / SKILL_BODY_BUDGET_EXCEEDED / SKILL_CONTEXT_LOST | after_user_action | 停止本轮，由用户处理来源、信任或预算后开始新运行 |
| 未找到、调用禁止、不支持格式/工具、非法输入或资源越界等其他技能错误 | never | 修正输入或配置，不能原样循环重试 |

加载器不根据 retryPolicy 自动重试。

## Headless / SDK

```typescript
const session = new AgentSession({
  defaultProfile, defaultProvider, rootDir: projectRoot,
  skills: { roots: [
    { path: `${projectRoot}/.agents/skills`, scope: 'project', trusted: true, boundary: projectRoot },
    { path: globalSkillsPath, scope: 'global', trusted: true },
  ] },
});
await session.init();
const snapshot = session.getSkills();
for await (const event of session.runSkill('review-guide', '审查修改')) {
  // 宿主自行消费 SessionEvent，Core 不读终端。
}
```

Core 不隐式读取 home，不自动信任项目。技能控制工具随会话集合注册，禁止用同名插件冒充。无 Store 时用完整内存事务提交，事件 persistence=memory；提供 Store 时三类消息逐消息 append，skillSource v1 是 TextBlock/ToolResultBlock 的可选扩展，无 schema 或记录类型升级。旧/未知来源保持普通文本，自定义 Store 丢字段不会恢复授权。原文件 contentDigest 保留 BOM/换行，renderedDigest 校验实际包装文本。

当前运行完整正文作为事务单元保护；投影被钩子改写或移除时停止。旧轮次正文移出摘要投影后生成 requires_reload 事实，最多50条并标记遗漏；不重放脚本、不继承旧权限。同轮完整正文仍在实际投影中时可返回 already_present 引用，工具事务仍正常闭合。

## 终端过程详情

默认 summary 显示思考状态、工具脱敏参数摘要/结果状态/耗时与技能名称；所有 text_delta 完整显示，错误、取消、预算异常及审批始终可见。TTY Ctrl+O 展开本轮详情并影响后续过程，缓存默认最多1 MiB UTF-8，超限明确标记；不修改 Core 历史。

工具行仅在可靠的有界锚点内回写；resize 重算宽度并使旧锚点失效。审批、菜单、提示符或其他输出打断后，详情以带标签快照追加。收起只改变后续显示，不能回收任意 scrollback。Ctrl+O 由同一 CliInputCoordinator 路由，菜单/密钥/审批期间禁用。

REPL 和 one-shot 均支持 `--output-detail summary|detailed`。非 TTY detailed 输出完整协议公开思考、工具输入/结果和回答，不受1 MiB缓存截断，没有 ANSI 或动态计时；不输出签名、加密状态或凭空生成思考。debug 独立 stderr，仍过滤终端控制序列并脱敏敏感字段。
