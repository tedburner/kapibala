import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentSession,
  type AgentTaskRecord,
  FileLogSink,
  SessionManager,
  WorkspaceLeaseCoordinator,
} from '@kiturone/kapibala';
import { CliModelBindings } from '@kiturone/kapibala-host/internal';
import type { UserSettings } from '@kiturone/kapibala-host/internal';
import { createCliSubagentRunner } from '@kiturone/kapibala-host/internal';
import { afterEach, expect, it, vi } from 'vitest';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
it('子会话从显式 home 加载指令并恢复审计，独立历史清理后可重开', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-child-home-'));
  directories.push(home);
  const root = path.join(home, 'workspace');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(home, '.kapibala'));
  const instruction = path.join(home, '.kapibala/AGENTS.md');
  fs.writeFileSync(instruction, 'CHILD_EXPLICIT_HOME');
  const audit = path.join(home, '.kapibala/audit');
  await new FileLogSink({ directory: audit, prefix: 'audit' }).write({
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    channel: 'audit',
    level: 'info',
    event: 'tool.requested',
    sessionId: 'old',
    operationId: 'unfinished',
    toolUseId: 'use',
    fields: {},
  });
  const profile = {
    id: 'fixture',
    name: 'fixture',
    provider: 'openai-compatible' as const,
    modelName: 'fixture',
    baseURL: 'http://127.0.0.1:1/v1',
    apiKey: 'fixture-key',
    apiKeyEnv: 'KPBL_FIXTURE_KEY',
    contextWindow: 32000,
  };
  const settings: UserSettings = { defaultModel: profile.id, profiles: [profile] };
  const manager = new SessionManager({
    workspaceRoot: root,
    homeDirectory: home,
    projectRootMode: 'exact',
  });
  const leases = new WorkspaceLeaseCoordinator();
  let sources: string[] = [];
  vi.spyOn(AgentSession.prototype, 'run').mockImplementation(async function* (this: AgentSession) {
    sources = this.getInstructionSources();
    yield { type: 'turn_start', turn: 1 };
  });
  const runner = createCliSubagentRunner({
    manager,
    models: new CliModelBindings(settings, profile),
    settings,
    homeDirectory: home,
    leaseCoordinator: leases,
  });
  const task: AgentTaskRecord = {
    agentId: 'child',
    origin: {
      rootTaskId: 'tree',
      parentSessionId: 'parent',
      originBranchId: 'main',
      originRunId: 'run',
      spawnToolCallId: 'spawn',
      generation: 1,
      depth: 1,
    },
    role: 'advisor',
    description: 'fixture',
    prompt: 'fixture',
    status: 'running',
    createdAt: Date.now(),
    childAgentIds: new Set(),
    workspaceRoot: root,
    executionCwd: root,
    limits: { maxSteps: 1, timeoutMs: 1000 },
  };
  await runner(task, new AbortController().signal, { leaseCoordinator: leases });
  expect(sources).toContain(fs.realpathSync.native(instruction));
  const logs = fs
    .readdirSync(audit)
    .map((name) => fs.readFileSync(path.join(audit, name), 'utf8'))
    .join('');
  expect(logs).toContain('audit.outcome_unknown');
  const sessions = await manager.list();
  expect(sessions.total).toBe(1);
  const reopened = await manager.open(sessions.items[0].conversationId);
  await reopened.release();
});
