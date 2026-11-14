/**
 * 兼容转发入口：协议层已迁至 @kiturone/kapibala-host（packages/host/src/protocol）。
 * 已发布的 `@kiturone/kapibala-cli/protocol` 子路径保持原导出面不变；构建时宿主层
 * 会被内联进本包 dist，npm 消费者不需要安装未发布的宿主包。
 */
export * from '@kiturone/kapibala-host/protocol';
