# AGENTS.md — `@kiturone/kapibala-host` 宿主层与模型配置约束

## 包边界与本地协议

- **宿主层包边界（`packages/host`）**：协议（protocol）、视图模型（view-model）、传输（transport）、客户端（client）与
  managed session 装配（host/）的唯一真源在宿主层包；CLI 的同名子路径导出只是**兼容转发 barrel**（构建时经 tsconfig paths
  从宿主源码内联进 dist，npm 消费者不感知私有包）。CLI 应用层（commands/local-host/tui/入口）经
  `@kiturone/kapibala-host/internal` 消费装配面（显式命名导出清单，禁用 `export *`——多模块重导出同名符号会被 ESM
  静默丢弃，已踩过）；desktop 分层准入（check-desktop 门禁拦截）：renderer 只允许
  `@kiturone/kapibala-host/view-model`，agent-host 允许 `host|view-model|internal` 与命令系统
  `@kiturone/kapibala-cli/commands`（唯一 CLI 反向依赖例外），其余一律拦截。
  新增宿主能力时改宿主包与门禁锚点，不要往 CLI 兼容 barrel 里塞实现。
- 本地协议为整数 `PROTOCOL_VERSION = 2` + 能力集合（旧 `{major,minor}` 报价在握手层即 `INVALID_PARAMS` 拒绝）；协议细节见 `docs/local-protocol.md`。
- 三类专项门禁：`pnpm verify:compat`（历史 tarball × 候选构建四组合）、`pnpm verify:platform`（当前 OS 真实进程 + 三包隔离安装）、`pnpm verify:soak`（PR 10 轮随 verify 必跑；nightly/release 档自 2026-11-20 起仅定时或手动趋势运行，其中 release 档在 `KPBL_RELEASE_STRICT=true` 的严格证据口径下仍需手动运行并由维护者审核）；新增宿主或传输能力时必须同步其断言，不允许用短档或模拟测试替代 Node 20、Windows ACL/ConPTY、POSIX PTY 的真实进程证据。

## 厂商族推断与密钥单副本

- `/model` 的厂商族推断统一走 `packages/host/src/host/settings.ts` 的 `detectProviderFamily`，不要在命令层另写启发式；密钥解析走同族回退（`FAMILY_KEY_ENV`），不做跨厂商兜底。
- **密钥按厂商族共用（一个厂商只需配一次）**：分组键统一走 `credentialGroup()` —— 可识别厂商按 family 归组，`unknown` 退化到按端点 host 隔离（否则多个自建网关会串用同一把 key）；分组展示名走 `describeCredentialGroup()`。
- 同一分组内**只保留一份密钥**：读取走 `resolveApiKeyDetailed(profile, settings)`（第 2 级即"同厂商族已存密钥"），写入走 `updateProfileApiKey()`（自动清理同组冗余副本）。新增任何密钥读取/写入入口都不要绕过这两个函数，否则会出现「更新了 A 的密钥、B 仍在用旧密钥」的静默不一致。

## 内置模型清单（`packages/host/src/host/settings.ts`）

- `BUILTIN_PROFILES` 是唯一的内置模型真源（真源文件 `packages/host/src/host/settings.ts`，经 `@kiturone/kapibala-host/host` 公共导出）（现为 8 家厂商 / 20 个模型），默认模型 `DEFAULT_MODEL_ID = 'deepseek-flash'`。
  厂商展示元数据（名称 / 描述 / 索要密钥的提示语）在 `packages/host/src/host/providers.ts`，**`/model` 菜单与冷启动向导都从这里取**，
  不要在命令层或向导里再硬编码一份模型 id 清单 —— 那会退化成模型换代后 `BUILTIN_PROFILES.find(...)!` 的运行时崩溃（已发生过一次）。
- ⚠️ **改动 `BUILTIN_PROFILES` 必须同步两件事**：
  1. `BUILTIN_CATALOG_VERSION` **+1**（不加版本号，`migrateBuiltinCatalog` 不会触发，老用户菜单里会一直挂着已退役的模型）；
  2. 每个被删掉的 id 都要在 `LEGACY_PROFILE_REDIRECT` 里补一条重定向。
- ⚠️ `loadSettings` 是「**全局覆盖内置**」的浅合并：只改 `BUILTIN_PROFILES` **不会影响**已经落盘的 `~/.kapibala/settings.json`。
  存量配置靠启动时的 `migrateGlobalSettingsCatalog()` 升级（见 `packages/cli/src/index.ts` 步骤 0，失败不阻断启动）。
- ⚠️ **「读全局 → 改一处 → 写回」必须用 `loadGlobalSettingsForWrite()`，不能用 `loadSettings()`**。
  `loadSettings` 的返回值已与内置清单合并，整份写回会把用户从未启用过的内置模型物化进配置文件（实测 profile 数 9 → 10）。
  `loadGlobalSettingsForWrite()` 在文件不存在时使用不含内置 profile 的 `createUserSettingsSkeleton()`，文件损坏或非法时中止写入；`readRawGlobalSettings()` 仅用于迁移等允许自行处理缺失/非法状态的只读流程。
- `migrateBuiltinCatalog()` 是纯函数，只做三件事：**重定向**旧 id（密钥一并带过去，绝不丢）、**同步**已存 profile 的目录字段（`apiKey` 原样保留）、
  **重映射** `defaultModel` / `modelRouting` 里的旧引用。它**刻意不新增**内置 profile —— 内置模型由代码侧提供，写进用户文件只会得到一份过期的快照。
