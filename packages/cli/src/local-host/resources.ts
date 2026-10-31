import fs from 'node:fs';
import os from 'node:os';
import { WorkspaceLeaseCoordinator } from '@kiturone/kapibala';
import { createManagedSessionResources } from '../host/managed-session.js';
import { detectProjectRoot } from '../project-root.js';
import type { ResourceFactory } from './types.js';
export { loadCredentialSecrets } from '../host/managed-session.js';

/** 本地协议用户目录覆盖；未传时保留原有系统 home 规则。 */
export interface ResourceFactoryOptions {
  homeDir?: string;
}

/** wire 1.0 的薄适配器；按既有规则确定 Git 根后复用精确身份装配与同一宿主写租约。 */
export function createResourceFactory(options: ResourceFactoryOptions = {}): ResourceFactory {
  const leases = new WorkspaceLeaseCoordinator();
  return {
    create(workspaceRoot, conversationId, approval) {
      return createManagedSessionResources({
        workspaceRoot: detectProjectRoot(fs.realpathSync.native(workspaceRoot)),
        homeDirectory: options.homeDir ?? os.homedir(),
        conversationId,
        approvalChannel: approval,
        leaseCoordinator: leases,
      });
    },
  };
}
