import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../src/context/session-manager.js';
import {
  MAIN_BRANCH_ID,
  SESSION_SCHEMA_VERSION_V2,
  type SessionRecord,
} from '../src/context/session-store.js';

const fixtureDirectory = fileURLToPath(new URL('./fixtures/compat', import.meta.url));

interface CompatFixture {
  file: string;
  conversationId: string;
  sourceSchemaVersion: number;
  expectation: 'upgrade' | 'reject' | 'read';
  target: string;
  diagnostic?: string;
  toolExecutions: number;
  sourceMutation: 'none';
  sha256: string;
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(fixtureDirectory, 'manifest.json'), 'utf8'),
) as { schemaVersion: number; fixtures: CompatFixture[] };

describe('session compatibility corpus', () => {
  let root: string;
  let manager: SessionManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-compat-'));
    manager = new SessionManager({
      workspaceRoot: root,
      homeDirectory: path.join(root, 'home'),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const sha256 = (bytes: Buffer | string): string =>
    createHash('sha256').update(bytes).digest('hex');
  const templateBytes = (file: string): Buffer =>
    fs.readFileSync(path.join(fixtureDirectory, file));
  const jsonlFiles = (): string[] =>
    fs
      .readdirSync(manager.directory)
      .filter((name) => name.endsWith('.jsonl'))
      .sort();
  const temporaryFiles = (): string[] =>
    fs.readdirSync(manager.directory).filter((name) => name.includes('.tmp-'));

  /** 把固定语料物化到当前临时项目桶；占位符必须转义，否则 Windows 路径会破坏 JSON。 */
  const install = (entry: CompatFixture): string => {
    const escapedRoot = JSON.stringify(manager.project.projectRoot).slice(1, -1);
    const target = path.join(manager.directory, `1700000000000_${entry.conversationId}.jsonl`);
    fs.writeFileSync(
      target,
      templateBytes(entry.file).toString('utf8').replaceAll('{{ROOT}}', escapedRoot),
    );
    return target;
  };
  const fixture = (file: string): CompatFixture => {
    const entry = manifest.fixtures.find((candidate) => candidate.file === file);
    if (!entry) throw new Error(`Missing compatibility fixture: ${file}`);
    return entry;
  };

  it('pins every fixture to its declared source version and hash', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.fixtures).toHaveLength(4);
    for (const entry of manifest.fixtures) {
      const bytes = templateBytes(entry.file);
      expect(sha256(bytes)).toBe(entry.sha256);
      expect(JSON.parse(bytes.toString('utf8').split('\n')[0]).schemaVersion).toBe(
        entry.sourceSchemaVersion,
      );
      expect(entry.sourceMutation).toBe('none');
      expect(entry.toolExecutions).toBe(0);
    }
  });

  it('upgrades a v1 corpus file into an independent valid v2 copy without executing tools', async () => {
    const entry = fixture('v1-basic.jsonl');
    const source = install(entry);
    const before = sha256(fs.readFileSync(source));

    const upgraded = await manager.upgradeLegacyV1Session(entry.conversationId);

    expect(sha256(fs.readFileSync(source))).toBe(before);
    expect(upgraded.conversationId).not.toBe(entry.conversationId);
    expect(upgraded.store.getSchemaVersion()).toBe(SESSION_SCHEMA_VERSION_V2);
    expect(upgraded.store.isReadOnly()).toBe(false);
    expect(upgraded.header.parentSessionId).toBe(entry.conversationId);
    expect(upgraded.header.upgradeIdentity).toBeTruthy();

    const records = await upgraded.store.readRecords();
    expect(records).toHaveLength(8);
    records.forEach((record: SessionRecord, index) => {
      expect(record.schemaVersion).toBe(SESSION_SCHEMA_VERSION_V2);
      expect(record.seq).toBe(index);
      expect(record.prevRecordId).toBe(index === 0 ? null : records[index - 1].recordId);
    });
    expect(records[0]).toMatchObject({ type: 'header', parentId: null, branchId: null });
    expect(records[0].payload).toMatchObject({
      conversationId: upgraded.conversationId,
      parentSessionId: entry.conversationId,
    });
    const title = records[5];
    expect(title).toMatchObject({ type: 'title', parentId: null, branchId: null });
    expect(
      records.filter((record) => record.type === 'message').map((record) => record.branchId),
    ).toEqual(Array.from({ length: 6 }, () => MAIN_BRANCH_ID));

    const history = await upgraded.store.load();
    expect(history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(history[1].content).toContainEqual({
      type: 'tool_use',
      id: 'v1-tool-1',
      name: 'read_file',
      input: { path: 'README.md' },
    });
    expect(history[2].content).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'v1-tool-1',
        content: 'legacy content',
        isError: false,
      },
    ]);

    await upgraded.store.append({
      role: 'user',
      content: [{ type: 'text', text: 'post-upgrade turn' }],
    });
    expect(sha256(fs.readFileSync(source))).toBe(before);

    const repeated = await manager.upgradeLegacyV1Session(entry.conversationId);
    expect(repeated.conversationId).toBe(upgraded.conversationId);
    expect(jsonlFiles()).toHaveLength(2);
    expect(temporaryFiles()).toEqual([]);
    await manager.close();
  });

  it('leaves no publishable copy when the atomic publish fails', async () => {
    const entry = fixture('v1-basic.jsonl');
    const source = install(entry);
    const before = sha256(fs.readFileSync(source));
    const originalRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike): void => {
      if (String(from).includes('.tmp-') && String(to).endsWith('.jsonl')) {
        throw new Error('injected publish failure');
      }
      originalRename(from, to);
    }) as typeof fs.renameSync);

    await expect(manager.upgradeLegacyV1Session(entry.conversationId)).rejects.toThrow(
      /injected publish failure/,
    );

    expect(sha256(fs.readFileSync(source))).toBe(before);
    expect(jsonlFiles()).toEqual([path.basename(source)]);
    expect(temporaryFiles()).toEqual([]);
  });

  it('rejects a corrupt v1 tail without rewriting or publishing a copy', async () => {
    const entry = fixture('v1-corrupt-tail.jsonl');
    const source = install(entry);
    const before = sha256(fs.readFileSync(source));

    await expect(manager.upgradeLegacyV1Session(entry.conversationId)).rejects.toThrow(
      new RegExp(entry.diagnostic!),
    );

    expect(sha256(fs.readFileSync(source))).toBe(before);
    expect(jsonlFiles()).toEqual([path.basename(source)]);
    expect(temporaryFiles()).toEqual([]);
  });

  it('rejects an unknown schema without creating a target or temp file', async () => {
    const entry = fixture('unknown-schema.jsonl');
    const source = install(entry);
    const before = sha256(fs.readFileSync(source));

    await expect(manager.upgradeLegacyV1Session(entry.conversationId)).rejects.toThrow(
      new RegExp(entry.diagnostic!),
    );

    expect(sha256(fs.readFileSync(source))).toBe(before);
    expect(jsonlFiles()).toEqual([path.basename(source)]);
    expect(temporaryFiles()).toEqual([]);
  });

  it('opens a v2 branch corpus at its persisted active branch without mutating the source', async () => {
    const entry = fixture('v2-branch.jsonl');
    const source = install(entry);
    const before = sha256(fs.readFileSync(source));

    const opened = await manager.open(entry.conversationId);

    expect(opened.store.getSchemaVersion()).toBe(SESSION_SCHEMA_VERSION_V2);
    expect(opened.store.getActiveBranchId()).toBe('alt');
    const state = await opened.store.loadState();
    expect(state.activeBranchId).toBe('alt');
    expect(state.activeLeafId).toBe('v2-compat-msg-4');
    expect((await opened.store.load()).map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'main question' },
      { type: 'text', text: 'main answer' },
      { type: 'text', text: 'branch question' },
      { type: 'text', text: 'branch answer' },
    ]);
    const branches = await opened.store.getBranches();
    expect(branches.map((branch) => branch.branchId).sort()).toEqual(['alt', MAIN_BRANCH_ID]);
    expect(branches.find((branch) => branch.branchId === 'alt')?.isActive).toBe(true);
    expect(branches.find((branch) => branch.branchId === MAIN_BRANCH_ID)?.isActive).toBe(false);

    expect(sha256(fs.readFileSync(source))).toBe(before);
    await manager.close();
  });
});
