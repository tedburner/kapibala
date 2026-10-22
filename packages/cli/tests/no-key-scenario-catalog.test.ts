import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const catalogPath = fileURLToPath(new URL('./fixtures/no-key-scenarios.json', import.meta.url));

type ScenarioHost = 'sdk' | 'cli' | 'local-host';
type ScenarioProtocol = 'chat' | 'anthropic' | 'responses';
type ScenarioAssertion = 'history' | 'request' | 'wire' | 'effects';

interface ScenarioEvidence {
  file: string;
  marker: string;
}

interface ScenarioClass {
  id: string;
  title: string;
  script: string;
  hosts: ScenarioHost[];
  protocols: ScenarioProtocol[];
  assertions: ScenarioAssertion[];
  expected: string;
  evidence: ScenarioEvidence[];
}

interface ScenarioCatalog {
  schemaVersion: number;
  classes: ScenarioClass[];
}

const REQUIRED_IDS = [
  'normal-tool-transaction',
  'multi-tool-partial-failure',
  'execution-cancel',
  'consumer-early-return',
  'approval-denial-timeout-disconnect',
  'crash-recovery',
  'subagent-cancel-collect',
  'skill-permission-tightening',
  'mcp-revoke-teardown',
  'compaction-failure',
  'slow-client-large-snapshot',
  'operation-id-dedupe-redaction',
] as const;

const ALL_HOSTS: ScenarioHost[] = ['sdk', 'cli', 'local-host'];
const ALL_PROTOCOLS: ScenarioProtocol[] = ['chat', 'anthropic', 'responses'];
const ALL_ASSERTIONS: ScenarioAssertion[] = ['history', 'request', 'wire', 'effects'];
const BEHAVIOR_FILES = [
  'packages/core/tests/no-key-model-matrix.test.ts',
  'packages/cli/tests/no-key-host-matrix.test.ts',
] as const;

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as ScenarioCatalog;
const scenario = (id: string): ScenarioClass => catalog.classes.find((entry) => entry.id === id)!;

describe('no-key scenario catalog', () => {
  it('pins exactly the twelve required scenario classes', () => {
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.classes).toHaveLength(REQUIRED_IDS.length);
    const ids = catalog.classes.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...REQUIRED_IDS].sort());
  });

  it('covers every host, protocol and comparison surface in aggregate', () => {
    const hosts = new Set(catalog.classes.flatMap((entry) => entry.hosts));
    const protocols = new Set(catalog.classes.flatMap((entry) => entry.protocols));
    const assertions = new Set(catalog.classes.flatMap((entry) => entry.assertions));

    expect([...hosts].sort()).toEqual([...ALL_HOSTS].sort());
    expect([...protocols].sort()).toEqual([...ALL_PROTOCOLS].sort());
    expect([...assertions].sort()).toEqual([...ALL_ASSERTIONS].sort());
  });

  it('routes the three-provider and three-host behavior matrices into the matching classes', () => {
    const transaction = scenario('normal-tool-transaction');
    expect(transaction.hosts).toEqual(ALL_HOSTS);
    expect(transaction.protocols).toEqual(ALL_PROTOCOLS);

    const referencedFiles = new Set(
      catalog.classes.flatMap((entry) => entry.evidence.map((evidence) => evidence.file)),
    );
    for (const file of BEHAVIOR_FILES) {
      expect(referencedFiles.has(file)).toBe(true);
      expect(fs.readFileSync(path.join(repoRoot, file), 'utf8')).toContain('assertConsumed()');
    }

    expect(
      scenario('operation-id-dedupe-redaction').evidence.some(
        (evidence) => evidence.file === BEHAVIOR_FILES[1],
      ),
    ).toBe(true);
  });

  describe.each(catalog.classes)('$id', (entry) => {
    it('declares its script, surface and assertions', () => {
      expect(entry.title.trim()).not.toBe('');
      expect(entry.script.trim()).not.toBe('');
      expect(entry.expected.trim()).not.toBe('');
      expect(entry.hosts.length).toBeGreaterThan(0);
      expect(entry.assertions.length).toBeGreaterThan(0);
      expect(entry.evidence.length).toBeGreaterThan(0);
      expect(entry.hosts.every((host) => ALL_HOSTS.includes(host))).toBe(true);
      expect(entry.protocols.every((protocol) => ALL_PROTOCOLS.includes(protocol))).toBe(true);
      expect(entry.assertions.every((assertion) => ALL_ASSERTIONS.includes(assertion))).toBe(true);
    });

    it('resolves every evidence marker inside the repository', () => {
      for (const evidence of entry.evidence) {
        expect(path.isAbsolute(evidence.file)).toBe(false);
        const absolute = path.resolve(repoRoot, evidence.file);
        expect(absolute.startsWith(`${repoRoot}${path.sep}`)).toBe(true);
        expect(fs.existsSync(absolute)).toBe(true);
        expect(fs.readFileSync(absolute, 'utf8')).toContain(evidence.marker);
      }
    });
  });
});
