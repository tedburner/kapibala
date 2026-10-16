import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContextManager } from '../src/context/manager.js';
import { SessionManager } from '../src/context/session-manager.js';
import { AgentSession } from '../src/context/session/index.js';
import {
  computeProjectKey,
  isPathInside,
  isSamePath,
  normalizeDriveLetter,
  resolveWorkspaceContext,
  toNativePhysicalPath,
} from '../src/context/workspace.js';
import { KapibalaError } from '../src/errors/index.js';
import type { ModelProfile, ModelProvider, ModelRequest } from '../src/index.js';

class DummyProvider implements ModelProvider {
  readonly name = 'dummy-provider';
  async *create(_req: ModelRequest) {
    yield { type: 'text_delta' as const, text: 'ok' };
    yield { type: 'message_stop' as const };
  }
  assembleToolResults() {
    return [];
  }
}

const dummyProfile: ModelProfile = {
  id: 'dummy-model',
  name: 'Dummy Model',
  provider: 'openai-compatible',
  baseURL: 'http://localhost:8080/v1',
  apiKeyEnv: 'NONE',
  modelName: 'dummy',
};

describe('Workspace Identity & Path Canonicalization (Milestone A - Task 1)', () => {
  it('throws WORKSPACE_ROOT_REQUIRED when AgentSession has neither workspaceRoot nor rootDir', () => {
    expect(() => {
      new AgentSession({
        defaultProfile: dummyProfile,
        defaultProvider: new DummyProvider(),
      });
    }).toThrowError(
      expect.objectContaining({
        name: 'KapibalaError',
        code: 'WORKSPACE_ROOT_REQUIRED',
      }),
    );
  });

  it('throws WORKSPACE_ROOT_REQUIRED when SessionManager has no workspaceRoot, projectRoot, or cwd', () => {
    expect(() => {
      new SessionManager({});
    }).toThrowError(
      expect.objectContaining({
        name: 'KapibalaError',
        code: 'WORKSPACE_ROOT_REQUIRED',
      }),
    );
  });

  it('throws WORKSPACE_ROOT_REQUIRED when ContextManager options lack projectRoot', () => {
    expect(() => {
      new ContextManager({
        conversationId: 'test-convo',
      } as never);
    }).toThrowError(
      expect.objectContaining({
        name: 'KapibalaError',
        code: 'WORKSPACE_ROOT_REQUIRED',
      }),
    );
  });

  it('rejects relative paths with CONFIG_INVALID across workspace options', () => {
    expect(() => {
      resolveWorkspaceContext({ workspaceRoot: './relative-path' });
    }).toThrowError(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
      }),
    );

    expect(() => {
      resolveWorkspaceContext({ rootDir: 'relative/dir' });
    }).toThrowError(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
      }),
    );

    const tempRoot = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-ws-test-')),
    );
    try {
      expect(() => {
        resolveWorkspaceContext({
          workspaceRoot: tempRoot,
          executionCwd: 'relative/cwd',
        });
      }).toThrowError(
        expect.objectContaining({
          code: 'CONFIG_INVALID',
        }),
      );

      expect(() => {
        resolveWorkspaceContext({
          workspaceRoot: tempRoot,
          cwd: 'relative/legacy-cwd',
        });
      }).toThrowError(
        expect.objectContaining({
          code: 'CONFIG_INVALID',
        }),
      );

      expect(() => {
        resolveWorkspaceContext({
          workspaceRoot: tempRoot,
          projectRoot: 'relative/proj',
        });
      }).toThrowError(
        expect.objectContaining({
          code: 'CONFIG_INVALID',
        }),
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('detects and rejects conflicting workspaceRoot and rootDir aliases', () => {
    const tempA = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-ws-a-')));
    const tempB = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-ws-b-')));
    try {
      expect(() => {
        resolveWorkspaceContext({
          workspaceRoot: tempA,
          rootDir: tempB,
        });
      }).toThrowError(
        expect.objectContaining({
          code: 'CONFIG_INVALID',
        }),
      );
    } finally {
      fs.rmSync(tempA, { recursive: true, force: true });
      fs.rmSync(tempB, { recursive: true, force: true });
    }
  });

  it('detects and rejects conflicting executionCwd and cwd aliases', () => {
    const tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-ws-c-')));
    const subA = path.join(tempRoot, 'sub-a');
    const subB = path.join(tempRoot, 'sub-b');
    fs.mkdirSync(subA, { recursive: true });
    fs.mkdirSync(subB, { recursive: true });
    try {
      expect(() => {
        resolveWorkspaceContext({
          workspaceRoot: tempRoot,
          executionCwd: subA,
          cwd: subB,
        });
      }).toThrowError(
        expect.objectContaining({
          code: 'CONFIG_INVALID',
        }),
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('enforces that executionCwd cannot escape workspaceRoot (WORKSPACE_ESCAPE)', () => {
    const tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-ws-d-')));
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-ws-out-')));
    try {
      expect(() => {
        resolveWorkspaceContext({
          workspaceRoot: tempRoot,
          executionCwd: outside,
        });
      }).toThrowError(
        expect.objectContaining({
          code: 'WORKSPACE_ESCAPE',
        }),
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('resolves native physical paths and expands existing vs pending directories', () => {
    const tempRoot = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-ws-phys-')),
    );
    try {
      const canonical = toNativePhysicalPath(tempRoot);
      expect(canonical).toBe(tempRoot);

      // Pending path under existing ancestor
      const pendingSub = path.join(tempRoot, 'nested', 'target.txt');
      const canonicalPending = toNativePhysicalPath(pendingSub);
      expect(canonicalPending).toBe(path.join(tempRoot, 'nested', 'target.txt'));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('verifies path hierarchy boundaries with isPathInside', () => {
    const tempRoot = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-ws-inside-')),
    );
    const inside = path.join(tempRoot, 'a', 'b');
    const sibling = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-ws-sib-')));
    try {
      expect(isPathInside(tempRoot, tempRoot)).toBe(true);
      expect(isPathInside(tempRoot, inside)).toBe(true);
      expect(isPathInside(tempRoot, sibling)).toBe(false);
      expect(isPathInside(inside, tempRoot)).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('handles case-insensitivity and drive letter normalization on Windows', () => {
    if (process.platform === 'win32') {
      const tempRoot = fs.realpathSync.native(
        fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-ws-win-')),
      );
      try {
        const lowerDrive = tempRoot.charAt(0).toLowerCase() + tempRoot.slice(1);
        const upperDrive = tempRoot.charAt(0).toUpperCase() + tempRoot.slice(1);
        expect(normalizeDriveLetter(lowerDrive)).toBe(upperDrive);
        expect(isSamePath(lowerDrive, upperDrive)).toBe(true);

        const key1 = computeProjectKey(lowerDrive);
        const key2 = computeProjectKey(upperDrive);
        expect(key1).toBe(key2);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    }
  });

  it('initializes AgentSession with canonical workspaceRoot, executionCwd, projectKey and rootDir', () => {
    const tempRoot = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-ws-session-')),
    );
    const subCwd = path.join(tempRoot, 'src');
    fs.mkdirSync(subCwd, { recursive: true });
    try {
      const session = new AgentSession({
        workspaceRoot: tempRoot,
        executionCwd: subCwd,
        defaultProfile: dummyProfile,
        defaultProvider: new DummyProvider(),
      });

      expect(session.workspaceRoot).toBe(tempRoot);
      expect(session.executionCwd).toBe(subCwd);
      expect(session.rootDir).toBe(tempRoot); // legacy alias
      expect(typeof session.projectKey).toBe('string');
      expect(session.projectKey).toHaveLength(64); // sha256 hex
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
