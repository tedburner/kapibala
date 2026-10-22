import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureRoot = path.join(repositoryRoot, 'scripts/fixtures/public-api');
const expectedPath = path.join(fixtureRoot, 'current.json');
const baselinePath = path.join(fixtureRoot, 'v0.0.9/public-api.json');
const migrationPath = path.join(fixtureRoot, 'migration.json');

/** 公开 API 入口；只覆盖实际发布包根与 CLI 子路径，不把源码内部模块当作 SDK 入口。 */
export const PUBLIC_API_ENTRIES = [
  { id: 'core', package: '@kiturone/kapibala', entry: 'packages/core/src/index.ts' },
  { id: 'mcp', package: '@kiturone/kapibala-mcp', entry: 'packages/mcp/src/index.ts' },
  {
    id: 'cli/protocol',
    package: '@kiturone/kapibala-cli',
    entry: 'packages/cli/src/protocol/index.ts',
  },
  {
    id: 'cli/client',
    package: '@kiturone/kapibala-cli',
    entry: 'packages/cli/src/client/index.ts',
  },
  {
    id: 'cli/view-model',
    package: '@kiturone/kapibala-cli',
    entry: 'packages/cli/src/view-model/index.ts',
  },
] as const;

interface ApiExport {
  readonly name: string;
  readonly kind: string;
  readonly declarations: readonly string[];
}

interface ApiEntry {
  readonly id: string;
  readonly entry: string;
  readonly exports: readonly ApiExport[];
}

interface ApiPackage {
  readonly name: string;
  readonly exports: unknown;
  readonly declarationModules: readonly string[];
}

/** 由独立声明产物形成的公开面快照；声明文本去尾空白，排序后可直接比较。 */
export interface ApiSnapshot {
  readonly schemaVersion: 1;
  readonly entries: readonly ApiEntry[];
  readonly packages: readonly ApiPackage[];
}

/** 公开面结构差异；added/removed/changed 均使用 entry:name 或 package:name 键。 */
export interface ApiDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

interface SnapshotOptions {
  readonly sourceRoot?: string;
}

function declarationPath(outDir: string, entry: string): string {
  return path.join(outDir, entry.replace(/\.ts$/, '.d.ts'));
}

function normalizeDeclaration(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalJson((value as Record<string, unknown>)[key])]),
    );
  return value;
}

function emitDeclarations(sourceRoot: string, outDir: string): void {
  const configPath = path.join(outDir, 'tsconfig.public-api.json');
  const config = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      lib: ['ES2022'],
      types: ['node'],
      typeRoots: [path.join(repositoryRoot, 'node_modules/@types')],
      declaration: true,
      emitDeclarationOnly: true,
      declarationMap: false,
      sourceMap: false,
      outDir,
      rootDir: sourceRoot,
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      baseUrl: sourceRoot,
      paths: {
        '@kiturone/kapibala': [path.join(sourceRoot, 'packages/core/src/index.ts')],
        '@kiturone/kapibala-mcp': [path.join(sourceRoot, 'packages/mcp/src/index.ts')],
      },
    },
    include: [
      path.join(sourceRoot, 'packages/core/src/index.ts'),
      path.join(sourceRoot, 'packages/mcp/src/index.ts'),
      path.join(sourceRoot, 'packages/cli/src/**/*.ts'),
    ],
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const typescriptBin = path.join(repositoryRoot, 'node_modules/typescript/bin/tsc');
  const result = spawnSync(process.execPath, [typescriptBin, '-p', configPath], {
    encoding: 'utf8',
    cwd: sourceRoot,
  });
  if (result.status !== 0)
    throw new Error(`Declaration emit failed:\n${result.stdout ?? ''}${result.stderr ?? ''}`);
}

function createDeclarationProgram(outDir: string): ts.Program {
  const roots = PUBLIC_API_ENTRIES.map((entry) => declarationPath(outDir, entry.entry));
  const program = ts.createProgram(roots, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: ['node'],
    typeRoots: [path.join(repositoryRoot, 'node_modules/@types')],
    skipLibCheck: true,
    baseUrl: outDir,
    paths: {
      '@kiturone/kapibala': [declarationPath(outDir, 'packages/core/src/index.ts')],
      '@kiturone/kapibala-mcp': [declarationPath(outDir, 'packages/mcp/src/index.ts')],
    },
  });
  const errors = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    const formatted = ts.formatDiagnostics(errors, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => outDir,
      getNewLine: () => '\n',
    });
    throw new Error(`Declaration program failed:\n${formatted}`);
  }
  return program;
}

function exportKind(symbol: ts.Symbol): string {
  const flags = symbol.flags;
  if (flags & ts.SymbolFlags.Class) return 'class';
  if (flags & ts.SymbolFlags.Interface) return 'interface';
  if (flags & ts.SymbolFlags.TypeAlias) return 'type';
  if (flags & ts.SymbolFlags.Enum) return 'enum';
  if (flags & ts.SymbolFlags.Function) return 'function';
  if (flags & ts.SymbolFlags.Module) return 'namespace';
  if (flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.BlockScopedVariable)) return 'const';
  return 'unknown';
}

function snapshotEntry(program: ts.Program, id: string, entry: string): ApiEntry {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  if (!source) throw new Error(`Missing declaration entry for ${id}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`Missing module symbol for ${id}`);
  const exports = checker
    .getExportsOfModule(moduleSymbol)
    .map((symbol): ApiExport => {
      const target =
        symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      const declarations = [
        ...new Set(
          (target.declarations ?? symbol.declarations ?? []).map((declaration) =>
            normalizeDeclaration(declaration.getText()),
          ),
        ),
      ].sort();
      return { name: symbol.name, kind: exportKind(target), declarations };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  return { id, entry: publicEntry(id), exports };
}

function publicEntry(id: string): string {
  return PUBLIC_API_ENTRIES.find((entry) => entry.id === id)?.entry ?? id;
}

function listDeclarationModules(outDir: string, packageRoot: string): string[] {
  const root = path.join(outDir, packageRoot);
  if (!fs.existsSync(root)) return [];
  const modules: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      if (fs.statSync(target).isDirectory()) visit(target);
      else if (name.endsWith('.d.ts'))
        modules.push(path.relative(root, target).split(path.sep).join('/'));
    }
  };
  visit(root);
  return modules.sort();
}

function packageInventory(sourceRoot: string, outDir: string): ApiPackage[] {
  return ['packages/core', 'packages/mcp', 'packages/cli'].map((directory) => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(sourceRoot, directory, 'package.json'), 'utf8'),
    ) as { name: string; exports?: Record<string, unknown> };
    const exports = canonicalJson(manifest.exports ?? {});
    const wildcard = Object.keys(manifest.exports ?? {}).some((key) => key.includes('*'));
    return {
      name: manifest.name,
      exports,
      declarationModules: wildcard ? listDeclarationModules(outDir, `${directory}/src`) : [],
    };
  });
}

/** 从源码生成声明并形成排序后的公开面快照；临时目录在返回前清理，不读取 dist。 */
export function collectPublicApi(options: SnapshotOptions = {}): ApiSnapshot {
  const sourceRoot = path.resolve(options.sourceRoot ?? repositoryRoot);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-public-api-'));
  try {
    emitDeclarations(sourceRoot, outDir);
    const program = createDeclarationProgram(outDir);
    const entries = PUBLIC_API_ENTRIES.map((entry) =>
      snapshotEntry(program, entry.id, declarationPath(outDir, entry.entry)),
    ).sort((left, right) => left.id.localeCompare(right.id));
    return {
      schemaVersion: 1,
      entries,
      packages: packageInventory(sourceRoot, outDir).sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

function exportMap(entry: ApiEntry): Map<string, ApiExport> {
  return new Map(entry.exports.map((item) => [item.name, item]));
}

/** 比较入口导出和通配入口盘点；只报告结构变化，不把格式化差异当作 API 变化。 */
export function diffApiSnapshots(baseline: ApiSnapshot, actual: ApiSnapshot): ApiDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const actualEntries = new Map(actual.entries.map((entry) => [entry.id, entry]));
  for (const entry of baseline.entries) {
    const next = actualEntries.get(entry.id);
    if (!next) {
      removed.push(`entry:${entry.id}`);
      removed.push(...entry.exports.map((item) => `${entry.id}:${item.name}`));
      continue;
    }
    const before = exportMap(entry);
    const after = exportMap(next);
    for (const [name, item] of before) {
      const current = after.get(name);
      if (!current) removed.push(`${entry.id}:${name}`);
      else if (
        current.kind !== item.kind ||
        JSON.stringify(current.declarations) !== JSON.stringify(item.declarations)
      )
        changed.push(`${entry.id}:${name}`);
    }
    for (const name of after.keys()) {
      if (!before.has(name)) added.push(`${entry.id}:${name}`);
    }
  }
  const baselineEntryIds = new Set(baseline.entries.map((entry) => entry.id));
  for (const entry of actual.entries) {
    if (baselineEntryIds.has(entry.id)) continue;
    added.push(`entry:${entry.id}`);
    added.push(...entry.exports.map((item) => `${entry.id}:${item.name}`));
  }
  const baselinePackages = new Map(baseline.packages.map((item) => [item.name, item]));
  for (const item of actual.packages) {
    const before = baselinePackages.get(item.name);
    if (!before) {
      added.push(`package:${item.name}`);
      continue;
    }
    if (JSON.stringify(before.exports) !== JSON.stringify(item.exports))
      changed.push(`package:${item.name}:exports`);
    const beforeModules = new Set(before.declarationModules);
    const afterModules = new Set(item.declarationModules);
    for (const module of beforeModules)
      if (!afterModules.has(module)) removed.push(`package:${item.name}:module:${module}`);
    for (const module of afterModules)
      if (!beforeModules.has(module)) added.push(`package:${item.name}:module:${module}`);
  }
  const baselinePackageNames = new Set(baseline.packages.map((item) => item.name));
  for (const item of actual.packages)
    if (!baselinePackageNames.has(item.name)) added.push(`package:${item.name}`);
  return {
    added: [...new Set(added)].sort(),
    removed: [...new Set(removed)].sort(),
    changed: [...new Set(changed)].sort(),
  };
}

function hasDiff(diff: ApiDiff): boolean {
  return diff.added.length + diff.removed.length + diff.changed.length > 0;
}

function readSnapshot(file: string): ApiSnapshot {
  if (!fs.existsSync(file)) throw new Error(`Missing public API snapshot: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as ApiSnapshot;
}

function writeSnapshot(file: string, snapshot: ApiSnapshot): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
}

function reportDiff(title: string, diff: ApiDiff): void {
  const rows = [
    ...diff.added.map((name) => `+ ${name}`),
    ...diff.removed.map((name) => `- ${name}`),
    ...diff.changed.map((name) => `~ ${name}`),
  ];
  const shown = rows.slice(0, 60);
  console.error(`${title}\n${shown.map((row) => `  ${row}`).join('\n')}`);
  if (rows.length > shown.length) console.error(`  … ${rows.length - shown.length} more`);
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a path`);
  return path.resolve(value);
}

function main(): void {
  const update = process.argv.includes('--update');
  const sourceRoot = argumentValue('--source-root') ?? repositoryRoot;
  const output = argumentValue('--output');
  const snapshot = collectPublicApi({ sourceRoot });
  if (update) {
    const target = output ?? expectedPath;
    writeSnapshot(target, snapshot);
    console.log(`Updated ${path.relative(repositoryRoot, target)}`);
    if (!output && sourceRoot === repositoryRoot && fs.existsSync(baselinePath)) {
      const migration = {
        schemaVersion: 1,
        baseline: 'v0.0.9',
        changes: diffApiSnapshots(readSnapshot(baselinePath), snapshot),
      };
      fs.writeFileSync(migrationPath, `${JSON.stringify(migration, null, 2)}\n`);
      console.log(`Updated ${path.relative(repositoryRoot, migrationPath)} for review`);
    }
    return;
  }
  if (output) throw new Error('--output is only valid with --update');
  const expected = readSnapshot(expectedPath);
  const actualDiff = diffApiSnapshots(expected, snapshot);
  if (hasDiff(actualDiff)) {
    reportDiff('Public API differs from the reviewed baseline:', actualDiff);
    console.error('Run `tsx scripts/check-public-api.ts --update` after confirming the change.');
    process.exitCode = 1;
    return;
  }
  if (fs.existsSync(baselinePath)) {
    const baselineDiff = diffApiSnapshots(readSnapshot(baselinePath), expected);
    const migration = JSON.parse(fs.readFileSync(migrationPath, 'utf8')) as {
      changes: ApiDiff;
    };
    for (const key of ['added', 'removed', 'changed'] as const) {
      if (JSON.stringify(baselineDiff[key]) !== JSON.stringify(migration.changes[key])) {
        reportDiff(`Public API migration is stale (${key}):`, baselineDiff);
        console.error('Run `tsx scripts/check-public-api.ts --update` and review the migration.');
        process.exitCode = 1;
        return;
      }
    }
  }
  console.log('Public API matches the reviewed v0.0.10 baseline.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
