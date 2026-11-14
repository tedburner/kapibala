import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const testBuild = z
  .object({
    kind: z.literal('test'),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    dirty: z.boolean(),
    platform: z.enum(['darwin', 'win32', 'linux']),
    arch: z.enum(['arm64', 'x64']),
    verification: z.enum(['passed', 'skipped']),
  })
  .strict();
const candidateBuild = testBuild
  .extend({
    kind: z.literal('candidate'),
    dirty: z.literal(false),
    verification: z.literal('passed'),
    runId: z.string().regex(/^[1-9]\d*$/),
    runAttempt: z.string().regex(/^[1-9]\d*$/),
  })
  .strict();
const packaged = z.union([testBuild, candidateBuild]);
/** 构建身份由安装包自身提供；测试包不能因 isPackaged 为真而冒充正式签名候选。 */
export type DesktopBuildInfo = { kind: 'development' } | z.infer<typeof packaged>;
/** 只读应用自己的清单，不读用户配置；缺少可验证构建身份的安装包拒绝启动。 */
export function readBuildInfo(appPath: string, isPackaged: boolean): DesktopBuildInfo {
  if (!isPackaged) return { kind: 'development' };
  try {
    const file = path.join(appPath, 'package.json');
    if (fs.statSync(file).size > 1024 * 1024) throw new Error('too-large');
    return packaged.parse(JSON.parse(fs.readFileSync(file, 'utf8')).kapibalaBuild);
  } catch {
    throw new Error('PACKAGED_BUILD_IDENTITY_REQUIRED');
  }
}
/** 仅明确的测试运行允许替换 home/userData；两条绝对路径必须齐备，失败时不回退真实用户目录。 */
export function testPaths(
  info: Pick<DesktopBuildInfo, 'kind'>,
  input: { enabled?: string; home?: string; userData?: string },
): { home: string; userData: string } | undefined {
  if (input.enabled !== '1') return undefined;
  if (
    !['development', 'test'].includes(info.kind) ||
    !input.home ||
    !input.userData ||
    !path.isAbsolute(input.home) ||
    !path.isAbsolute(input.userData)
  )
    throw new Error('ISOLATED_PATHS_REQUIRED');
  return { home: input.home, userData: input.userData };
}
