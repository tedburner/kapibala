import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSettings, resolveApiKey, resolveBaseURL } from '../packages/cli/src/settings.js';
import { AgentSession } from '../packages/core/src/context/session/index.js';
import { AnthropicProvider } from '../packages/core/src/models/anthropic/index.js';
import { OpenAICompatibleProvider } from '../packages/core/src/models/openai-compatible/index.js';
import { OpenAIResponsesProvider } from '../packages/core/src/models/openai-responses/index.js';
import type { SessionEvent } from '../packages/core/src/types/index.js';

// 小样本真实模型验收：只提供隔离技能的读取能力；不改用户设置，不输出密钥或私有思考状态。
const { settings } = loadSettings({ includeProject: false });
const profile = settings.profiles.find((item) => item.id === settings.defaultModel);
if (!profile) throw new Error('Configured default model unavailable');
const key = resolveApiKey(profile, settings);
if (!key) throw new Error('Configured model credential unavailable');
const options = { modelName: profile.modelName, baseURL: resolveBaseURL(profile), apiKey: key };
const provider =
  profile.provider === 'anthropic'
    ? new AnthropicProvider(options)
    : profile.provider === 'openai-responses'
      ? new OpenAIResponsesProvider(options)
      : new OpenAICompatibleProvider(options);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kpbl-v005-live-'));
const output = path.resolve('.workbuddy/v0.0.5-live-skills.json');
const report = {
  date: new Date().toISOString(),
  model: profile.id,
  protocol: profile.provider,
  maxStepsPerTask: 5,
  maxOutputTokens: 768,
  samples: [] as {
    caller: string;
    status: string | undefined;
    skillLoaded: boolean;
    resourceRead: boolean;
    answerMarker: boolean;
    toolNames: string[];
    tokens: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
  }[],
};
try {
  const global = path.join(root, 'global-skills');
  const dir = path.join(global, 'evidence-guide');
  await fs.mkdir(path.join(dir, 'references'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    '---\nname: evidence-guide\ndescription: >-\n  用中文读取参考资料并核对验收口令，\n  用于用户要求基于证据确认技能能力时。\nallowed-tools: []\n---\n必须用 read_skill_resource 读取 references/evidence.md。仅根据资源中的事实回答，最后附上资源中的验收口令。不得猜测或执行脚本。',
  );
  await fs.writeFile(
    path.join(dir, 'references/evidence.md'),
    '验收口令：CAPYBARA-SKILL-OK。事实：当前示例只允许受控读取，不执行脚本。',
  );
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const session = new AgentSession({
    defaultProfile: { ...profile, maxOutputTokens: 768 },
    defaultProvider: provider,
    rootDir: project,
    userInstructionsPath: path.join(root, 'missing'),
    loggingDirectory: path.join(root, 'logs'),
    mode: 'Plan',
    maxSteps: 5,
    skills: { roots: [{ path: global, scope: 'global', trusted: true }] },
  });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 120000);
  try {
    for (const caller of ['model', 'user']) {
      const events: SessionEvent[] = [];
      const stream =
        caller === 'model'
          ? session.run(
              '请使用 evidence-guide 技能，读取其参考资源，根据实际内容用中文回答事实和验收口令。',
              { signal: abort.signal },
            )
          : session.runSkill('evidence-guide', '按技能要求读取参考资源，回答真实事实和验收口令。', {
              signal: abort.signal,
            });
      for await (const event of stream) events.push(event);
      const answer = events
        .filter((event) => event.type === 'text_delta')
        .map((event) => event.text)
        .join('');
      const tools = events.filter((event) => event.type === 'tool_finish');
      report.samples.push({
        caller,
        status: session.getLastRunMetrics()?.status,
        skillLoaded: events.some((event) => event.type === 'skill_loaded'),
        resourceRead: tools.some(
          (event) =>
            event.name === 'read_skill_resource' &&
            !event.isError &&
            event.result.includes('CAPYBARA-SKILL-OK'),
        ),
        answerMarker: answer.includes('CAPYBARA-SKILL-OK'),
        toolNames: tools.map((event) => event.name),
        tokens: session.getLastRunMetrics()
          ? {
              promptTokens: session.getLastRunMetrics()!.promptTokens,
              completionTokens: session.getLastRunMetrics()!.completionTokens,
              totalTokens:
                session.getLastRunMetrics()!.promptTokens +
                session.getLastRunMetrics()!.completionTokens,
            }
          : undefined,
      });
      console.log(JSON.stringify(report.samples.at(-1)));
      if (abort.signal.aborted) break;
    }
  } finally {
    clearTimeout(timer);
    await session.destroy();
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  if (
    report.samples.length !== 2 ||
    report.samples.some(
      (sample) =>
        sample.status !== 'completed' ||
        !sample.skillLoaded ||
        !sample.resourceRead ||
        !sample.answerMarker,
    )
  )
    process.exitCode = 1;
} finally {
  assert.ok(
    path.dirname(root) === path.resolve(os.tmpdir()) &&
      path.basename(root).startsWith('kpbl-v005-live-'),
  );
  await fs.rm(root, { recursive: true, force: true });
}
