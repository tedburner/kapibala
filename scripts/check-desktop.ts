import fs from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repository = fileURLToPath(new URL('../', import.meta.url));
const desktop = path.join(repository, 'packages/desktop');
const MAX_RENDERER_LINES = 450;

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
/**
 * 静态校验桌面四进程导入边界、UI 2.0 语义主题 Token、单文件行数预算、依赖白名单与主进程安全守卫；
 * 彻底禁止 `@cloudflare/kumo`、硬编码色值、业务面直接导入 `@phosphor-icons/react` 及跨进程越权导入。
 * `artifacts = true` 时额外校验已构建渲染产物无特权依赖且 sandbox Preload 仅保留 electron 外部 require。
 */
export function checkDesktop(artifacts = false): void {
  for (const file of files(path.join(desktop, 'src')).filter((item) =>
    /\.[cm]?[jt]sx?$/.test(item),
  )) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(path.join(desktop, 'src'), file).replaceAll('\\', '/');
    const browser = /^(renderer|shared)\//.test(relative);
    if (relative.startsWith('renderer/') && /\.[jt]sx?$/.test(file)) {
      const lineCount = source.split(/\r?\n/).length;
      insist(
        lineCount <= MAX_RENDERER_LINES,
        `${relative}: exceeds ${MAX_RENDERER_LINES} lines (${lineCount})`,
      );
    }
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
        if (relative.startsWith('renderer/')) {
          insist(
            !/\/(?:agent-host|main|preload)\//.test(specifier),
            `${relative}: cross-process import`,
          );
          insist(
            !specifier.startsWith('@cloudflare/kumo'),
            `${relative}: @cloudflare/kumo has been retired in UI 2.0`,
          );
        }
        if (relative.startsWith('renderer/surfaces/')) {
          insist(
            specifier !== '@phosphor-icons/react',
            `${relative}: surfaces must consume icons through renderer/ui/Icon`,
          );
        }
        if (relative.startsWith('agent-host/') && specifier.startsWith('@kiturone/kapibala-cli'))
          insist(
            specifier === '@kiturone/kapibala-cli/commands',
            `${relative}: private CLI import（命令系统子路径是唯一例外；宿主层已迁至 @kiturone/kapibala-host）`,
          );
        if (relative.startsWith('agent-host/') && specifier.startsWith('@kiturone/kapibala-host'))
          insist(
            specifier === '@kiturone/kapibala-host/host' ||
              specifier === '@kiturone/kapibala-host/view-model' ||
              specifier === '@kiturone/kapibala-host/internal',
            `${relative}: private host import`,
          );
        if (
          (relative.startsWith('renderer/') ||
            relative.startsWith('shared/') ||
            relative.startsWith('preload/')) &&
          specifier.startsWith('@kiturone/kapibala-host')
        )
          insist(
            specifier === '@kiturone/kapibala-host/view-model',
            `${relative}: browser/preload may only import the view-model subpath`,
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
    if (relative.startsWith('renderer/') && /\.[jt]sx?$/.test(file)) {
      insist(
        !/#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|\b(?:rgb|hsl|oklch)a?\(/.test(
          source,
        ),
        `${relative}: colors must use semantic theme tokens`,
      );
      insist(
        !/from ['"](?:@cloudflare\/kumo|lucide|@radix-ui|@headlessui|framer-motion)/.test(source),
        `${relative}: unapproved UI dependency`,
      );
      insist(
        !/dangerouslySetInnerHTML|localStorage|sessionStorage/.test(source),
        `${relative}: unsafe rendering or duplicated persistent state`,
      );
    }
  }
  for (const cssFile of files(path.join(desktop, 'src/renderer')).filter((item) =>
    item.endsWith('.css'),
  )) {
    const cssSource = fs.readFileSync(cssFile, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const relCss = path.relative(path.join(desktop, 'src'), cssFile).replaceAll('\\', '/');
    insist(
      !/transition-all|transition:\s*all|@keyframes/.test(cssSource),
      `${relCss}: CSS motion must remain explicit and bounded`,
    );
    if (relCss !== 'renderer/styles/tokens.css' && relCss !== 'renderer/styles/shiki.css') {
      insist(
        !/#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|\b(?:rgb|hsl|oklch)a?\(/.test(
          cssSource,
        ),
        `${relCss}: component CSS must consume --kpbl-* tokens instead of color literals`,
      );
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const allowed = new Set([
    '@kiturone/kapibala',
    '@kiturone/kapibala-host',
    '@kiturone/kapibala-cli',
    '@phosphor-icons/react',
    '@tanstack/react-virtual',
    'node-pty',
    'react',
    'react-dom',
    'remark-gfm',
    'zustand',
    'zod',
  ]);
  insist(
    Object.keys(manifest.dependencies).every((name) => allowed.has(name)),
    'Unapproved desktop runtime dependency',
  );
  const devAllowed = new Set([
    '@playwright/test',
    '@streamdown/cjk',
    '@streamdown/code',
    '@streamdown/math',
    '@streamdown/mermaid',
    '@tailwindcss/vite',
    '@types/react',
    '@types/react-dom',
    '@xterm/addon-fit',
    '@xterm/addon-web-links',
    '@xterm/xterm',
    'electron',
    'electron-builder',
    'electron-vite',
    'katex',
    'streamdown',
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
  const tokensCss = fs.readFileSync(path.join(desktop, 'src/renderer/styles/tokens.css'), 'utf8');
  const baseCss = fs.readFileSync(path.join(desktop, 'src/renderer/styles/base.css'), 'utf8');
  insist(
    baseCss.includes('isolation: isolate') && tokensCss.includes(':root[data-mode="dark"]'),
    'Missing root isolation or dark theme tokens',
  );
  insist(
    baseCss.includes('prefers-reduced-motion: reduce') &&
      baseCss.includes('transition-duration: 0s !important'),
    'Missing reduced-motion handling',
  );
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
    'normalizeMainFrameUrl(event.senderFrame.url) !== expectedURL',
    'expectedURL = normalizeUrl(initial.href)',
    "if (mainFrame && !inPlace) renderer?.peer.close('RENDERER_NAVIGATED')",
  ])
    insist(main.includes(setting), `Missing desktop source guard: ${setting}`);
  for (const file of [
    ...files(path.join(desktop, 'scripts')).filter((item) => item.endsWith('.mjs')),
    ...files(path.join(desktop, 'e2e')).filter((item) => item.endsWith('.ts')),
    ...files(path.join(desktop, 'packaged-e2e')).filter((item) => item.endsWith('.ts')),
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(desktop, file).replaceAll('\\', '/');
    insist(
      !/\benv:\s*\{\s*\.\.\.process\.env\b/.test(source) && !/\benv:\s*process\.env\b/.test(source),
      `${relative}: Electron 启动环境必须用 launch-env 的白名单构造，禁止继承整个 process.env`,
    );
  }
  for (const launcher of ['scripts/dev.mjs', 'scripts/try-packaged.mjs'])
    insist(
      fs
        .readFileSync(path.join(desktop, launcher), 'utf8')
        .includes('desktopLaunchEnv(process.env'),
      `${launcher}: 必须用 desktopLaunchEnv 构造 Electron 启动环境`,
    );
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
