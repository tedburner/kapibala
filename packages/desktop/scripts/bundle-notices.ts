import fs from 'node:fs';
import path from 'node:path';

/** 构建期间收集内联依赖的来源与原始许可，不把开发机绝对路径写入分发附件。 */
export interface BundledLicense {
  name: string;
  version: string;
  license: string;
  texts: string[];
}
/** 按模块及上游预打包来源收集许可；补充原文须匹配精确版本，未知来源保留 UNKNOWN 而不推定同许可证。 */
export function collectBundledLicenses(
  moduleIds: Iterable<string>,
  supplements: readonly BundledLicense[] = [],
): BundledLicense[] {
  const found = new Map<string, BundledLicense>();
  const vendors = new Map<string, { name: string; version: string }>();
  for (const id of moduleIds) {
    const file = id.split('?')[0];
    if (
      !path.isAbsolute(file) ||
      !file.includes(`${path.sep}node_modules${path.sep}`) ||
      !fs.existsSync(file)
    )
      continue;
    const physical = fs.realpathSync.native(file);
    // Kumo 等上游已经内联其它依赖；region 中的版本与当前安装版本可能不同，不能仅追当前依赖树。
    if (/\.[cm]?[jt]sx?$/.test(physical)) {
      const source = fs.readFileSync(physical, 'utf8');
      for (const match of source.matchAll(
        /\/\.pnpm\/([^/\s]+)\/node_modules\/((?:@[^/\s]+\/)?[^/\s]+)/g,
      )) {
        const identity = match[1].split('_')[0];
        const separator = identity.lastIndexOf('@');
        if (separator <= 0 || identity.slice(0, separator).replace('+', '/') !== match[2]) continue;
        const name = match[2];
        const version = identity.slice(separator + 1);
        vendors.set(`${name}@${version}`, { name, version });
      }
    }
    for (let directory = path.dirname(physical); ; directory = path.dirname(directory)) {
      const manifest = path.join(directory, 'package.json');
      if (fs.existsSync(manifest)) {
        const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        // 一些包的 dist/package.json 仅声明 type；继续查找真正的包身份。
        if (typeof metadata.name === 'string' && typeof metadata.version === 'string') {
          if (!found.has(directory)) {
            const texts = fs
              .readdirSync(directory)
              .filter(
                (name) =>
                  /^(licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(name) &&
                  fs.statSync(path.join(directory, name)).isFile(),
              )
              .map(
                (name) => `### ${name}\n\n${fs.readFileSync(path.join(directory, name), 'utf8')}`,
              );
            found.set(directory, {
              name: metadata.name,
              version: metadata.version,
              license: typeof metadata.license === 'string' ? metadata.license : 'UNKNOWN',
              texts,
            });
          }
          break;
        }
      }
      if (path.dirname(directory) === directory) break;
    }
  }
  const entries = [...found.values()];
  for (const { name, version } of vendors.values()) {
    if (entries.some((item) => item.name === name && item.version === version)) continue;
    const exact = supplements.find((item) => item.name === name && item.version === version);
    entries.push(
      exact
        ? { name, version, license: exact.license, texts: [...exact.texts] }
        : { name, version, license: 'UNKNOWN', texts: [] },
    );
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}
