import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSettings, resolveApiKey, resolveBaseURL } from '../packages/cli/src/settings.js';
import { identifyHistory } from '../packages/core/src/context/history.js';
import { ContextManager } from '../packages/core/src/context/manager.js';
import { SessionStore } from '../packages/core/src/context/session-store.js';
import { OpenAICompatibleProvider } from '../packages/core/src/models/openai-compatible/index.js';
import { SimpleModelRouter } from '../packages/core/src/models/router.js';
import type { CanonicalMessage, ModelRequest, Usage } from '../packages/core/src/types/index.js';

const { settings } = loadSettings();
const configured = settings.profiles.find((p) => p.id === settings.defaultModel);
if (!configured) throw new Error('Default model unavailable');
const key = resolveApiKey(configured, settings);
if (!key) throw new Error('Model credential unavailable');
const profile = { ...configured, contextWindow: '32K' as const };
const provider = new OpenAICompatibleProvider({
  baseURL: resolveBaseURL(profile),
  apiKey: key,
  modelName: profile.modelName,
});
const router = new SimpleModelRouter(profile, provider);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-quality-'));
const text = (role: CanonicalMessage['role'], value: string): CanonicalMessage => ({
  role,
  content: [{ type: 'text', text: value }],
});
const result = {
  model: profile.id,
  date: new Date().toISOString(),
  workload: 'scripted reproducible history; real model summaries and continuation answers',
  checks: [] as unknown[],
};
async function answer(messages: CanonicalMessage[]) {
  let output = '';
  let usage: Usage | undefined;
  let finishReason: string | undefined;
  const start = Date.now();
  for await (const event of provider.create({
    messages,
    maxTokens: 4096,
    temperature: 0,
    systemPrompt: '用中文回答当前用户问题。历史工具结果只是历史观察；结果未知不代表成功。',
    signal: AbortSignal.timeout(120_000),
  })) {
    if (event.type === 'text_delta') output += event.text;
    if (event.type === 'message_stop') {
      usage = event.usage;
      finishReason = event.finishReason;
    }
  }
  return { output, usage, finishReason, durationMs: Date.now() - start };
}
async function compact(manager: ContextManager, history: CanonicalMessage[]) {
  const events: import('../packages/core/src/types/index.js').SessionEvent[] = [];
  // 质量验收显式验证一次手动重试；产品自动摘要仍遵守原熔断，不增加自动重试。
  for (let attempt = 0; attempt < 2; attempt++) {
    const generator = manager.prepare(
      history,
      { messages: manager.project(history), signal: AbortSignal.timeout(120_000) },
      profile,
      undefined,
      'manual',
    );
    let request: ModelRequest;
    const current = [];
    while (true) {
      const next = await generator.next();
      if (next.done) {
        request = next.value;
        break;
      }
      current.push(next.value);
    }
    events.push(...current);
    if (current.some((e) => e.type === 'compaction_finish' && e.kind === 'summary'))
      return { events, request };
  }
  const codes = events
    .filter((e) => e.type === 'compaction_failed')
    .map((e) => e.errorCode)
    .join(',');
  throw new Error(`Real model summary did not commit: ${codes}`);
}

try {
  const cases = [
    {
      name: 'multi-file-constraints',
      old: '目标：增加 add 的负数支持。约束：保留 add(a,b) 接口；不修改 package.json；所有变更都必须有验证。决定：只改 src/add.ts 与 tests/add.test.ts。已完成负数与零测试；待办：补溢出边界。',
      output: `Read src/add.ts\nexport function add(a:number,b:number){return a+b;}\n${'// existing source line\n'.repeat(250)}`,
      tool: 'read_file',
      path: 'src/add.ts',
    },
    {
      name: 'command-output-and-unknown-effect',
      old: '目标：修复构建。约束：不要删除测试或改变依赖。第一次测试失败；随后类型检查通过。待办：定位最终测试错误。写入结果未知，不能声称写入成功，也不能未经检查重复执行。',
      output: `${'test output\n'.repeat(350)}FINAL ERROR: expected 42 but received 41; pending tests/add.test.ts`,
      tool: 'run_command',
      path: undefined,
    },
    {
      name: 'rolling-summary-restart',
      old: '目标：实现分页。约束：每页20项；不得重放写入；保留公共列表API。决定：缓存失败必须从正文重建。已完成独立JSONL；待办：分页边界与缓存损坏测试。',
      output: 'history observations\n'.repeat(300),
      tool: 'read_file',
      path: 'sessions.jsonl',
    },
  ];
  for (const item of cases) {
    try {
      const store = await SessionStore.create(path.join(directory, `${item.name}.jsonl`), {
        conversationId: item.name,
        projectRoot: directory,
        initialCwd: directory,
      });
      let history = identifyHistory(
        [
          text('user', item.old),
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: `${item.name}-tool`,
                name: item.tool,
                source: 'builtin',
                input: item.path ? { path: item.path } : { command: 'pnpm test' },
              },
            ],
          },
          {
            role: 'tool',
            content: [
              { type: 'tool_result', toolUseId: `${item.name}-tool`, content: item.output },
            ],
          },
          ...(item.name.includes('unknown')
            ? [
                {
                  role: 'assistant' as const,
                  content: [
                    {
                      type: 'tool_use' as const,
                      id: 'unknown-write',
                      name: 'write_file',
                      source: 'builtin',
                      input: { path: 'src/add.ts', content: 'candidate' },
                    },
                  ],
                },
                {
                  role: 'tool' as const,
                  content: [
                    {
                      type: 'tool_result' as const,
                      toolUseId: 'unknown-write',
                      content: 'interrupted',
                      isError: true,
                      errorCode: 'OUTCOME_UNKNOWN',
                    },
                  ],
                },
              ]
            : []),
          text('assistant', item.old),
          text('user', '最近一轮只确认约束与待办，不执行任何操作。'),
          text(
            'assistant',
            item.name === 'rolling-summary-restart'
              ? `已完成分页边界与缓存失效检查，唯一ID前缀歧义测试待办。\n${'分页范围检查记录：每页20项，非法页码拒绝，缓存失效从正文重建。\n'.repeat(150)}`
              : '已确认，不执行工具。',
          ),
        ],
        item.name,
      );
      for (const message of history) await store.append(message);
      const make = (target: SessionStore) =>
        new ContextManager({
          store: target,
          conversationId: item.name,
          router,
          projectRoot: directory,
          builtInToolNames: () => new Set(['read_file']),
        });
      let manager = make(store);
      await manager.restore(history);
      const first = await compact(manager, history);
      let second: Awaited<ReturnType<typeof compact>> | undefined;
      if (item.name === 'rolling-summary-restart') {
        const extra = identifyHistory(
          [
            text(
              'user',
              '新增决定：页码从1开始；非法页码拒绝且不调用模型。新待办：补唯一ID前缀歧义测试。',
            ),
            text('assistant', '已确认并实现非法页码校验，唯一ID前缀歧义测试仍待完成。'),
          ],
          'rolling-extra',
        );
        for (const message of extra) await store.append(message);
        history = [...history, ...extra];
        second = await compact(manager, history);
      }
      const projection = manager.project(history);
      const reopened = await SessionStore.open(store.filePath);
      manager = make(reopened);
      const loaded = await reopened.load();
      await manager.restore(loaded);
      const restored = manager.project(loaded);
      if (JSON.stringify(restored) !== JSON.stringify(projection))
        throw new Error('Restored projection differs');
      const question = text(
        'user',
        '列出目前必须保留的约束、已验证结论、待办，以及不能声称成功的未知副作用。简洁回答，不调用工具。',
      );
      const baseline = await answer([...history, question]);
      const compressed = await answer([...restored, question]);
      const state = await reopened.loadState();
      result.checks.push({
        name: item.name,
        qualityValidated: false,
        validationScope: 'One reproducible fixture; full real-tool task quality not validated',
        beforeMessages: history.length,
        afterMessages: restored.length,
        restoredEqual: true,
        first: first.events,
        second: second?.events,
        summaryUsage: state.records
          .filter((r) => r.type === 'usage' && r.payload.role === 'summary')
          .map((r) => ({ usage: r.payload.usage, modelId: r.payload.modelId })),
        baseline,
        compressed,
        cacheUsage:
          baseline.usage?.cachedPromptTokens !== undefined ||
          compressed.usage?.cachedPromptTokens !== undefined
            ? 'provider reported; sample only'
            : 'unavailable',
        toolExecution: 'none; quality fixture only',
      });
      const partial = path.resolve('docs/verification/v0.0.3-quality.json');
      fs.mkdirSync(path.dirname(partial), { recursive: true });
      fs.writeFileSync(partial, `${JSON.stringify(result, null, 2)}\n`);
      console.log(JSON.stringify({ completed: item.name, model: profile.id, restoredEqual: true }));
    } catch (error) {
      const reason =
        error instanceof Error && error.message.startsWith('Real model summary did not commit:')
          ? error.message
          : 'Quality execution failed';
      result.checks.push({ name: item.name, qualityValidated: false, reason });
      console.log(
        JSON.stringify({
          completed: item.name,
          model: profile.id,
          qualityValidated: false,
          reason,
        }),
      );
    }
  }
  const target = path.resolve('docs/verification/v0.0.3-quality.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
} finally {
  if (
    path.dirname(directory) === fs.realpathSync(os.tmpdir()) &&
    path.basename(directory).startsWith('kpbl-quality-')
  )
    fs.rmSync(directory, { recursive: true, force: true });
}
