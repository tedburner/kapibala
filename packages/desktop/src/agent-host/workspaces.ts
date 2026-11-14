import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SessionManager, resolveSessionProject } from '@kiturone/kapibala';
import { isProjectTrusted, loadSettings, trustProject } from '@kiturone/kapibala-host/host';
import { LIMITS, ProjectNameSchema, type Workspace } from '../shared/contracts.js';

/** Host 的空间登记簿；页面只能使用随机 ID，路径仅来自 Main 原生选择或固定默认位置。 */
export class Workspaces {
  private readonly records = new Map<string, Workspace>();
  readonly home: string;
  constructor(home: string) {
    if (!path.isAbsolute(home)) throw new Error('HOME_UNAVAILABLE');
    this.home = fs.realpathSync.native(home);
  }
  /** 按约定位置创建默认根，逐层拒绝向外重定向，不在其它目录降级执行。 */
  openDefault(): Workspace {
    try {
      return this.createDefault();
    } catch {
      throw new Error('DEFAULT_WORKSPACE_UNAVAILABLE');
    }
  }
  private createDefault(): Workspace {
    const basePath = path.join(this.home, '.kapibala');
    fs.mkdirSync(basePath, { recursive: true, mode: 0o700 });
    const base = fs.realpathSync.native(basePath);
    // 配置目录本身也属于边界，不能以重定向后的路径作为可信基准。
    if (!same(base, basePath) || !fs.statSync(base).isDirectory())
      throw new Error('DEFAULT_WORKSPACE_UNAVAILABLE');
    let current = base;
    for (const name of ['workspaces', 'default']) {
      const expected = path.join(current, name);
      if (!fs.existsSync(expected)) fs.mkdirSync(expected, { mode: 0o700 });
      const actual = fs.realpathSync.native(expected);
      if (!same(actual, expected) || !fs.statSync(actual).isDirectory())
        throw new Error('DEFAULT_WORKSPACE_UNAVAILABLE');
      current = actual;
    }
    fs.accessSync(current, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    // 默认空间由应用自身创建并独占使用，视为可信根：首次启动把信任写入全局记录，
    // 与 CLI 共用同一份 trustedProjects，之后不再向用户重复确认。
    // 持久化失败（如配置锁遗留）时退回既有的确认流程，不阻断默认空间可用。
    try {
      const settings = loadSettings({ homeDir: this.home, includeProject: false }).settings;
      if (!isProjectTrusted(settings, current))
        trustProject(settings, current, { homeDir: this.home });
    } catch {
      /* 信任持久化失败保留用户确认流程。 */
    }
    return this.register(current, 'default');
  }
  /** 仅 Main 已确认的选择路径可调用；默认目录命中优先于祖先 Git 探测。 */
  registerProject(selection: string): Workspace {
    if (!path.isAbsolute(selection)) throw new Error('WORKSPACE_UNAVAILABLE');
    const actual = fs.realpathSync.native(selection);
    const expected = path.join(this.home, '.kapibala/workspaces/default');
    if (fs.existsSync(expected) && same(actual, fs.realpathSync.native(expected)))
      return this.openDefault();
    return this.register(resolveSessionProject(actual).projectRoot, 'project');
  }
  /** 每次信任、打开和运行前复核登记物理根；失效不能切换到其它空间。 */
  get(id: string, requireTrust = false): Workspace {
    const workspace = this.records.get(id);
    if (!workspace) throw new Error('WORKSPACE_NOT_FOUND');
    if (!same(fs.realpathSync.native(workspace.root), workspace.root))
      throw new Error('PATH_IDENTITY_CHANGED');
    if (workspace.kind === 'default') {
      const base = path.join(this.home, '.kapibala');
      if (!same(fs.realpathSync.native(base), base)) throw new Error('PATH_IDENTITY_CHANGED');
      const expected = path.join(base, 'workspaces/default');
      if (!same(fs.realpathSync.native(expected), expected) || !same(expected, workspace.root))
        throw new Error('PATH_IDENTITY_CHANGED');
    }
    workspace.trusted = isProjectTrusted(
      loadSettings({ homeDir: this.home, includeProject: false }).settings,
      workspace.root,
    );
    if (requireTrust && !workspace.trusted) throw new Error('TRUST_REQUIRED');
    return { ...workspace };
  }
  /** 信任只能针对当前登记根和确认令牌；拒绝不会读取项目配置或启动工具。 */
  confirm(id: string, token: string, accept: boolean): Workspace {
    const workspace = this.get(id);
    if (token !== workspace.trustToken) throw new Error('SETTINGS_CONFLICT');
    if (!accept) return workspace;
    const settings = loadSettings({ homeDir: this.home, includeProject: false }).settings;
    trustProject(settings, workspace.root, { homeDir: this.home });
    return this.get(id);
  }
  /** 创建仅登记显示名与已确认信任，不创建目录或会话；旧的已信任 UI 状态不能自动重新授信。 */
  addProject(id: string, name: string, token: string, acceptTrust: boolean): Workspace {
    name = ProjectNameSchema.parse(name);
    let workspace = this.get(id);
    if (workspace.kind !== 'project') throw new Error('WORKSPACE_KIND_INVALID');
    if (workspace.trustToken !== token) throw new Error('SETTINGS_CONFLICT');
    if (!workspace.trusted) {
      if (!acceptTrust) throw new Error('TRUST_REQUIRED');
      workspace = this.confirm(id, token, true);
    }
    this.records.get(id)!.name = name;
    return this.get(id, true);
  }
  /** 列表与父子会话统一 exact 桶，不在恢复历史时提升工作区根。 */
  manager(id: string): SessionManager {
    const workspace = this.get(id, true);
    return new SessionManager({
      workspaceRoot: workspace.root,
      homeDirectory: this.home,
      projectRootMode: 'exact',
      maxReadBytes: LIMITS.history,
    });
  }
  private register(root: string, kind: Workspace['kind']): Workspace {
    root = fs.realpathSync.native(root);
    if (!fs.statSync(root).isDirectory()) throw new Error('WORKSPACE_UNAVAILABLE');
    const known = [...this.records.values()].find((item) => same(item.root, root));
    if (known) return this.get(known.id);
    const workspace: Workspace = {
      id: randomUUID(),
      kind,
      root,
      name: kind === 'default' ? '默认空间' : path.basename(root),
      trusted: false,
      trustToken: randomUUID(),
    };
    this.records.set(workspace.id, workspace);
    return this.get(workspace.id);
  }
}
function same(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
