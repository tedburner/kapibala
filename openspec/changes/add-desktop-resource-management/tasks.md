# Tasks

## 1. 宿主层资源服务

- [ ] 1.1 新建 `packages/host/src/host/resource/mcp-config.ts`：全局 `mcp.json` 读取（复用 `resolveMcpConfig` 校验）、`mutateGlobalMcpConfig` 短事务（锁 + 校验 + 原子写回）、诊断透出；所有导出符号带中文 JSDoc（约束/边界/为什么）
- [ ] 1.2 新建 `packages/host/src/host/resource/skills-catalog.ts`：无会话技能清单扫描（目录侧复用既有发现/信任函数，输入 cwd/homeDir/projectRoot/信任状态）、诊断透出、与 `getCliSkillOptions` 同源
- [ ] 1.3 `internal.ts` 门面登记新服务导出（显式命名，禁用 `export *`）
- [ ] 1.4 宿主层单测：MCP 事务的校验拒绝/并发不覆盖/纯禁用覆盖语义；技能清单与 `getCliSkillOptions` 输出一致性、未信任排除、诊断脱敏（含密钥样例）

## 2. CLI 命令收敛到同一服务

- [ ] 2.1 `commands/skills.ts` 与 `commands/mcp.ts` 的读取实现改为调用 resource 服务，删除重复读取逻辑；命令行为与输出保持不变（对照既有命令测试）
- [ ] 2.2 跑 CLI 全量测试与 `pnpm check-architecture` / `check-cli-boundary`，确认宿主层边界规则不破

## 3. 桌面 RPC 契约与服务

- [ ] 3.1 `shared/contracts.ts` 新增 `resources.*` 方法表（zod PARAMS/RESULTS：readMcp / saveMcpServer / deleteMcpServer / toggleMcpServer / readSkills / setSkillsEnabled / setSkillDisabled），脱敏字段进 schema 说明
- [ ] 3.2 `agent-host/` 新增 ResourceService（组合 workspaces 信任状态 + 宿主层 resource 服务），desktop-host switch 注册分发
- [ ] 3.3 桌面单测：RPC 参数校验、信任状态联动（未信任项目排除）、删除/启停写回与错误路径

## 4. 设置面板 UI

- [ ] 4.1 `settings-dialog.tsx` 新增「资源管理」区块：MCP 子面板（清单/空态/诊断/CRUD 表单/启停开关/删除确认）与 Skills 子面板（开关/清单/诊断/逐技能禁用），遵循 check-desktop UI 规则（Kumo 组件、语义 token、无原生交互元素）
- [ ] 4.2 面板文案明确「启停与开关对新建会话生效」；写回动作失败展示服务端原因，不静默
- [ ] 4.3 e2e：MCP 空态与新增校验拒绝路径、未信任项目排除展示、Skills 开关关闭后新会话无技能工具（复用既有 e2e 沙箱模式）

## 5. 门禁与文档

- [ ] 5.1 `check-desktop` 现有规则回归（UI 门禁/依赖白名单不变）；`check-public-api` 若宿主公共面变化则 `--update` + `docs/sdk-compatibility.md` 同步（预期不变：资源服务走 internal 与桌面 RPC）
- [ ] 5.2 全链 `pnpm verify` + `pnpm verify:desktop`；手动验收清单：全局 MCP 增改删启停、未信任排除展示、Skills 开关/禁用对真实会话生效
- [ ] 5.3 文档：`docs/skills.md` 与 MCP 相关文档补「桌面资源管理面」小节；发布说明按发布流程另行起草
