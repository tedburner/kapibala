import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type CoreHostBoundaryRule =
  | 'cli-dependency'
  | 'mcp-dependency'
  | 'terminal-io'
  | 'terminal-rendering'
  | 'runtime-context';

export interface CoreSourceFile {
  file: string;
  source: string;
}

export interface CoreHostBoundaryViolation {
  file: string;
  line: number;
  rule: CoreHostBoundaryRule;
  message: string;
}

const RULES: Array<{
  rule: CoreHostBoundaryRule;
  pattern: RegExp;
  message: string;
}> = [
  {
    rule: 'cli-dependency',
    pattern:
      /(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)['"](?:@kiturone\/kapibala-cli(?:\/[^'"]*)?|(?:\.\.\/)+cli(?:\/[^'"]*)?)['"]|packages[\\/]cli/i,
    message: 'Core 不得依赖 CLI 包或 CLI 源码。',
  },
  {
    rule: 'mcp-dependency',
    pattern:
      /(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)['"](?:@kiturone\/kapibala-mcp(?:\/[^'"]*)?|(?:\.\.\/)+mcp(?:\/[^'"]*)?)['"]|packages[\\/]mcp/i,
    message: 'Core 不得依赖 MCP 扩展包或 MCP 源码。',
  },
  {
    rule: 'terminal-io',
    pattern:
      /\bprocess\.(?:stdin|stdout|stderr)\b|\bconsole\.(?:debug|error|info|log|warn)\b|import\s*\{[^}]*\b(?:stdin|stdout|stderr)\b[^}]*\}\s*from\s*['"]node:process['"]/,
    message: 'Core 不得直接读写终端；宿主交互必须由上层适配器负责。',
  },
  {
    rule: 'terminal-rendering',
    pattern: /\\(?:x1b|u001b)/i,
    message: 'Core 不得包含 ANSI 转义或终端渲染内容。',
  },
  {
    rule: 'runtime-context',
    pattern: /\bprocess\.cwd\(\)/,
    message:
      'Core 严禁隐式读取当前工作目录 process.cwd()；必须由宿主显式注入 workspaceRoot 与 executionCwd。',
  },
];

export type McpBoundaryRule = 'cli-dependency' | 'core-internal' | 'terminal-io';

export interface McpBoundaryViolation {
  file: string;
  line: number;
  rule: McpBoundaryRule;
  message: string;
}

const MCP_RULES: Array<{
  rule: McpBoundaryRule;
  pattern: RegExp;
  message: string;
}> = [
  {
    rule: 'cli-dependency',
    pattern:
      /(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)['"](?:@kiturone\/kapibala-cli(?:\/[^'"]*)?|(?:\.\.\/)+cli(?:\/[^'"]*)?)['"]|packages[\\/]cli/i,
    message: 'MCP 扩展包不得依赖 CLI 包或 CLI 源码。',
  },
  {
    rule: 'core-internal',
    pattern:
      /(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)['"](?:@kiturone\/kapibala\/(?:src|dist)\b|(?:\.\.\/)+core\/src\b)/i,
    message:
      'MCP 扩展包必须通过 @kiturone/kapibala 公开导出使用 Core，严禁直接依赖 Core 内部私有路径。',
  },
  {
    rule: 'terminal-io',
    pattern:
      /\bprocess\.(?:stdin|stdout|stderr)\b|\bconsole\.(?:debug|error|info|log|warn)\b|import\s*\{[^}]*\b(?:stdin|stdout|stderr)\b[^}]*\}\s*from\s*['"]node:process['"]/,
    message: 'MCP 扩展包不得直接读写终端；诊断与日志必须通过回调接口交由宿主处理。',
  },
];

const TYPESCRIPT_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/** 检查给定源码是否越过 Headless Core 与宿主 UI 的边界。 */
export function findCoreHostBoundaryViolations(
  files: CoreSourceFile[],
): CoreHostBoundaryViolation[] {
  const violations: CoreHostBoundaryViolation[] = [];

  for (const file of files) {
    const lines = file.source.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (
        /(?:^|[\\/])runtime[\\/]/.test(file.file) &&
        /(?:from\s+|import\s*\(\s*)['"][^'"]*(?:context|store|session)\//.test(line)
      ) {
        violations.push({
          file: file.file,
          line: index + 1,
          rule: 'runtime-context',
          message: 'Runtime 必须通过共享契约调用上下文能力，不导入具体会话或存储。',
        });
      }
      for (const rule of RULES) {
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(line)) {
          violations.push({
            file: file.file,
            line: index + 1,
            rule: rule.rule,
            message: rule.message,
          });
        }
      }
    }
  }

  return violations;
}

/** 检查给定源码是否越过 MCP 扩展包与 CLI / 内部 Core 的边界。 */
export function findMcpBoundaryViolations(files: CoreSourceFile[]): McpBoundaryViolation[] {
  const violations: McpBoundaryViolation[] = [];

  for (const file of files) {
    const lines = file.source.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const rule of MCP_RULES) {
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(line)) {
          violations.push({
            file: file.file,
            line: index + 1,
            rule: rule.rule,
            message: rule.message,
          });
        }
      }
    }
  }

  return violations;
}

function collectSourceFiles(dir: string): CoreSourceFile[] {
  const files: CoreSourceFile[] = [];
  const visit = (currentDir: string): void => {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs
      .readdirSync(currentDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && TYPESCRIPT_SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push({ file: fullPath, source: fs.readFileSync(fullPath, 'utf8') });
      }
    }
  };
  visit(dir);
  return files;
}

/** 扫描 Core 源码目录，返回所有宿主 UI 边界违规。 */
export function scanCoreHostBoundary(coreSourceDir: string): CoreHostBoundaryViolation[] {
  return findCoreHostBoundaryViolations(collectSourceFiles(coreSourceDir));
}

/** 扫描 MCP 源码目录，返回所有架构边界违规。 */
export function scanMcpBoundary(mcpSourceDir: string): McpBoundaryViolation[] {
  return findMcpBoundaryViolations(collectSourceFiles(mcpSourceDir));
}

/** 检查 Core 运行时依赖，断言 dependencies 必须为空（运行时 0 外部依赖）。 */
export function checkCoreZeroRuntimeDependencies(corePackageJsonPath: string): {
  valid: boolean;
  dependencies: string[];
} {
  if (!fs.existsSync(corePackageJsonPath)) {
    return { valid: false, dependencies: ['package.json missing'] };
  }
  const content = JSON.parse(fs.readFileSync(corePackageJsonPath, 'utf-8'));
  const deps = Object.keys(content.dependencies ?? {});
  return {
    valid: deps.length === 0,
    dependencies: deps,
  };
}

/** CLI 入口：扫描 Core 与 MCP 源码目录，并检查 Core 运行时依赖，存在违规时把退出码置 1。 */
export function runCheckCoreBoundaryCli(coreSourceDir = 'packages/core/src'): void {
  const resolvedCoreDir = path.resolve(coreSourceDir);
  const coreViolations = scanCoreHostBoundary(resolvedCoreDir);

  const mcpSourceDir = path.resolve('packages/mcp/src');
  const mcpViolations = fs.existsSync(mcpSourceDir) ? scanMcpBoundary(mcpSourceDir) : [];

  const corePkgPath = path.resolve('packages/core/package.json');
  const depCheck = checkCoreZeroRuntimeDependencies(corePkgPath);

  let hasError = false;

  if (coreViolations.length > 0) {
    console.error('\n⛔ [Architecture] Headless Core 边界检查失败：\n');
    for (const violation of coreViolations) {
      console.error(
        `  ${violation.file}:${violation.line} [${violation.rule}] ${violation.message}`,
      );
    }
    hasError = true;
  }

  if (mcpViolations.length > 0) {
    console.error('\n⛔ [Architecture] MCP 扩展包边界检查失败：\n');
    for (const violation of mcpViolations) {
      console.error(
        `  ${violation.file}:${violation.line} [${violation.rule}] ${violation.message}`,
      );
    }
    hasError = true;
  }

  if (!depCheck.valid) {
    console.error(
      `\n⛔ [Architecture] Core 包含运行时依赖: ${depCheck.dependencies.join(', ')}（Core 必须保持运行时零依赖）。\n`,
    );
    hasError = true;
  }

  if (hasError) {
    process.exitCode = 1;
  } else {
    console.log('✔ [Architecture] Headless Core 与 MCP 架构边界及运行时零依赖校验通过。');
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCheckCoreBoundaryCli(process.argv[2]);
}
