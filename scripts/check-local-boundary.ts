import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * AST 扫描协议整个传递依赖闭包；禁止外部包、Node、动态地址和跨目录引用。
 * browser 类型检查与打包另行执行；本门禁不会导入待检查源码。
 */
export function checkProtocolBoundary(root: string): string[] {
  const errors: string[] = [];
  const base = fs.realpathSync.native(root);
  const visited = new Set<string>();
  const inside = (file: string) => {
    const rel = path.relative(base, file);
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  const visitFile = (file: string) => {
    let physical: string;
    try {
      physical = fs.realpathSync.native(file);
    } catch {
      errors.push(`Missing protocol dependency: ${file}`);
      return;
    }
    if (!inside(physical)) {
      errors.push(`Protocol dependency escapes root: ${file}`);
      return;
    }
    if (visited.has(physical)) return;
    visited.add(physical);
    const source = ts.createSourceFile(
      physical,
      fs.readFileSync(physical, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const dependency = (node: ts.Expression) => {
      if (!ts.isStringLiteralLike(node) || !node.text.startsWith('.')) {
        errors.push(`External or dynamic protocol dependency: ${physical}`);
        return;
      }
      const target = path.resolve(path.dirname(physical), node.text.replace(/\.js$/, '.ts'));
      if (!inside(target)) {
        errors.push(`Protocol dependency escapes root: ${target}`);
        return;
      }
      visitFile(target);
    };
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
        dependency(node.moduleSpecifier);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        if (node.arguments.length !== 1) errors.push(`Invalid protocol import: ${physical}`);
        else dependency(node.arguments[0]);
      }
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        dependency(node.argument.literal);
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  visitFile(path.join(base, 'index.ts'));
  return errors;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  const errors = checkProtocolBoundary(
    path.resolve(path.dirname(self), '../packages/cli/src/protocol'),
  );
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log('Protocol dependency boundary passed');
}
