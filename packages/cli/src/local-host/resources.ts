import fs from 'node:fs';
import os from 'node:os';
import { WorkspaceLeaseCoordinator } from '@kiturone/kapibala';
import {
  CheckpointService,
  ExecutionRootCoordinator,
  WorktreeService,
  createManagedSessionResources,
  detectProjectRoot,
} from '@kiturone/kapibala-host/internal';
import type { ResourceFactory, SessionResources } from './types.js';
export { loadCredentialSecrets } from '@kiturone/kapibala-host/internal';

/** 本地协议用户目录与共享检查点/工作树协调服务覆盖项；未传时在同实例内共享单例。 */
export interface ResourceFactoryOptions {
  homeDir?: string;
  checkpoints?: CheckpointService;
  worktrees?: WorktreeService;
  executionCoordinator?: ExecutionRootCoordinator;
}

/** 本地协议的薄适配器（自 v0.1.4 起为整数版本 2）；按既有规则确定 Git 根后复用精确身份装配与同一宿主写租约。 */
export function createResourceFactory(options: ResourceFactoryOptions = {}): ResourceFactory {
  const leases = new WorkspaceLeaseCoordinator();
  const home = options.homeDir ?? os.homedir();
  const coordinator =
    options.executionCoordinator ??
    options.worktrees?.coordinator ??
    new ExecutionRootCoordinator();
  const checkpoints = options.checkpoints ?? new CheckpointService({ homeDir: home });
  const worktrees = options.worktrees ?? new WorktreeService({ homeDir: home, coordinator });
  return {
    async create(workspaceRoot, conversationId, approval, hooks) {
      const projectRoot = detectProjectRoot(fs.realpathSync.native(workspaceRoot));
      const executionRoot = hooks?.worktree ? hooks.worktree.worktreePath : projectRoot;
      const created = await createManagedSessionResources({
        projectRoot,
        workspaceRoot: executionRoot,
        ...(hooks?.worktree ? { worktree: hooks.worktree } : {}),
        checkpoints,
        worktrees,
        executionCoordinator: coordinator,
        homeDirectory: home,
        conversationId,
        approvalChannel: approval,
        leaseCoordinator: leases,
        ...(hooks?.isHostIdle ? { isHostIdle: hooks.isHostIdle } : {}),
        ...(hooks?.onAutoResume ? { onAutoResume: hooks.onAutoResume } : {}),
      });
      return {
        ...created,
        run: (input, signal, references, runOptions) =>
          (created.run as SessionResources['run'])(input, signal, references, runOptions),
      };
    },
  };
}
