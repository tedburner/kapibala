/** Vite 将品牌 SVG 作为资源 URL 导入；Renderer 不读取文件系统。 */
declare module '*.svg' {
  const source: string;
  export default source;
}

/** Vite 异步打包 `@xterm/xterm` 视口基础样式表。 */
declare module '@xterm/xterm/css/xterm.css' {}
