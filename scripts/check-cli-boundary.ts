import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** 待检查的源码快照；允许负向 fixture 直接传入，不执行被检查模块。 */
export interface CliBoundarySource {
  readonly file: string;
  readonly source: string;
}

/** CLI 分层违规；行号来自 TypeScript 语法树，注释和普通字段名不会伪装成依赖。 */
export interface CliBoundaryViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: 'view-model-dependency' | 'view-model-runtime' | 'tui-dependency' | 'tui-session';
  readonly message: string;
}

const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const forbiddenGlobals = new Set([
  'process',
  'Buffer',
  'console',
  'global',
  'globalThis',
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'fetch',
]);

function isInside(root: string, candidate: string): boolean {
  const normRoot = path.resolve(root);
  const normCandidate = path.resolve(candidate);
  const effectiveRoot = process.platform === 'win32' ? normRoot.toLowerCase() : normRoot;
  const effectiveCandidate =
    process.platform === 'win32' ? normCandidate.toLowerCase() : normCandidate;
  const relative = path.relative(effectiveRoot, effectiveCandidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function moduleReference(node: ts.Node): ts.Expression | ts.TypeNode | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
    return node.moduleReference.expression;
  if (ts.isImportTypeNode(node)) return node.argument;
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
  )
    return node.arguments[0] ?? node;
  return undefined;
}

function moduleName(reference: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(reference)) return reference.text;
  if (ts.isLiteralTypeNode(reference) && ts.isStringLiteralLike(reference.literal))
    return reference.literal.text;
  return undefined;
}

function isFieldName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    ((ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent)) &&
      parent.name === node)
  );
}

/**
 * 检查纯展示与 TUI 的静态边界，包含类型导入、重导出、动态导入和 CommonJS 引用。
 * ViewModel 仅可依赖自身目录，TUI 相对依赖仅可进入自身或 ViewModel；Host 和命令实现必须通过注入端口隔离。
 * 非字面量动态依赖无法证明边界，按违规处理；此检查补充独立类型检查，不改变既有 Core/MCP 门禁。
 */
export function findCliBoundaryViolations(
  files: readonly CliBoundarySource[],
  sourceRoot: string,
): CliBoundaryViolation[] {
  const viewRoot = path.resolve(sourceRoot, 'view-model');
  const tuiRoot = path.resolve(sourceRoot, 'tui');
  const violations: CliBoundaryViolation[] = [];
  for (const file of files) {
    const filePath = path.resolve(file.file);
    const isView = isInside(viewRoot, filePath);
    if (!isView && !isInside(tuiRoot, filePath)) continue;
    const source = ts.createSourceFile(file.file, file.source, ts.ScriptTarget.Latest, true);
    const add = (node: ts.Node, rule: CliBoundaryViolation['rule'], message: string) => {
      violations.push({
        file: file.file,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        rule,
        message,
      });
    };
    const visit = (node: ts.Node): void => {
      const reference = moduleReference(node);
      if (reference) {
        const name = moduleName(reference);
        const target = name?.startsWith('.')
          ? path.resolve(path.dirname(filePath), name)
          : undefined;
        const permitted = isView
          ? target !== undefined && isInside(viewRoot, target)
          : target !== undefined
            ? isInside(tuiRoot, target) || isInside(viewRoot, target)
            : name !== undefined &&
              (name === '@kiturone/kapibala-cli/view-model' ||
                !/^(?:@kiturone\/kapibala(?:-mcp|-cli)?)(?:\/|$)/.test(name));
        if (!permitted)
          add(
            node,
            isView ? 'view-model-dependency' : 'tui-dependency',
            isView
              ? 'ViewModel 只允许自身目录内的纯展示依赖，禁止 Node/Core/MCP/React/宿主与动态未知依赖。'
              : 'TUI 不得导入 Core/MCP、Host 或命令实现；宿主动作必须经注入端口调用。',
          );
      }
      if (
        isView &&
        ((ts.isIdentifier(node) && forbiddenGlobals.has(node.text) && !isFieldName(node)) ||
          (ts.isStringLiteralLike(node) && node.text.includes('\u001b')))
      )
        add(
          node,
          'view-model-runtime',
          'ViewModel 不得读取 Node/DOM 全局、操作终端、创建定时器或携带 ANSI。',
        );
      if (!isView && ts.isNewExpression(node)) {
        const target = node.expression;
        const name = ts.isIdentifier(target)
          ? target.text
          : ts.isPropertyAccessExpression(target)
            ? target.name.text
            : '';
        if (name === 'AgentSession' || name === 'SessionManager')
          add(
            node,
            'tui-session',
            'TUI 不创建 Session 或 SessionManager；会话生命周期由 Host 持有。',
          );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}

/** 扫描 CLI 两个展示目录的全部 TS/JS 扩展；不加载模块，不触发终端或会话初始化。 */
export function scanCliBoundary(sourceRoot: string): CliBoundaryViolation[] {
  const files: CliBoundarySource[] = [];
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && sourceExtensions.has(path.extname(file)))
        files.push({ file, source: fs.readFileSync(file, 'utf8') });
    }
  };
  visit(path.join(sourceRoot, 'view-model'));
  visit(path.join(sourceRoot, 'tui'));
  return findCliBoundaryViolations(files, sourceRoot);
}

/** 独立 CLI 分层门禁；违规时设置非零退出码，不接管或替换 Core 门禁。 */
export function runCheckCliBoundary(sourceRoot = path.resolve('packages/cli/src')): void {
  const violations = scanCliBoundary(sourceRoot);
  for (const violation of violations)
    console.error(`${violation.file}:${violation.line} [${violation.rule}] ${violation.message}`);
  if (violations.length) process.exitCode = 1;
  else console.log('✔ [Architecture] CLI ViewModel/TUI 分层边界校验通过。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runCheckCliBoundary(process.argv[2]);
