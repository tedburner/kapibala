import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type CoreHostBoundaryRule = 'cli-dependency' | 'terminal-io' | 'terminal-rendering';

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

/** 扫描 Core 源码目录，返回所有宿主 UI 边界违规。 */
export function scanCoreHostBoundary(coreSourceDir: string): CoreHostBoundaryViolation[] {
  const files: CoreSourceFile[] = [];

  const visit = (dir: string): void => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && TYPESCRIPT_SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push({ file: fullPath, source: fs.readFileSync(fullPath, 'utf8') });
      }
    }
  };

  visit(coreSourceDir);
  return findCoreHostBoundaryViolations(files);
}

/** CLI 入口：扫描 Core 源码目录，存在违规时把退出码置 1。 */
export function runCheckCoreBoundaryCli(coreSourceDir = 'packages/core/src'): void {
  const violations = scanCoreHostBoundary(path.resolve(coreSourceDir));

  if (violations.length > 0) {
    console.error('\n⛔ [Architecture] Headless Core 边界检查失败：\n');
    for (const violation of violations) {
      console.error(
        `  ${violation.file}:${violation.line} [${violation.rule}] ${violation.message}`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log('✔ [Architecture] Headless Core 未包含 CLI 或终端 UI 依赖。');
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCheckCoreBoundaryCli(process.argv[2]);
}
