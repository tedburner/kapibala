import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  assertCandidateAssets,
  assertDesktopEvidence,
  candidatePolicy,
} from '../desktop-candidate.js';
const sha = 'a'.repeat(40);
const env = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'tedburner/kapibala',
  GITHUB_RUN_ID: '42',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_SHA: sha,
  KPBL_CANDIDATE_SHA: sha,
  KPBL_DESKTOP_CANDIDATE: '1',
  CSC_LINK: 'fixture',
  CSC_KEY_PASSWORD: 'fixture',
  CSC_NAME: 'Developer ID Application: Fixture',
  APPLE_TEAM_ID: 'ABCDE12345',
  APPLE_API_KEY: '/fixture/key.p8',
  APPLE_API_KEY_ID: 'fixture',
  APPLE_API_ISSUER: 'fixture',
};
it('正式候选只接受当前仓库的干净原生 CI 构建，缺少签名身份不能降级', () => {
  expect(candidatePolicy(env, 'darwin')).toMatchObject({ runId: '42', commit: sha });
  expect(() => candidatePolicy({ ...env, GITHUB_ACTIONS: '' }, 'darwin')).toThrow(
    'CANDIDATE_CI_REQUIRED',
  );
  expect(() => candidatePolicy({ ...env, KPBL_CANDIDATE_SHA: 'b'.repeat(40) }, 'darwin')).toThrow(
    'CANDIDATE_SHA_MISMATCH',
  );
  expect(() => candidatePolicy({ ...env, CSC_LINK: '' }, 'darwin')).toThrow('SIGNING_REQUIRED');
});
const targets = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'];
function receipt() {
  return {
    schemaVersion: 1,
    commit: sha,
    version: '0.1.0',
    reviewer: 'maintainer',
    reviewedAt: '2026-10-25T00:00:00Z',
    licenseReviewed: true,
    gates: Object.fromEntries(
      ['FLOW', 'IPC', 'STATE', 'CONFIG', 'LIFECYCLE', 'RENDER', 'PACKAGE', 'SOAK'].map((name) => [
        name,
        {
          status: 'passed',
          commit: sha,
          coverage: targets,
          logs: ['https://example.test/report'],
          worktreeDirty: false,
          debugOverride: false,
          rounds: 1000,
          durationMs: 1800000,
        },
      ]),
    ),
    artifacts: targets.map((target, i) => ({
      target,
      runId: '42',
      runAttempt: '1',
      artifactId: String(100 + i),
      artifactName: `desktop-${target}-${sha}-1`,
      artifactDigest: `sha256:${'b'.repeat(64)}`,
      files: [
        {
          name: `Kapibala-0.1.0-${target}.${target.startsWith('darwin') ? 'dmg' : target.startsWith('win32') ? 'exe' : 'AppImage'}`,
          sha256: 'c'.repeat(64),
        },
        { name: 'candidate-build.json', sha256: 'd'.repeat(64) },
      ],
      signing: {
        verified: true as const,
        identity: target.startsWith('linux') ? 'not-required' : 'fixture',
      },
      installationReviewed: true as const,
    })),
  };
}
it('桌面发布必须覆盖八类专项、四个原生目标以及已审核的精确附件', () => {
  expect(() => assertDesktopEvidence(receipt(), sha, '0.1.0')).not.toThrow();
  for (const change of [
    (r: any) => r.artifacts.pop(),
    (r: any) => {
      r.gates.PACKAGE.status = 'pending';
    },
    (r: any) => {
      r.licenseReviewed = false;
    },
    (r: any) => {
      r.artifacts[0].files[0].name = '../escape.dmg';
    },
    (r: any) => {
      r.artifacts[0].signing.verified = false;
    },
    (r: any) => {
      r.gates.SOAK.debugOverride = true;
    },
  ]) {
    const value = receipt();
    change(value);
    expect(() => assertDesktopEvidence(value, sha, '0.1.0')).toThrow();
  }
});
it('候选内容校验拒绝替换的来源、平台或哈希，测试构建不能进入正式附件', () => {
  const build = {
    kind: 'candidate',
    sourceSha: sha,
    dirty: false,
    verification: 'passed',
    platform: 'darwin',
    arch: 'arm64',
    version: '0.1.0',
    runId: '42',
    runAttempt: '1',
    signedCandidate: true,
    signing: { verified: true as const, identity: 'fixture' },
    missingLicenseData: false,
  };
  expect(() => assertCandidateAssets(build, receipt().artifacts[0], sha, '0.1.0')).not.toThrow();
  expect(() =>
    assertCandidateAssets({ ...build, kind: 'test' }, receipt().artifacts[0], sha, '0.1.0'),
  ).toThrow();
  expect(() =>
    assertCandidateAssets(
      { ...build, sourceSha: 'b'.repeat(40) },
      receipt().artifacts[0],
      sha,
      '0.1.0',
    ),
  ).toThrow();
});

it('下载内容必须逐文件匹配审核，不接受缺件、额外文件或被替换字节', async () => {
  const { verifyCandidateDirectory } = await import('../desktop-candidate.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-candidate-assets-'));
  try {
    const artifact = receipt().artifacts[0];
    const build = {
      kind: 'candidate',
      sourceSha: sha,
      dirty: false,
      verification: 'passed',
      platform: 'darwin',
      arch: 'arm64',
      version: '0.1.0',
      runId: '42',
      runAttempt: '1',
      signedCandidate: true,
      signing: artifact.signing,
      missingLicenseData: false,
    };
    fs.writeFileSync(path.join(root, artifact.files[0].name), 'immutable-installer');
    fs.writeFileSync(path.join(root, 'candidate-build.json'), JSON.stringify(build));
    artifact.files = artifact.files.map((file) => ({
      ...file,
      sha256: createHash('sha256')
        .update(fs.readFileSync(path.join(root, file.name)))
        .digest('hex'),
    }));
    verifyCandidateDirectory(root, artifact, sha, '0.1.0');
    fs.writeFileSync(path.join(root, 'unreviewed.txt'), 'extra');
    expect(() => verifyCandidateDirectory(root, artifact, sha, '0.1.0')).toThrow(
      'UNREVIEWED_ARTIFACT_FILES',
    );
    fs.unlinkSync(path.join(root, 'unreviewed.txt'));
    fs.writeFileSync(path.join(root, artifact.files[0].name), 'replacement');
    expect(() => verifyCandidateDirectory(root, artifact, sha, '0.1.0')).toThrow(
      'ARTIFACT_FILE_HASH_MISMATCH',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
