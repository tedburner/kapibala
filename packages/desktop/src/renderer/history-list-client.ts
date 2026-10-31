import type { Output } from '../shared/contracts.js';

/** 历史列表请求协调器只记各空间当前页与在途身份；后台刷新保留页码，迟到回复不能覆盖更新选择。 */
export class HistoryListClient {
  private readonly current = new Map<string, { page: number }>();
  constructor(
    private readonly read: (workspaceId: string, page: number) => Promise<Output<'session.list'>>,
    private readonly install: (workspaceId: string, list: Output<'session.list'>) => void,
  ) {}
  /** 显式翻页更新该空间的选择，省略页码则刷新当前页；只有最新请求可以安装或报告错误。 */
  async refresh(workspaceId: string, page?: number): Promise<void> {
    const request = { page: page ?? this.current.get(workspaceId)?.page ?? 1 };
    this.current.set(workspaceId, request);
    try {
      const list = await this.read(workspaceId, request.page);
      if (this.current.get(workspaceId) !== request) return;
      request.page = list.page;
      this.install(workspaceId, list);
    } catch (error) {
      if (this.current.get(workspaceId) === request) throw error;
    }
  }
}
