import {
  type DesktopError,
  LIMITS,
  type Method,
  NOTIFICATION,
  type Notification,
  type Output,
  PARAMS,
  type Params,
  RESULTS,
  ReplySchema,
  RequestSchema,
} from './contracts.js';
import { BoundedPeer, type ControlIdentity, type Lane } from './transport.js';

/** 控制请求和小型状态回复有独立额度，不能被正文或快照排队堵塞。 */
export const CONTROL_METHODS = new Set<Method>([
  'app.cancelUpdateDownload',
  'app.requestQuit',
  'app.reconnect',
  'app.reload',
  'run.cancel',
  'run.status',
  'session.close',
  'approval.reply',
  'presentation.installed',
  'presentation.unsubscribe',
  'external.cancel',
  'external.close',
  'external.approve',
  'external.unsubscribe',
]);
interface Pending {
  method: Method;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
/** 每跳的命名业务 RPC；超时不重试写操作，迟到回复只丢弃，不启动第二次执行。 */
export class RpcEndpoint {
  readonly peer: BoundedPeer;
  private readonly pending = new Map<string, Pending>();
  private inFlight = 0;
  private dataInFlight = 0;
  constructor(
    identity: ControlIdentity,
    post: (frame: string) => void,
    private readonly notify: (event: Notification) => void | Promise<void>,
    private readonly handle?: (
      method: Method,
      params: unknown,
      selection?: string,
    ) => unknown | Promise<unknown>,
    onClose: (reason: string) => void = () => {},
    private readonly allowSelection = false,
  ) {
    this.peer = new BoundedPeer(
      identity,
      post,
      (body, lane) => this.receive(body, lane),
      (reason) => {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(reason));
        }
        this.pending.clear();
        onClose(reason);
      },
    );
  }
  /** selection 仅供 Main 到 Host 的原生目录结果；页面桥接不暴露此参数。 */
  call<M extends Method>(method: M, params: Params<M>, selection?: string): Promise<Output<M>> {
    const control = CONTROL_METHODS.has(method);
    const ordinary = [...this.pending.values()].filter(
      (item) => !CONTROL_METHODS.has(item.method),
    ).length;
    if (this.pending.size >= LIMITS.requests || (!control && ordinary >= LIMITS.requests - 16))
      return Promise.reject(new Error('REQUEST_LIMIT'));
    const parsed = PARAMS[method].parse(params);
    const requestId = crypto.randomUUID();
    const timeoutMs =
      method === 'app.downloadUpdate'
        ? LIMITS.downloadTimeout
        : method === 'external.open' ||
            method === 'external.prompt' ||
            method === 'external.setConfig' ||
            method === 'worktree.create' ||
            method === 'worktree.applyMerge'
          ? LIMITS.externalOpenTimeout
          : LIMITS.requestTimeout;
    return new Promise<Output<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('REQUEST_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(requestId, {
        method,
        resolve: (value) => resolve(value as Output<M>),
        reject,
        timer,
      });
      void this.peer
        .send(
          {
            kind: 'request',
            requestId,
            method,
            params: parsed,
            ...(selection === undefined ? {} : { selection }),
          },
          CONTROL_METHODS.has(method) ? 'control' : 'data',
        )
        .catch((error) => {
          const pending = this.pending.get(requestId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(requestId);
            reject(error);
          }
        });
    });
  }
  /** Host 公共通知经 schema 二次校验；任何未知字段都不能通过中继成为 DTO。 */
  sendEvent(event: Notification, lane: Lane = 'data'): Promise<void> {
    return this.peer.send({ kind: 'notification', event: NOTIFICATION.parse(event) }, lane);
  }
  private async receive(body: unknown, lane: Lane): Promise<void> {
    if (!body || typeof body !== 'object') throw new Error('INVALID_PAYLOAD');
    const value = body as Record<string, unknown>;
    if (value.kind === 'reply') {
      const reply = ReplySchema.parse(value);
      const pending = this.pending.get(reply.requestId);
      if (!pending) return;
      this.pending.delete(reply.requestId);
      clearTimeout(pending.timer);
      if (!reply.ok) {
        pending.reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }));
        return;
      }
      try {
        pending.resolve(RESULTS[pending.method].parse(reply.result));
      } catch {
        pending.reject(new Error('INVALID_REPLY'));
      }
      return;
    }
    if (value.kind === 'notification') {
      if (Object.keys(value).some((key) => key !== 'kind' && key !== 'event'))
        throw new Error('INVALID_PAYLOAD');
      await this.notify(NOTIFICATION.parse(value.event));
      return;
    }
    const { selection, ...requestValue } = value;
    if (
      selection !== undefined &&
      (!this.allowSelection || typeof selection !== 'string' || selection.length > 32_768)
    )
      throw new Error('INVALID_PAYLOAD');
    const request = RequestSchema.parse(requestValue);
    if (!this.handle || (lane === 'control' && !CONTROL_METHODS.has(request.method)))
      throw new Error('INVALID_PAYLOAD');
    const params = PARAMS[request.method].parse(request.params);
    const control = CONTROL_METHODS.has(request.method);
    if (
      this.inFlight >= LIMITS.requests ||
      (!control && this.dataInFlight >= LIMITS.requests - 16)
    ) {
      void this.peer
        .send(
          {
            kind: 'reply',
            requestId: request.requestId,
            ok: false,
            error: safeError(new Error('REQUEST_LIMIT')),
          },
          lane,
        )
        .catch(() => this.peer.close('OUTPUT_CONGESTED'));
      return;
    }
    this.inFlight++;
    if (!control) this.dataInFlight++;
    // 接收 ACK 只表示已校验并进入有界处理；业务清理等待不能占住控制通道的接收链。
    void (async () => {
      let reply: unknown;
      try {
        const result = RESULTS[request.method].parse(
          await this.handle!(request.method, params, selection as string | undefined),
        );
        reply = { kind: 'reply', requestId: request.requestId, ok: true, result };
      } catch (error) {
        reply = { kind: 'reply', requestId: request.requestId, ok: false, error: safeError(error) };
      }
      const maxReplyBytes = (lane === 'data' ? LIMITS.frame : LIMITS.controlWindow) - 512;
      if (new TextEncoder().encode(JSON.stringify(reply)).byteLength > maxReplyBytes) {
        reply = {
          kind: 'reply',
          requestId: request.requestId,
          ok: false,
          error: safeError(new Error('SNAPSHOT_TOO_LARGE')),
        };
      }
      await this.peer.send(reply, lane);
    })()
      .catch(() => this.peer.close('OUTPUT_CONGESTED'))
      .finally(() => {
        this.inFlight--;
        if (!control) this.dataInFlight--;
      });
  }
}

const messages: Record<string, string> = {
  REQUEST_LIMIT: '请求额度已满，请等待当前操作完成；停止和清理仍使用保留容量。',
  TRUST_REQUIRED: '空间尚未信任，请核对目录后确认信任。',
  PROFILE_UNAVAILABLE: '所选模型不可用，请检查模型配置后重新选择。',
  CONFIG_REQUIRED: '模型尚未配置，请在设置中选择模型并配置凭证。',
  CONFIG_INVALID: '配置无法安全读取，请修复配置后重试。',
  SETTINGS_BUSY: '全局配置正在修改，请稍后重试；遗留锁需确认写入进程退出后人工处理。',
  SETTINGS_CONFLICT: '确认内容已变化，请重新预览并确认。',
  SAVE_AS_NEW_PROFILE: '协议、端点或凭证来源发生变化，请使用新的 Profile ID 另存。',
  WORKSPACE_KIND_INVALID: '此目录属于默认空间，请选择项目文件夹。',
  WORKSPACE_NOT_FOUND: '空间登记已失效，请重新选择。',
  WORKSPACE_UNAVAILABLE: '项目目录不可用，请检查目录权限后重新选择。',
  DEFAULT_WORKSPACE_UNAVAILABLE: '无法使用默认空间，请检查目录权限或重定向后重试。',
  PATH_IDENTITY_CHANGED: '空间的物理目录已变化，请重新选择并确认信任。',
  HISTORY_READ_LIMIT: '历史超过读取预算，原文件保持不变，请处理历史文件后重新打开。',
  SESSION_NOT_FOUND: '会话不属于当前空间或已失效，请重新打开。',
  SESSION_BUSY: '会话仍在运行或清理，请等待完成后重试。',
  SESSION_IN_USE: '会话仍在运行，请先停止任务再归档或删除。',
  SESSION_TITLE_REQUIRED: '会话标题不能为空，请填写标题后重试。',
  SESSION_CLOSED: '会话已关闭，请重新打开后再试。',
  SESSION_LOCKED: '会话正被其它进程占用，请关闭占用它的客户端后重试。',
  SESSION_CLEANUP_FAILED: '会话清理未完成，允许同时运行的任务数尚未释放，请重试清理。',
  SESSION_LIMIT: `已打开 ${LIMITS.sessions} 个会话，请明确关闭空闲会话后重试。`,
  RUN_LIMIT: `已有 ${LIMITS.runs} 个任务运行，请等待完成后重试。`,
  OPERATION_CONFLICT: '该发送标识已用于其它内容，请查询原运行状态。',
  OPERATION_UNKNOWN: '旧运行的结果未知，请核对历史，不要自动重发。',
  OPERATION_LIMIT: '未完成的操作记录达到上限，请等待运行结束后重试；若持续出现请重启应用。',
  SNAPSHOT_TOO_LARGE: '展示快照超过预算，已禁用发送；可停止运行或处理历史后重新打开。',
  PRESENTATION_STALE: '展示已失效，请重新同步后发送。',
  APPROVAL_EXPIRED: '审批已过期或已处理，请查看当前状态。',
  RESOURCE_LIMIT: '资源额度已用完，请关闭不再使用的资源后重试。',
  HOST_UNAVAILABLE: '执行 Host 已断开，清理状态未知，请核查进程后重新连接。',
  INVALID_REQUEST: '请求内容无效，请检查输入后重试。',
  OUTPUT_CONGESTED: '展示接收拥塞，请停止运行或重新同步。',
  REQUEST_TIMEOUT: '请求等待超时，操作可能已受理，请先查询当前状态。',
  RECOVERY_REQUIRED: '上次执行未确认完成清理，请核查残留工具进程后确认恢复。',
  SETTINGS_READ_FAILED: '无法安全读取全局配置，请修复原文件后重试。',
  REWIND_UNAVAILABLE: '当前没有可重试的上一轮对话，或该会话不支持回退重试。',
  BRANCH_UNAVAILABLE: '当前会话不支持创建附带背景摘要的分支。',
  INVALID_BRANCH_SUMMARY: '分支摘要内容不能为空。',
  REFERENCE_SESSION_NOT_FOUND: '找不到被引用的会话，请刷新候选列表后重试。',
  REFERENCE_PROJECT_MISMATCH: '仅支持引用同一项目空间内的会话。',
  REFERENCE_ARCHIVED: '被引用的会话已归档，请先恢复后再引用。',
  REFERENCE_RECORD_NOT_FOUND: '被引用的消息不存在或不在当前分支上。',
  REFERENCE_UNSUPPORTED_ROLE: '只能引用用户或助手可见正文。',
  REFERENCE_BUDGET_EXCEEDED: '单轮跨会话引用数量或长度超出上限，请精简后重试。',
  DELEGATION_BUSY: '该委派子任务仍在运行中。',
  DELEGATION_NOT_RETAINED: '该子任务未保留独立会话，无法续聊。',
  DELEGATION_LIMIT_EXCEEDED: '保留型委派会话已达上限，请先清理旧会话。',
  DELEGATION_NOT_FOUND: '找不到指定的委派子任务。',
  INTERACTION_UNKNOWN: '该交互请求已结束或已过期，无需重复提交。',
  INTERACTION_LIMIT: '待确认的交互过多，请先处理当前提示后再试。',
  MCP_CONFIG_INVALID: 'MCP 配置文件格式有误，请检查并修复 mcp.json 后重试。',
  MCP_SERVER_NOT_FOUND: '未找到目标 MCP 服务器，请刷新配置列表后重试。',
  MCP_PROJECT_UNTRUSTED: '当前项目尚未确认信任，无法写入项目级 MCP 配置。',
  EXTERNAL_INVALID_COMMAND: '外部代理命令或参数包含非法路径或控制字符，请使用裸命令名或绝对路径。',
  EXTERNAL_COMMAND_NOT_FOUND: '未在系统 PATH 或常见安装目录中找到该外部代理可执行程序。',
  EXTERNAL_UNSUPPORTED_SHIM:
    'Windows 下不支持非标准脚本垫片，请填写原生 .exe 或标准 npm/pnpm 命令。',
  EXTERNAL_NODE_NOT_FOUND: '外部代理脚本需要 Node.js 运行环境，但未找到 node 可执行文件。',
  EXTERNAL_FRAME_LIMIT: '外部代理单行输出超过 8 MiB 安全帧上限，连接已断开。',
  EXTERNAL_NON_JSON_FLOOD: '外部代理持续输出非协议文本，疑似误填了交互式终端命令而非协议模式。',
  EXTERNAL_PROTOCOL_ERROR: '当前外部代理协议握手失败或会话处于只读归档状态，请新建外部会话。',
  EXTERNAL_AUTH_REQUIRED: '外部代理尚未登录或缺少环境变量凭据，请先完成终端登录。',
  EXTERNAL_TIMEOUT: '外部代理响应超时，已自动终止该轮操作。',
  EXTERNAL_ABORTED: '外部代理操作已取消。',
  EXTERNAL_CONFIG_BUSY: '外部代理配置正在修改，请稍后重试。',
  EXTERNAL_CONFIG_CORRUPT: '外部代理配置文件损坏，已拒绝覆盖写入；请检查 ~/.kapibala/external/。',
  EXTERNAL_CONFIG_INVALID: '外部代理配置校验未通过（禁止明文密钥、相对路径或与内置 ID 重名）。',
  EXTERNAL_HARNESS_DISABLED: '所选外部代理当前已停用，请先在设置面板「外部代理」中启用。',
  EXTERNAL_APPROVAL_EXPIRED: '该外部审批请求已处理或已超时过期。',
  EXTERNAL_CAPACITY:
    '外部代理并发进程数（4）或历史保留数（50）已达上限，请先关闭或删除已结束会话。',
  EXTERNAL_WORKSPACE_BUSY: '当前工作区已有运行中的外部代理会话，请等待其完成或取消后再试。',
  EXTERNAL_SESSION_BUSY: '该外部代理会话正在执行或等待审批，不能并发发送新消息。',
  EXTERNAL_UNTRUSTED_WORKSPACE: '当前工作区尚未确认信任，拒绝运行外部代理。',
  CHECKPOINT_RESTORE_CONFLICT:
    '部分文件在检查点生成后被手动修改，已暂停回滚以保护本地改动；如需覆盖请确认强制还原。',
  CHECKPOINT_UNSAFE_ROOT: '当前目录属于系统高危根路径，已自动禁用工作区检查点。',
  CHECKPOINT_GIT_UNAVAILABLE: '未检测到可用的 Git 命令，无法使用工作区检查点。',
  CHECKPOINT_GIT_FAILED: '工作区检查点 Git 操作失败，请检查磁盘空间与目录权限。',
  CHECKPOINT_LOCK_TIMEOUT: '等待工作区检查点锁超时，请稍后重试。',
  CHECKPOINT_NOT_FOUND: '未找到指定的工作区检查点记录。',
  CHECKPOINT_SYMLINK_ESCAPE: '检测到符号链接越界风险，已中止检查点还原。',
  WORKTREE_NOT_GIT_REPO: '当前空间不是有效的 Git 仓库，无法创建受管工作树。',
  WORKTREE_REPO_UNMERGED: '主仓库存在未决的合并、变基或冲突状态，请先处理后再创建工作树。',
  WORKTREE_INVALID_BASE_REF: '指定的基线分支或提交在本地不存在。',
  WORKTREE_INVALID_BRANCH: '工作树分支名称不符合 Git 引用规范。',
  WORKTREE_BRANCH_EXISTS: '同名本地分支已存在，请更换分支名。',
  WORKTREE_CAPACITY_EXCEEDED: '受管工作树短路径桶分配冲突过多，请清理闲置工作树后重试。',
  WORKTREE_LINK_INVALID: '受管工作树双向 Git 回链校验失败，已拒绝访问该目录。',
  WORKTREE_NOT_FOUND: '找不到指定的受管工作树记录。',
  WORKTREE_ACTIVE_RUN: '该工作树仍有运行中的本地或外部任务，请先停止任务后再执行此操作。',
  WORKTREE_FENCED: '该工作树正处于合并或移除门闩保护期，暂不接受新任务。',
  WORKTREE_BUSY: '工作树目录正被系统进程占用，请关闭相关终端或编辑器后重试。',
  WORKTREE_MERGE_STALE_PREVIEW: '工作树或主仓库状态已发生变化，请刷新合并预览后再确认合并。',
  WORKTREE_DETACHED_MAIN: '主工作区处于游离 HEAD 状态，无法执行目标分支快进合并。',
  WORKTREE_MAIN_BRANCH_MISMATCH: '主工作区当前检出分支与工作树基线分支不一致，请先切回基线分支。',
  WORKTREE_MAIN_DIRTY: '主工作区在受影响文件上存在未提交修改，无法安全快进合并。',
  WORKTREE_GIT_UNAVAILABLE: '未检测到可用的 Git 命令，无法管理工作树。',
  WORKTREE_GIT_FAILED: '执行 Git 工作树操作失败。',
  WORKTREE_ESCAPE: '请求路径越出了受管工作树边界。',
  WORKSPACE_ESCAPE: '请求的文件路径越出了工作区安全边界。',
  TERMINAL_LIMIT_REACHED: '活跃终端数量已达上限，请先关闭闲置终端。',
  TERMINAL_NOT_FOUND: '目标终端不存在或已关闭。',
  TERMINAL_UNAVAILABLE: '当前环境无法启动交互式终端。',
  PERMISSION_DENIED: '出于安全策略限制，禁止读取该受保护文件（如 .kapibala 或 .env 密钥文件）。',
  FILE_NOT_FOUND: '目标文件不存在或已被移除。',
  FILE_IS_DIRECTORY: '目标路径是目录，请选择具体文件查看。',
  FORBIDDEN: '请求来源或资源归属不合法。',
  INTERNAL_ERROR: '操作未完成，请检查配置和目录后重试。',
};
const ALLOWED_TERMINAL_LIMIT_MESSAGES = new Set([
  '单会话最多同时开启 3 个终端。',
  '全局活跃终端已达上限（8 个），请先关闭闲置终端。',
]);

/** 不传递原始异常文字、堆栈或路径中的凭据；未知错误只给固定安全说明。 */
export function safeError(error: unknown): DesktopError {
  const candidate = error as
    | { code?: string; message?: string; safeMessage?: string; name?: string }
    | undefined;
  const messagePrefix = candidate?.message?.split(':')[0]?.trim();
  const code =
    candidate?.code && messages[candidate.code]
      ? candidate.code
      : candidate?.message && messages[candidate.message]
        ? candidate.message
        : messagePrefix && messages[messagePrefix]
          ? messagePrefix
          : candidate?.code === 'ENOENT' || candidate?.code === 'EACCES'
            ? 'WORKSPACE_UNAVAILABLE'
            : candidate?.message?.includes('全局配置存在但无法安全读取')
              ? 'SETTINGS_READ_FAILED'
              : candidate?.name === 'ZodError'
                ? 'INVALID_REQUEST'
                : 'INTERNAL_ERROR';
  // SESSION_LOCKED 附加持有者 pid（core 内部 message 已含，属可安全透出的整数）：
  // 提示里给出可核对的对象与自愈途径，避免用户面对「关闭客户端」却无客户端可关。
  const lockPid =
    code === 'SESSION_LOCKED' && candidate?.message
      ? /pid=(\d+)/.exec(candidate.message)?.[1]
      : undefined;
  const specificTerminalLimit =
    code === 'TERMINAL_LIMIT_REACHED'
      ? [candidate?.safeMessage, candidate?.message].find(
          (msg): msg is string =>
            typeof msg === 'string' && ALLOWED_TERMINAL_LIMIT_MESSAGES.has(msg),
        )
      : undefined;
  const message = lockPid
    ? `${messages.SESSION_LOCKED.replace('。', '')}（持有者 pid=${lockPid}）；若确认该进程已退出，重启应用会自动清理残留锁。`
    : (specificTerminalLimit ?? messages[code]);
  return { code, message };
}
