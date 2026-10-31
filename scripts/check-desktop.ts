import fs from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repository = fileURLToPath(new URL('../', import.meta.url));
const desktop = path.join(repository, 'packages/desktop');
function files(directory: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((item) =>
      item.isDirectory()
        ? files(path.join(directory, item.name))
        : [path.join(directory, item.name)],
    );
}
function insist(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}
/** 分入口验证桌面安全边界与组件约束；产物模式额外确认 sandbox Preload 无 Node 依赖泄漏。 */
export function checkDesktop(artifacts = false): void {
  for (const file of files(path.join(desktop, 'src')).filter((item) =>
    /\.[cm]?[jt]sx?$/.test(item),
  )) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(path.join(desktop, 'src'), file).replaceAll('\\', '/');
    const browser = /^(renderer|shared)\//.test(relative);
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      let specifier: string | undefined;
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        specifier = node.moduleSpecifier.text;
      if (
        ts.isCallExpression(node) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          node.expression.getText(tree) === 'require')
      )
        specifier = node.arguments[0].text;
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          node.expression.getText(tree) === 'require')
      )
        insist(Boolean(specifier), `${relative}: dynamic module expression is not allowed`);
      if (specifier) {
        if (browser || relative.startsWith('preload/'))
          insist(!isBuiltin(specifier), `${relative}: Node builtin is not available`);
        if (specifier.startsWith('.')) {
          const target = path
            .relative(path.join(desktop, 'src'), path.resolve(path.dirname(file), specifier))
            .replaceAll('\\', '/');
          const area = relative.split('/')[0];
          insist(
            target.startsWith(`${area}/`) || target.startsWith('shared/'),
            `${relative}: relative import crosses process boundary: ${specifier}`,
          );
        }
        if (browser)
          insist(
            !/^(?:node:|electron$|@kiturone\/kapibala(?:$|-mcp$|-cli(?:$|\/(?!view-model$))))/.test(
              specifier,
            ),
            `${relative}: browser imports privileged ${specifier}`,
          );
        if (relative.startsWith('main/'))
          insist(
            !specifier.includes('@kiturone/') && !specifier.includes('agent-host'),
            `${relative}: Main imports execution domain`,
          );
        if (relative.startsWith('renderer/'))
          insist(
            !/\/(?:agent-host|main|preload)\//.test(specifier),
            `${relative}: cross-process import`,
          );
        if (relative.startsWith('agent-host/') && specifier.startsWith('@kiturone/kapibala-cli'))
          insist(
            specifier === '@kiturone/kapibala-cli/host' ||
              specifier === '@kiturone/kapibala-cli/view-model',
            `${relative}: private CLI import`,
          );
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    if (relative.startsWith('renderer/'))
      insist(
        !/transition-all|transition:\s*all|@keyframes|\banimate-[a-z]/.test(source),
        `${relative}: application motion must remain explicit and bounded`,
      );
    if (relative.startsWith('renderer/') && /\.tsx$/.test(file)) {
      insist(
        !/<(?:button|input|textarea|select|dialog)\b/.test(source),
        `${relative}: use Kumo interactive components`,
      );
      insist(
        !/#(?:[0-9a-fA-F]{3}){1,2}\b|\b(?:rgb|hsl)a?\(/.test(source),
        `${relative}: colors must use semantic theme tokens`,
      );
      insist(
        !/from ['"](?:lucide|@radix-ui|@headlessui|framer-motion)/.test(source),
        `${relative}: unapproved UI dependency`,
      );
      insist(
        !/dangerouslySetInnerHTML|localStorage|sessionStorage/.test(source),
        `${relative}: unsafe rendering or duplicated persistent state`,
      );
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const allowed = new Set([
    '@kiturone/kapibala',
    '@kiturone/kapibala-cli',
    '@kiturone/kapibala-mcp',
    '@cloudflare/kumo',
    '@phosphor-icons/react',
    '@tanstack/react-virtual',
    'react',
    'react-dom',
    'react-markdown',
    'remark-gfm',
    'zustand',
    'zod',
  ]);
  insist(
    Object.keys(manifest.dependencies).every((name) => allowed.has(name)),
    'Unapproved desktop runtime dependency',
  );
  // devDependencies 也全量枚举：UI 运行库被打包器从 devDependencies 内联进产物，
  // 只查 dependencies 会放行新增的未批准 UI 库；构建工具链在此单独登记，新增一律过门禁。
  const devAllowed = new Set([
    '@playwright/test',
    '@tailwindcss/vite',
    '@types/react',
    '@types/react-dom',
    'electron',
    'electron-builder',
    'electron-vite',
    'tailwindcss',
    'typescript',
    'vite',
  ]);
  insist(
    Object.keys(manifest.devDependencies ?? {}).every(
      (name) => allowed.has(name) || devAllowed.has(name),
    ),
    'Unapproved desktop development dependency',
  );
  const css = fs.readFileSync(path.join(desktop, 'src/renderer/index.css'), 'utf8');
  insist(
    css.indexOf('@cloudflare/kumo/styles') < css.indexOf('tailwindcss'),
    'Kumo styles must precede Tailwind',
  );
  insist(
    css.includes('../../node_modules/@cloudflare/kumo/dist'),
    'Kumo distribution needs explicit Tailwind source',
  );
  const theme = fs.readFileSync(path.join(desktop, 'src/renderer/theme-kapibala.css'), 'utf8');
  insist(
    theme.includes('isolation: isolate') && theme.includes(':root[data-mode="dark"]'),
    'Missing root isolation or dark theme',
  );
  insist(
    theme.includes('prefers-reduced-motion: reduce') &&
      theme.includes('transition-duration: 0s !important'),
    'Missing reduced-motion handling for library surfaces',
  );
  // 只检查应用源码；库内部的过渡不被误判为应用新增动效。
  const html = fs.readFileSync(path.join(desktop, 'src/renderer/index.html'), 'utf8');
  insist(
    html.indexOf('boot-theme.js') < html.indexOf('main.tsx') &&
      html.includes('Content-Security-Policy'),
    'Missing first-frame theme or CSP',
  );
  const main = fs.readFileSync(path.join(desktop, 'src/main/index.ts'), 'utf8');
  for (const setting of [
    'contextIsolation: true',
    'sandbox: true',
    'nodeIntegration: false',
    'webSecurity: true',
    'senderFrame !== window.webContents.mainFrame',
    'event.senderFrame.url !== expectedURL',
  ])
    insist(main.includes(setting), `Missing desktop source guard: ${setting}`);
  if (artifacts) {
    for (const file of files(path.join(desktop, 'out/renderer')).filter((item) =>
      item.endsWith('.js'),
    )) {
      const tree = ts.createSourceFile(
        file,
        fs.readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      function inspect(node: ts.Node): void {
        const specifier =
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
            ? node.moduleSpecifier.text
            : undefined;
        if (specifier)
          insist(
            !isBuiltin(specifier) &&
              !specifier.startsWith('@kiturone/') &&
              specifier !== 'electron',
            `Privileged Renderer artifact import: ${specifier}`,
          );
        ts.forEachChild(node, inspect);
      }
      inspect(tree);
    }
    const preload = fs.readFileSync(path.join(desktop, 'out/preload/index.cjs'), 'utf8');
    const requires = [...preload.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1]);
    insist(
      requires.length > 0 && requires.every((name) => name === 'electron'),
      'Sandbox Preload must bundle all dependencies except electron',
    );
    for (const file of [
      'out/main/icon.png',
      'out/main/index.js',
      'out/main/agent-host.js',
      'out/renderer/index.html',
      'out/renderer/boot-theme.js',
    ])
      insist(fs.existsSync(path.join(desktop, file)), `Missing build entry ${file}`);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkDesktop(process.argv.includes('--artifacts'));
  console.log('Desktop process, UI and theme boundaries passed');
}
