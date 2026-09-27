import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSettings, resolveApiKey, resolveBaseURL } from '../packages/cli/src/settings.js';
import { detectShell } from '../packages/core/src/capabilities/shell/detect.js';
import { createRunCommandTool } from '../packages/core/src/capabilities/shell/tool.js';
import { builtinTools } from '../packages/core/src/capabilities/tools/builtin/fs.js';
import type { Tool } from '../packages/core/src/capabilities/tools/index.js';
import { SessionStore } from '../packages/core/src/context/session-store.js';
import { AgentSession } from '../packages/core/src/context/session/index.js';
import { KapibalaError } from '../packages/core/src/errors/index.js';
import type { ModelProvider } from '../packages/core/src/models/index.js';
import { OpenAICompatibleProvider } from '../packages/core/src/models/openai-compatible/index.js';
import type {
  CanonicalMessage,
  ModelEvent,
  ModelRequest,
  SessionEvent,
  Usage,
} from '../packages/core/src/types/index.js';

// 本文件仅执行已授权的隔离验收，不修改默认配置，不放宽产品摘要保护规则。
const { settings } = loadSettings();
const requestedModel =
  process.argv.find((arg) => arg.startsWith('--model='))?.slice(8) ?? settings.defaultModel;
const configured = settings.profiles.find((p) => p.id === requestedModel);
if (!configured) throw new Error('Configured model unavailable');
const key = resolveApiKey(configured, settings);
if (!key) throw new Error('Model credential unavailable');
const profile = { ...configured, contextWindow: '64K' as const };
const summaryProfile = { ...configured, contextWindow: '32K' as const };
const remote = new OpenAICompatibleProvider({
  baseURL: resolveBaseURL(profile),
  apiKey: key,
  modelName: profile.modelName,
});
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-live-quality-'));
const selectedCase = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7);
const outputFile = path.resolve(
  `docs/verification/v0.0.3-live-quality${selectedCase ? `-${selectedCase}` : ''}.json`,
);
const nodeCommand =
  process.platform === 'win32'
    ? `& '${process.execPath.replaceAll("'", "''")}' scripts/check.mjs`
    : `'${process.execPath.replaceAll("'", "'\\''")}' scripts/check.mjs`;
const allowedCommand = (value: unknown) =>
  typeof value === 'string' &&
  [
    nodeCommand,
    ...(process.platform === 'win32'
      ? [
          `${nodeCommand}; "EXIT=$LASTEXITCODE"`,
          `${nodeCommand} 2>&1 | Out-String`,
          `${nodeCommand} 2>&1 | Select-Object -Last 5; "EXIT=$LASTEXITCODE"`,
        ]
      : []),
  ].includes(value.trim());
interface Attempt {
  role: 'primary' | 'summary';
  branch: string;
  durationMs: number;
  textChars: number;
  thinkingChars: number;
  finishReason?: string;
  usage?: Usage;
  complete: boolean;
  failed: boolean;
}
interface Operation {
  branch: string;
  name: string;
  path?: string;
  command?: string;
  outcome: string;
}
const report = {
  date: new Date().toISOString(),
  model: profile.id,
  workload:
    'real model tool calls; actual isolated file edits and Node checks; live summaries and resumed continuations',
  primaryWindow: profile.contextWindow,
  summaryWindow: summaryProfile.contextWindow,
  previousFixtureReport: 'v0.0.3-quality.json',
  checks: [] as Record<string, unknown>[],
};
function save() {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`);
}

const noise = '// source observation: fixture contains no external dependencies.\n'.repeat(300);
const addSource = `${noise}export function add(a, b) { return Math.abs(a) + Math.abs(b); }\n`;
const addTests =
  "import assert from 'node:assert/strict';\nimport { add } from '../src/add.mjs';\nassert.equal(add(2, 3), 5);\nassert.equal(add(-2, -1), -3);\nassert.equal(add(0, 0), 0);\nconsole.log('CHECK PASSED: negative, zero, positive');\n";
const pageSource = `${noise}export function list(items, page = 1) { return items; }\n`;
const pageTests =
  "import assert from 'node:assert/strict';\nimport { list } from '../src/pages.mjs';\nconst items = Array.from({length:45}, (_,i)=>i);\nassert.deepEqual(list(items, 1), items.slice(0,20));\nassert.deepEqual(list(items, 2), items.slice(20,40));\nconsole.log('CHECK PASSED: page size 20, page 1 and 2');\n";
const cases = [
  {
    name: 'multi-file-constraints',
    source: addSource,
    tests: addTests,
    sourcePath: 'src/add.mjs',
    testPath: 'tests/add.test.mjs',
    prompts: [
      '实际修复 add 的负数和零行为并验证。约束：保留 add(a,b) 公共接口；不得改 package.json、scripts/check.mjs 或删除测试；仅修改 src/add.mjs 和 tests/add.test.mjs。先 read_file 阅读这两份文件，优先 edit_file 局部改动，不重写大段注释，然后调用 run_command 执行 node scripts/check.mjs。溢出边界留到后续，别在本轮实现。完成后简洁说明真实验证结果与溢出待办。',
      '只根据历史确认刚才实际完成的修改、测试结果、所有约束和未完成的溢出边界。不要读文件或执行工具。简洁回答。',
    ],
    continuation:
      '继续完成之前留下的溢出边界：输入和结果都必须是安全整数，否则抛 RangeError，补 Number.MAX_SAFE_INTEGER + 1 和正常负数/零的测试。遵守此前文件范围和公共接口约束，用 node scripts/check.mjs 验证，别重复已完成的负数修复。简洁说明。',
  },
  {
    name: 'command-output-and-unknown-effect',
    source: addSource,
    tests: addTests,
    sourcePath: 'src/add.mjs',
    testPath: 'tests/add.test.mjs',
    prompts: [
      '仅实际观察 node scripts/check.mjs 的长测试输出并定位末尾错误，先不要修复。约束：保留 add(a,b)，不得改 package.json、scripts/check.mjs、删除测试，修复范围仅 src/add.mjs 和 tests/add.test.mjs。然后用 write_file 写 unknown.txt 内容 candidate，这次写入将注入结果未知；收到 OUTCOME_UNKNOWN 后不要检查或重写 unknown.txt，本轮停止并标记未知，后续用户会明确要求核实。必须先执行命令再进行该次写入。',
      '现在只修复长输出对应的负数/零错误，实际读取 src/add.mjs 与 tests/add.test.mjs，局部修改并运行 node scripts/check.mjs 验证。不读取或再次写入 unknown.txt，未知写入留待后续明确核实；溢出边界也留作待办。简洁报告结果。',
      '只根据已有结果确认当前约束、已经通过的验证、溢出待办和仍未核实的 unknown.txt 写入。不要调用工具或把未知写入当作成功。简洁回答。',
    ],
    continuation:
      '现在明确核实之前的未知写入：读取 unknown.txt 一次，再执行 node scripts/check.mjs 一次。不要再次写 unknown.txt，不要重复已完成的修复。简洁列出约束、真实结论和仍待完成的溢出边界。',
  },
  {
    name: 'rolling-summary-restart',
    source: pageSource,
    tests: pageTests,
    sourcePath: 'src/pages.mjs',
    testPath: 'tests/pages.test.mjs',
    prompts: [
      '实际实现分页并验证：保留 list(items,page=1) 接口，每页20项，页码从1开始。约束：不得改 package.json 和 scripts/check.mjs、不得删测试，仅修改 src/pages.mjs、tests/pages.test.mjs 和 notes.md。先 read_file 读源码和测试，再 edit_file 局部修改，用 node scripts/check.mjs 验证。非法页码先留作待办。不要重写大段源码注释。',
      '实际实现非法页码校验：小于1或不是整数的页码抛 RangeError，补0、负数和小数测试；先读取现有测试再局部修改，运行 node scripts/check.mjs 验证。同时实际写 notes.md 记录决定：缓存损坏从正文重建；唯一ID前缀歧义测试留作后续任务，别声称已完成。继续保留此前接口、每页20项和修改范围约束。',
      '只修改 notes.md，补充明确决定：列表浏览不能改变内容活动时间，保留唯一ID前缀歧义测试待办。先读 notes.md 再局部修改，不改已验证的代码，不执行命令，不重复工具副作用。简洁报告。',
    ],
    continuation:
      '恢复后续答：遵守之前全部分页约束和决定，不重复修改已验证代码。只执行 node scripts/check.mjs 一次，读取 notes.md 一次；简洁说明每页大小、页码起点/非法页码规则、缓存恢复和浏览活动时间规则，以及仍未完成的唯一ID前缀歧义测试。',
  },
];

for (const item of cases.filter((c) => !selectedCase || c.name === selectedCase)) {
  const current: Record<string, unknown> = {
    name: item.name,
    qualityValidated: false,
    attempts: [] as Attempt[],
    operations: [] as Operation[],
    summaries: [] as SessionEvent[][],
    rounds: [] as unknown[],
  };
  report.checks.push(current);
  const attempts = current.attempts as Attempt[];
  const operations = current.operations as Operation[];
  const root = path.join(directory, item.name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'));
  fs.mkdirSync(path.join(root, 'scripts'));
  const seed = {
    'package.json': '{"type":"module","private":true}\n',
    [item.sourcePath]: item.source,
    [item.testPath]: item.tests,
    'scripts/check.mjs': `for(let i=0;i<400;i++) console.log('fixture test progress '+i);\ntry { await import('../${item.testPath}'); } catch (error) { console.log('FINAL ERROR: '+error.message); process.exitCode=1; }\n`,
    'notes.md': 'Pending: unique ID prefix ambiguity test.\n',
  };
  for (const [file, content] of Object.entries(seed))
    fs.writeFileSync(path.join(root, file), content);
  const immutable = Object.fromEntries(
    ['package.json', 'scripts/check.mjs'].map((file) => [
      file,
      fs.readFileSync(path.join(root, file), 'utf8'),
    ]),
  );
  let branch = 'history';
  let unknownWritten = false;
  const provider: ModelProvider = {
    name: remote.name,
    async *create(request: ModelRequest): AsyncIterable<ModelEvent> {
      if (attempts.length >= 60) throw new Error('Live experiment call limit');
      const start = Date.now();
      const attempt: Attempt = {
        role: request.systemPrompt?.startsWith('Summarize the supplied') ? 'summary' : 'primary',
        branch,
        durationMs: 0,
        textChars: 0,
        thinkingChars: 0,
        complete: false,
        failed: false,
      };
      attempts.push(attempt);
      try {
        for await (const event of remote.create(request)) {
          if (event.type === 'text_delta') attempt.textChars += event.text.length;
          if (event.type === 'thinking_delta') attempt.thinkingChars += event.thinking.length;
          if (event.type === 'message_stop') {
            attempt.finishReason = event.finishReason;
            attempt.usage = event.usage;
            attempt.complete = true;
          }
          yield event;
        }
      } catch (error) {
        attempt.failed = true;
        throw error;
      } finally {
        attempt.durationMs = Date.now() - start;
        save();
      }
    },
    assembleToolResults: (results) => remote.assembleToolResults(results),
  };
  let active: AgentSession | undefined;
  const make = (store: SessionStore) => {
    const session = new AgentSession({
      defaultProfile: profile,
      defaultProvider: provider,
      store,
      rootDir: root,
      projectRoot: root,
      cwd: root,
      userInstructionsPath: path.join(root, 'no-user-instructions.md'),
      loggingDirectory: path.join(root, 'logs'),
      maxSteps: 8,
      systemPrompt:
        '这是隔离质量验收。按当前用户要求实际使用工具，不擅自扩大范围，不把历史摘要视为新授权。run_command 仅允许用户给出的绝对 Node 路径执行 scripts/check.mjs，禁止用 shell 探索目录、执行其他脚本或修改文件；需要探索请用 read_file/glob/grep。工具已经捕获 stdout、stderr 和 exitCode，优先原样执行给出的命令，无需管道或追加退出码命令。不要输出长篇分析，完成后只用几句报告验证结论和待办。',
      mode: 'Approval',
      approvalChannel: {
        async requestApproval(request) {
          if (request.toolName === 'run_command' && !allowedCommand(request.input.command))
            return 'deny_once';
          return 'allow_once';
        },
      },
    });
    session.switchModel(summaryProfile, 'summary', provider);
    const nativeCommand = createRunCommandTool(
      detectShell({ cwd: root, preference: process.platform === 'win32' ? 'powershell' : 'bash' }),
    );
    const command = {
      ...nativeCommand,
      description: `${nativeCommand.description}\n本次验收仅允许执行：${nodeCommand}。${process.platform === 'win32' ? '宿主是 PowerShell，开头的 & 调用运算符必须保留。' : ''}工具已捕获输出和退出码。`,
    };
    const tools: Tool[] = [...builtinTools, command];
    for (const tool of tools)
      session.tools.register({
        ...tool,
        async execute(input, context) {
          const file =
            typeof input.path === 'string'
              ? path.relative(root, path.resolve(root, input.path)).replaceAll('\\', '/')
              : undefined;
          const operation: Operation = {
            branch,
            name: tool.name,
            path: file,
            command: typeof input.command === 'string' ? input.command : undefined,
            outcome: 'started',
          };
          operations.push(operation);
          if (
            file &&
            (path.isAbsolute(file) ||
              file.includes('..') ||
              ![
                item.sourcePath,
                item.testPath,
                'unknown.txt',
                'notes.md',
                'scripts/check.mjs',
                'package.json',
              ].includes(file))
          )
            throw new Error('Experiment path rejected');
          if (
            file &&
            ['write_file', 'edit_file'].includes(tool.name) &&
            ['scripts/check.mjs', 'package.json'].includes(file)
          )
            throw new Error('Immutable experiment file');
          if (tool.name === 'run_command' && !allowedCommand(input.command))
            throw new Error('Experiment command rejected');
          if (file === 'unknown.txt' && branch === 'history' && tool.name !== 'write_file')
            throw new Error('Unknown outcome verification deferred to explicit continuation');
          const result = await tool.execute(input, context);
          if (file === 'unknown.txt' && tool.name === 'write_file' && !unknownWritten) {
            unknownWritten = true;
            operation.outcome = 'OUTCOME_UNKNOWN';
            throw new KapibalaError('Injected acknowledgement failure after actual write', {
              code: 'OUTCOME_UNKNOWN',
              retryPolicy: 'after_user_action',
              safeMessage: '写入确认丢失，结果未知；待用户明确要求核实，不重复写入。',
            });
          }
          operation.outcome = 'completed';
          save();
          return result;
        },
      });
    return session;
  };
  const run = async (session: AgentSession, prompt: string, expectUnknown = false) => {
    const events: SessionEvent[] = [];
    for await (const event of session.run(prompt, { signal: AbortSignal.timeout(180000) }))
      events.push(event);
    const final = session
      .getHistory()
      .filter((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'text'))
      .at(-1);
    const answer = final?.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const metrics = session.getLastRunMetrics();
    if (expectUnknown) {
      assert.equal(metrics?.status, 'failed', 'Unknown outcome must stop the current run');
      assert.ok(
        session
          .getHistory()
          .some((message) =>
            message.content.some(
              (block) => block.type === 'tool_result' && block.errorCode === 'OUTCOME_UNKNOWN',
            ),
          ),
        'Missing durable unknown result',
      );
    } else {
      assert.equal(metrics?.status, 'completed', 'Real task did not finish');
      assert.ok(answer?.trim(), 'No complete answer');
    }
    return { answer, metrics, context: session.getContextSnapshot() };
  };
  const compact = async (session: AgentSession) => {
    for (let retry = 0; retry < 2; retry++) {
      const events: SessionEvent[] = [];
      for await (const event of session.compact({ signal: AbortSignal.timeout(125000) }))
        events.push(event);
      (current.summaries as SessionEvent[][]).push(events);
      save();
      if (events.some((e) => e.type === 'compaction_finish' && e.kind === 'summary')) return;
    }
    throw new Error('No summary checkpoint committed within two explicit attempts');
  };
  try {
    const store = await SessionStore.create(path.join(root, 'history.jsonl'), {
      conversationId: item.name,
      projectRoot: root,
      initialCwd: root,
    });
    active = make(store);
    await active.init();
    for (let i = 0; i < item.prompts.length; i++) {
      (current.rounds as unknown[]).push(
        await run(
          active,
          item.prompts[i].replaceAll('node scripts/check.mjs', nodeCommand),
          item.name === 'command-output-and-unknown-effect' && i === 0,
        ),
      );
      save();
      console.log(
        JSON.stringify({
          case: item.name,
          round: i + 1,
          calls: attempts.length,
          stage: 'real-task-complete',
        }),
      );
      if (item.name === 'rolling-summary-restart' && i === 1) await compact(active);
    }
    await compact(active);
    const history = active.getHistory();
    const projection = active.getContextHistory();
    assert.ok(projection.length < history.length, 'Summary did not replace an old complete prefix');
    const snapshot = Object.fromEntries(
      [item.sourcePath, item.testPath, 'unknown.txt', 'notes.md']
        .filter((file) => fs.existsSync(path.join(root, file)))
        .map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]),
    );
    for (const [file, content] of Object.entries(immutable))
      assert.equal(
        fs.readFileSync(path.join(root, file), 'utf8'),
        content,
        'Forbidden file changed',
      );
    const stats = active.getStats();
    current.historyStats = stats;
    current.rawHistory = history;
    current.compactedProjection = projection;
    await active.destroy();
    active = undefined;
    const restoredStore = await SessionStore.open(store.filePath);
    active = make(restoredStore);
    const callsBeforeRestore = attempts.length;
    const operationsBeforeRestore = operations.length;
    await active.init();
    assert.equal(attempts.length, callsBeforeRestore);
    assert.equal(operations.length, operationsBeforeRestore);
    assert.deepEqual(active.getContextHistory(), projection, 'Projection changed on restart');
    assert.deepEqual(
      active.getStats().summaryUsage,
      stats.summaryUsage,
      'Summary usage duplicated on restart',
    );
    assert.deepEqual(active.getContextHistory().slice(-2), projection.slice(-2));
    current.restoredEqual = true;
    await active.destroy();
    active = undefined;
    const baselineStore = await SessionStore.create(path.join(root, 'baseline.jsonl'), {
      conversationId: `${item.name}-baseline`,
      projectRoot: root,
      initialCwd: root,
    });
    for (const message of history) await baselineStore.append(message);
    branch = 'baseline';
    active = make(baselineStore);
    await active.init();
    const beforeBaseline = operations.length;
    current.baseline = await run(
      active,
      item.continuation.replaceAll('node scripts/check.mjs', nodeCommand),
    );
    current.baselineToolCount = operations.length - beforeBaseline;
    await active.destroy();
    active = undefined;
    const baselineFiles = Object.fromEntries(
      [item.sourcePath, item.testPath, 'unknown.txt', 'notes.md']
        .filter((f) => fs.existsSync(path.join(root, f)))
        .map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]),
    );
    for (const [file, content] of Object.entries(snapshot))
      fs.writeFileSync(path.join(root, file), content);
    branch = 'compressed';
    active = make(await SessionStore.open(store.filePath));
    await active.init();
    const beforeCompressed = operations.length;
    current.compressed = await run(
      active,
      item.continuation.replaceAll('node scripts/check.mjs', nodeCommand),
    );
    current.compressedToolCount = operations.length - beforeCompressed;
    for (const [file, content] of Object.entries(immutable))
      assert.equal(
        fs.readFileSync(path.join(root, file), 'utf8'),
        content,
        'Forbidden file changed',
      );
    if (item.name === 'multi-file-constraints') {
      const { execFileSync } = await import('node:child_process');
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import assert from 'node:assert/strict'; import {add} from './src/add.mjs'; assert.equal(add(-2,-1),-3); assert.throws(()=>add(Number.MAX_SAFE_INTEGER,1),RangeError);",
        ],
        { cwd: root, stdio: 'pipe' },
      );
      // 对原历史分支的实际结果独立检查，避免只验证压缩分支。
      const compressedSource = fs.readFileSync(path.join(root, item.sourcePath), 'utf8');
      fs.writeFileSync(path.join(root, item.sourcePath), baselineFiles[item.sourcePath]);
      try {
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            "import assert from 'node:assert/strict'; import {add} from './src/add.mjs'; assert.equal(add(-2,-1),-3); assert.throws(()=>add(Number.MAX_SAFE_INTEGER,1),RangeError);",
          ],
          { cwd: root, stdio: 'pipe' },
        );
      } finally {
        fs.writeFileSync(path.join(root, item.sourcePath), compressedSource);
      }
    }
    if (item.name.includes('unknown')) {
      assert.equal(fs.readFileSync(path.join(root, 'unknown.txt'), 'utf8'), 'candidate');
      for (const side of ['baseline', 'compressed']) {
        assert.equal(
          operations.filter(
            (o) =>
              o.branch === side &&
              o.name === 'read_file' &&
              o.path === 'unknown.txt' &&
              o.outcome === 'completed',
          ).length,
          1,
        );
        assert.equal(
          operations.filter(
            (o) => o.branch === side && ['write_file', 'edit_file'].includes(o.name),
          ).length,
          0,
        );
      }
    }
    if (item.name.includes('rolling')) {
      assert.equal(stats.contextSnapshot?.summaryCount, 2);
      for (const side of ['baseline', 'compressed'])
        assert.equal(
          operations.filter(
            (o) => o.branch === side && ['write_file', 'edit_file'].includes(o.name),
          ).length,
          0,
        );
    }
    current.experimentCompleted = true;
    current.qualityValidated = false;
    current.review =
      'Actual outcomes and restoration passed; semantic answer review still required';
    console.log(
      JSON.stringify({
        case: item.name,
        stage: 'comparison-complete',
        restoredEqual: true,
        calls: attempts.length,
      }),
    );
  } catch (error) {
    current.failedHistory = active?.getHistory();
    current.failedMetrics = active?.getLastRunMetrics();
    current.experimentCompleted = false;
    current.failure =
      error instanceof KapibalaError
        ? error.code
        : error instanceof Error && ['AssertionError', 'Error'].includes(error.name)
          ? error.message.slice(0, 160)
          : 'Live experiment failed';
    console.log(
      JSON.stringify({
        case: item.name,
        stage: 'failed',
        reason: current.failure,
        calls: attempts.length,
      }),
    );
  } finally {
    if (active && !active.isBusy()) await active.destroy();
    save();
  }
}
const resolved = path.resolve(directory);
assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
assert.ok(path.basename(resolved).startsWith('kpbl-live-quality-'));
fs.rmSync(resolved, { recursive: true, force: true });
