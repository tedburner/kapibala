import type { DesktopAPI } from '../shared/contracts.js';
declare global {
  /** 页面只持有命名业务 API；不会获得端口、任意 IPC 或 Node 对象。 */
  interface Window {
    kapibala: DesktopAPI;
  }
}
