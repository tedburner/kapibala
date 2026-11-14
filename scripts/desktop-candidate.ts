import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const targets = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'];
const gates = ['FLOW', 'IPC', 'STATE', 'CONFIG', 'LIFECYCLE', 'RENDER', 'PACKAGE', 'SOAK'];
const object = (value: unknown): value is Record<string, any> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const numericId = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9]\d*$/.test(value);
const assetPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
  value.split('/').every((part) => part && part !== '..' && part !== '.');
function https(value: unknown): boolean {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}
/** 正式候选只来自固定仓库的原生 CI；身份信息用于追溯，不能替代之后的实际签名验证。 */
export function candidatePolicy(
  env: Record<string, string | undefined>,
  platform = process.platform,
) {
  if (
    (platform === 'darwin' &&
      [
        'CSC_LINK',
        'CSC_KEY_PASSWORD',
        'CSC_NAME',
        'APPLE_TEAM_ID',
        'APPLE_API_KEY',
        'APPLE_API_KEY_ID',
        'APPLE_API_ISSUER',
      ].some((key) => !env[key])) ||
    (platform === 'win32' &&
      ['CSC_LINK', 'CSC_KEY_PASSWORD', 'KPBL_WINDOWS_SIGNER_THUMBPRINT'].some((key) => !env[key]))
  )
    throw new Error('SIGNING_REQUIRED');
  ensure(
    env.GITHUB_ACTIONS === 'true' &&
      env.KPBL_DESKTOP_CANDIDATE === '1' &&
      env.GITHUB_REPOSITORY === 'tedburner/kapibala' &&
      numericId(env.GITHUB_RUN_ID) &&
      numericId(env.GITHUB_RUN_ATTEMPT),
    'CANDIDATE_CI_REQUIRED',
  );
  ensure(
    /^[a-f0-9]{40}$/.test(env.KPBL_CANDIDATE_SHA ?? '') &&
      env.KPBL_CANDIDATE_SHA === env.GITHUB_SHA,
    'CANDIDATE_SHA_MISMATCH',
  );
  return {
    commit: env.KPBL_CANDIDATE_SHA!,
    runId: env.GITHUB_RUN_ID!,
    runAttempt: env.GITHUB_RUN_ATTEMPT!,
  };
}
/** 审核索引中的附件身份；每个文件都需独立哈希，不以可变名称或 latest 下载替代。 */
export interface DesktopArtifact {
  target: string;
  runId: string;
  runAttempt: string;
  artifactId: string;
  artifactName: string;
  artifactDigest: string;
  files: { name: string; sha256: string }[];
  signing: { verified: true; identity: string };
  installationReviewed: true;
}
/** 桌面证据在原六类专项之外增加八类桌面专项与四个目标，未执行、调试或脏运行均不可通过。 */
export function assertDesktopEvidence(
  value: unknown,
  sha: string,
  version: string,
): asserts value is { artifacts: DesktopArtifact[] } {
  ensure(
    object(value) && value.schemaVersion === 1 && value.commit === sha && value.version === version,
    'DESKTOP_EVIDENCE_IDENTITY',
  );
  ensure(
    nonempty(value.reviewer) &&
      Number.isFinite(Date.parse(value.reviewedAt)) &&
      value.licenseReviewed === true,
    'DESKTOP_REVIEW_REQUIRED',
  );
  ensure(object(value.gates), 'DESKTOP_GATES_REQUIRED');
  for (const name of gates) {
    const gate = value.gates[name];
    ensure(
      object(gate) &&
        gate.status === 'passed' &&
        gate.commit === sha &&
        gate.worktreeDirty === false &&
        gate.debugOverride === false,
      `DESKTOP_${name}_NOT_PASSED`,
    );
    ensure(
      Array.isArray(gate.coverage) && targets.every((target) => gate.coverage.includes(target)),
      `DESKTOP_${name}_COVERAGE`,
    );
    ensure(
      Array.isArray(gate.logs) && gate.logs.length && gate.logs.every(https),
      `DESKTOP_${name}_LOGS`,
    );
    if (name === 'SOAK')
      ensure(
        Number.isSafeInteger(gate.rounds) &&
          gate.rounds >= 1000 &&
          Number.isFinite(gate.durationMs) &&
          gate.durationMs >= 1_800_000,
        'DESKTOP_SOAK_TOO_SHORT',
      );
  }
  ensure(
    Array.isArray(value.artifacts) && value.artifacts.length === targets.length,
    'DESKTOP_TARGETS_REQUIRED',
  );
  const seen = new Set<string>();
  const ids = new Set<string>();
  for (const artifact of value.artifacts) {
    ensure(
      object(artifact) && targets.includes(artifact.target) && !seen.has(artifact.target),
      'DESKTOP_TARGET_INVALID',
    );
    seen.add(artifact.target);
    ensure(
      numericId(artifact.runId) &&
        numericId(artifact.runAttempt) &&
        numericId(artifact.artifactId) &&
        !ids.has(artifact.artifactId),
      'DESKTOP_ARTIFACT_ID_INVALID',
    );
    ids.add(artifact.artifactId);
    ensure(
      artifact.artifactName === `desktop-${artifact.target}-${sha}-${artifact.runAttempt}` &&
        /^sha256:[a-f0-9]{64}$/.test(artifact.artifactDigest),
      'DESKTOP_ARTIFACT_ORIGIN',
    );
    ensure(
      object(artifact.signing) &&
        artifact.signing.verified === true &&
        nonempty(artifact.signing.identity) &&
        artifact.installationReviewed === true,
      'DESKTOP_SIGNING_OR_INSTALL_REVIEW',
    );
    ensure(Array.isArray(artifact.files) && artifact.files.length > 1, 'DESKTOP_FILES_REQUIRED');
    const names = new Set<string>();
    for (const file of artifact.files) {
      ensure(
        object(file) &&
          assetPath(file.name) &&
          !names.has(file.name) &&
          /^[a-f0-9]{64}$/.test(file.sha256),
        'DESKTOP_FILE_INVALID',
      );
      names.add(file.name);
    }
    ensure(
      names.has('candidate-build.json') &&
        [...names].some((name) =>
          name.endsWith(
            artifact.target.startsWith('darwin')
              ? '.dmg'
              : artifact.target.startsWith('win32')
                ? '.exe'
                : '.AppImage',
          ),
        ),
      'DESKTOP_INSTALLER_REQUIRED',
    );
  }
}
/** 下载后的候选清单必须与人工审核的来源和平台一致；测试构建或缺许可记录不能混入。 */
export function assertCandidateAssets(
  value: unknown,
  artifact: DesktopArtifact,
  sha: string,
  version: string,
): void {
  ensure(
    object(value) &&
      value.kind === 'candidate' &&
      value.sourceSha === sha &&
      value.version === version &&
      value.dirty === false &&
      value.verification === 'passed' &&
      value.signedCandidate === true &&
      value.missingLicenseData === false,
    'CANDIDATE_BUILD_INVALID',
  );
  ensure(
    `${value.platform}-${value.arch}` === artifact.target &&
      value.runId === artifact.runId &&
      value.runAttempt === artifact.runAttempt,
    'CANDIDATE_PROVENANCE_MISMATCH',
  );
  ensure(
    object(value.signing) &&
      value.signing.verified === true &&
      value.signing.identity === artifact.signing.identity,
    'CANDIDATE_SIGNING_MISMATCH',
  );
}
function command(binary: string, args: string[]): string {
  const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0)
    throw new Error(`${binary} failed: ${result.stderr ?? result.error?.message}`);
  return result.stdout;
}
function api(suffix: string) {
  return JSON.parse(command('gh', ['api', `repos/tedburner/kapibala/${suffix}`]));
}
/** 核对下载目录的精确文件集合与字节摘要；多件、缺件、符号链接或候选身份不符均拒绝。 */
export function verifyCandidateDirectory(
  directory: string,
  artifact: DesktopArtifact,
  sha: string,
  version: string,
): void {
  const actual: string[] = [];
  function walk(current: string) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      ensure(!entry.isSymbolicLink(), 'UNSAFE_ARCHIVE_LINK');
      if (entry.isDirectory()) walk(file);
      else {
        ensure(entry.isFile(), 'UNSAFE_ARCHIVE_MEMBER');
        actual.push(path.relative(directory, file).replaceAll('\\', '/'));
      }
    }
  }
  walk(directory);
  ensure(
    actual.length === artifact.files.length &&
      actual.every((name) => artifact.files.some((file) => file.name === name)),
    'UNREVIEWED_ARTIFACT_FILES',
  );
  for (const file of artifact.files)
    ensure(
      createHash('sha256')
        .update(fs.readFileSync(path.join(directory, file.name)))
        .digest('hex') === file.sha256,
      'ARTIFACT_FILE_HASH_MISMATCH',
    );
  assertCandidateAssets(
    JSON.parse(fs.readFileSync(path.join(directory, 'candidate-build.json'), 'utf8')),
    artifact,
    sha,
    version,
  );
}
/** 发布阶段只下载审核的 artifact ID，检查工作流、摘要、候选和逐文件哈希；绝不重建或重新签名。 */
export function downloadReviewedDesktop(
  value: unknown,
  sha: string,
  version: string,
  destination: string,
): void {
  assertDesktopEvidence(value, sha, version);
  fs.mkdirSync(destination, { recursive: true });
  for (const artifact of value.artifacts) {
    const remote = api(`actions/artifacts/${artifact.artifactId}`);
    const run = api(`actions/runs/${artifact.runId}`);
    ensure(
      remote.name === artifact.artifactName &&
        remote.expired === false &&
        remote.digest === artifact.artifactDigest &&
        String(remote.workflow_run?.id) === artifact.runId &&
        remote.workflow_run?.head_sha === sha,
      'REMOTE_ARTIFACT_MISMATCH',
    );
    ensure(
      run.head_sha === sha &&
        run.conclusion === 'success' &&
        run.event === 'workflow_dispatch' &&
        run.path === '.github/workflows/desktop-candidate.yml' &&
        String(run.run_attempt) === artifact.runAttempt &&
        run.repository?.full_name === 'tedburner/kapibala',
      'CANDIDATE_WORKFLOW_MISMATCH',
    );
    const directory = path.join(destination, artifact.target);
    fs.mkdirSync(directory, { recursive: false });
    const archive = path.join(destination, `${artifact.artifactId}.zip`);
    const fd = fs.openSync(archive, 'wx');
    try {
      const result = spawnSync(
        'gh',
        ['api', `repos/tedburner/kapibala/actions/artifacts/${artifact.artifactId}/zip`],
        { stdio: ['ignore', fd, 'pipe'] },
      );
      ensure(result.status === 0, 'ARTIFACT_DOWNLOAD_FAILED');
    } finally {
      fs.closeSync(fd);
    }
    ensure(
      `sha256:${createHash('sha256').update(fs.readFileSync(archive)).digest('hex')}` ===
        artifact.artifactDigest,
      'ARCHIVE_DIGEST_MISMATCH',
    );
    const listing = command('unzip', ['-Z', '-1', archive]).trim().split('\n');
    ensure(
      listing.every((name) => assetPath(name.endsWith('/') ? name.slice(0, -1) : name)),
      'UNSAFE_ARCHIVE_PATH',
    );
    // 固定候选工作流只上传普通文件；先拒绝 Unix symlink 属性，再解压，防止链接成员逃逸。
    ensure(
      !command('zipinfo', ['-l', archive])
        .split('\n')
        .some((line) => line.startsWith('l')),
      'UNSAFE_ARCHIVE_LINK',
    );
    command('unzip', ['-q', archive, '-d', directory]);
    fs.unlinkSync(archive);
    verifyCandidateDirectory(directory, artifact, sha, version);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, sha, version, destination] = process.argv.slice(2);
    ensure(
      action === 'download' &&
        /^[a-f0-9]{40}$/.test(sha ?? '') &&
        /^\d+\.\d+\.\d+$/.test(version ?? '') &&
        nonempty(destination),
      'Usage: desktop-candidate download <sha> <version> <directory>',
    );
    const manifest = JSON.parse(process.env.KPBL_RELEASE_EVIDENCE ?? 'null');
    downloadReviewedDesktop(manifest?.desktop, sha, version, destination);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Candidate check failed');
    process.exitCode = 1;
  }
}
