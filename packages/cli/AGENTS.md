# AGENTS.md — `@kiturone/kapibala-cli` (`kpbl`) 约束

- **兼容转发 barrel 边界**：CLI 同名子路径导出（`protocol` / `view-model` / `transport` / `client` / `host`）只是面向 npm 消费者的兼容转发 barrel，唯一实现真源在 `packages/host`，严禁往兼容 barrel 塞业务逻辑；CLI 应用层统一经 `@kiturone/kapibala-host/internal` 消费装配面。
- **模型目录与密钥读写真源**：`/model` 菜单与冷启动向导只从 `@kiturone/kapibala-host/host`（`BUILTIN_PROFILES` / `providers.ts`）读取，禁止硬编码模型 id 清单；厂商推断、密钥读取与写入必须复用 `packages/host`（改前必读 `packages/host/AGENTS.md`）。
- **斜杠命令补全契约**：新增或改名斜杠命令时，必须同步检查 CLI 与 `packages/desktop/e2e` 中命令补全用例的输入前缀是否产生歧义。
