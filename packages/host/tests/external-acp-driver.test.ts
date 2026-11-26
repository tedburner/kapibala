import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpStdioDriver } from '../src/host/external/drivers/acp/acp-driver.js';
import {
  resolveAcpFlavor,
  resolveOpenCodePreferredConfig,
} from '../src/host/external/drivers/acp/flavors.js';
import { ExternalTranscriptProjector } from '../src/host/external/drivers/acp/projector.js';
import {
  findAcpConfigOption,
  normalizeAcpConfigOptions,
  normalizeAcpConfigSummary,
  normalizeAcpPlanUpdate,
} from '../src/host/external/drivers/acp/tolerance.js';
import type { ExternalEvent, ExternalHarnessDefinition } from '../src/host/external/types.js';

const fixtureScript = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

const tempDirs: string[] = [];
const openHandles: Array<() => Promise<void>> = [];
function makeTempWorkspace(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync.native(dir);
}

afterEach(async () => {
  for (const closeFn of openHandles.splice(0)) {
    await closeFn().catch(() => {});
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function makeFakeHarness(
  mode: string,
  overrides: Partial<ExternalHarnessDefinition> = {},
): ExternalHarnessDefinition {
  return {
    id: `fake-${mode}`,
    name: `Fake ACP (${mode})`,
    transport: 'acp',
    command: process.execPath,
    args: [fixtureScript, `--mode=${mode}`],
    enabled: true,
    ...overrides,
  };
}

describe('ACP Flavor 与线格式宽容层', () => {
  it('按显式 flavor、命令基名与握手 agentInfo.name 三级识别已知代理方言', () => {
    expect(
      resolveAcpFlavor({
        command: 'C:\\Users\\Demo\\AppData\\Local\\agy\\bin\\agy.exe',
        args: ['acp'],
      }).id,
    ).toBe('antigravity');

    expect(
      resolveAcpFlavor({
        command: 'my-wrapper.exe',
        args: ['--acp'],
        agentInfoName: 'opencode',
      }).id,
    ).toBe('opencode');

    const opencodeHint = resolveAcpFlavor({
      command: 'opencode',
      args: [],
    }).misconfiguredCommandHint?.('opencode', []);
    expect(opencodeHint).toContain('acp');

    expect(
      resolveAcpFlavor({
        command: 'C:\\Users\\Demo\\.omp\\bin\\omp.exe',
        args: ['acp'],
      }).id,
    ).toBe('omp');

    expect(
      resolveAcpFlavor({
        command: 'C:\\Users\\Demo\\.qoder-cn\\bin\\qoderclicn\\qoderclicn.exe',
        args: ['--acp'],
      }).id,
    ).toBe('qoder-cn');

    expect(
      resolveAcpFlavor({
        command: 'qodercli',
        args: ['--acp'],
      }).id,
    ).toBe('qoder');

    expect(
      resolveAcpFlavor({
        command: 'traecli',
        args: ['acp', 'serve'],
      }).id,
    ).toBe('trae');
  });

  it('单条脏 configOptions 不崩整包，且双读 plan entries/plan 字段', () => {
    const summary = normalizeAcpConfigSummary({
      configOptions: [
        null,
        { id: 'broken', options: 'not-an-array' },
        {
          id: 'model',
          category: 'model',
          currentValue: 'gemini-3-pro',
          options: [{ value: 'gemini-3-pro', name: 'Gemini 3 Pro' }],
        },
      ],
      modes: { currentModeId: 'architect' },
    });
    expect(summary).toEqual({
      modelLabel: 'Gemini 3 Pro',
      modeLabel: 'architect',
    });

    const itemsFromPlanField = normalizeAcpPlanUpdate({
      plan: [
        { title: '步骤 A', status: 'completed' },
        { content: '步骤 B', status: 'unknown_vendor_state' },
      ],
    });
    expect(itemsFromPlanField).toEqual([
      { id: 'ext-todo-1', title: '步骤 A', status: 'completed' },
      { id: 'ext-todo-2', title: '步骤 B', status: 'pending' },
    ]);
  });

  it('兼容分组 configOptions、旧式 availableModels/availableModes 显示名反查与单项配置更新', () => {
    const groupedPayload = {
      configOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'opencode/deepseek-v4.1-flash-free',
          options: [
            {
              group: 'opencode',
              name: 'OpenCode',
              options: [
                {
                  value: 'opencode/deepseek-v4.1-flash-free',
                  name: 'opencode/DeepSeek V4.1 Flash Free',
                },
              ],
            },
          ],
        },
      ],
    };
    expect(normalizeAcpConfigSummary(groupedPayload)).toEqual({
      modelLabel: 'opencode/DeepSeek V4.1 Flash Free',
    });
    const modelOpt = findAcpConfigOption(groupedPayload, 'model');
    expect(modelOpt?.id).toBe('model');
    expect(modelOpt?.hasOption('opencode/deepseek-v4.1-flash-free')).toBe(true);
    expect(modelOpt?.hasOption('opencode/missing')).toBe(false);

    expect(
      normalizeAcpConfigSummary({
        models: {
          currentModelId: 'gemini-4-neon-high',
          availableModels: [{ modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' }],
        },
        modes: {
          currentModeId: 'accept-edits',
          availableModes: [{ id: 'accept-edits', name: 'Accept edits' }],
        },
      }),
    ).toEqual({
      modelLabel: 'Gemini 4 Neon (High)',
      modeLabel: 'Accept edits',
    });

    expect(
      normalizeAcpConfigSummary({
        configId: 'model',
        currentValue: 'deepseek-reasoner',
      }),
    ).toEqual({
      modelLabel: 'deepseek-reasoner',
    });

    expect(
      normalizeAcpConfigSummary({
        currentModelId: 'qwen-3-coder',
      }),
    ).toEqual({
      modelLabel: 'qwen-3-coder',
    });
  });

  it('OpenCode TUI model.json 同步：无显式 opencode.json model 时读取模型与档位，有显式配置时尊重配置文件', () => {
    const home = makeTempWorkspace('kpbl-opencode-pref-');
    const cwd = makeTempWorkspace('kpbl-opencode-cwd-');
    const stateDir = path.join(home, '.local', 'state', 'opencode');
    const cfgDir = path.join(home, '.config', 'opencode');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'model.json'),
      JSON.stringify({
        recent: [{ providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free' }],
        variant: { 'opencode/deepseek-v4.1-flash-free': 'max' },
      }),
    );
    // 含 URL 字符串内 // 的 opencode.json（无 model 字段），不得误判或解析失败。
    fs.writeFileSync(
      path.join(cfgDir, 'opencode.json'),
      JSON.stringify({
        mcp: { demo: { type: 'remote', url: 'https://example.com/mcp' } },
      }),
    );

    expect(
      resolveOpenCodePreferredConfig({
        workspaceRoot: cwd,
        homeDir: home,
        env: {},
        platform: 'darwin',
      }),
    ).toEqual([
      { category: 'model', value: 'opencode/deepseek-v4.1-flash-free' },
      { category: 'thought_level', value: 'max' },
    ]);

    // 工作区 opencode.jsonc 显式声明了 model（含注释与尾随逗号），此时不得覆盖用户显式配置。
    fs.writeFileSync(
      path.join(cwd, 'opencode.jsonc'),
      '// explicit model\n{ "model": "opencode/big-pickle", }\n',
    );
    expect(
      resolveOpenCodePreferredConfig({
        workspaceRoot: cwd,
        homeDir: home,
        env: {},
        platform: 'darwin',
      }),
    ).toBeUndefined();
  });
});

describe('AcpStdioDriver 真实子进程契约测试', () => {
  it('inspect 识别 loadSession 与 DSH sessionCapabilities.resume，以及 Antigravity 自动 authenticate 与登录提示', async () => {
    const cwd = makeTempWorkspace('kpbl-acp-inspect-');
    const driver = new AcpStdioDriver();

    const dshRes = await driver.inspect(makeFakeHarness('dsh-resume', { flavor: 'dsh' }), cwd);
    expect(dshRes.available).toBe(false);
    expect(dshRes.status).toBe('auth_unverified');
    expect(dshRes.agentName).toBe('deepseek-harness');
    expect(dshRes.version).toBe('0.2.0-rc.2');
    expect(dshRes.loadSupported).toBe(true);

    const agyOk = await driver.inspect(
      makeFakeHarness('agy-auth-ok', { flavor: 'antigravity' }),
      cwd,
    );
    expect(agyOk.status).toBe('ready');
    expect(agyOk.agentName).toBe('antigravity');

    const agyFail = await driver.inspect(
      makeFakeHarness('agy-auth-fail', { flavor: 'antigravity' }),
      cwd,
    );
    expect(agyFail.available).toBe(false);
    expect(agyFail.status).toBe('needs_login');
    expect(agyFail.loginHint).toContain('agy acp --login');

    const floodRes = await driver.inspect(
      makeFakeHarness('tui-flood', { flavor: 'opencode' }),
      cwd,
    );
    expect(floodRes.available).toBe(false);
    expect(floodRes.status).toBe('handshake_failed');
  });

  it('完整跑通流式思考/计划、反向 fs -32601 拒绝、noteToolCall 审批补卡、allow_session 透传与回显去重', async () => {
    const cwd = makeTempWorkspace('kpbl-acp-turn-');
    const driver = new AcpStdioDriver();
    const projector = new ExternalTranscriptProjector('ext-ses-1');
    const rawEvents: ExternalEvent[] = [];

    const opened = await driver.open({
      def: makeFakeHarness('normal', { flavor: 'opencode' }),
      workspaceRoot: cwd,
      onEvent: (event) => {
        rawEvents.push(event);
        projector.applyEvent(event);
        if (event.type === 'approval_requested') {
          // 验证 allow_session 原样保留，且此时 noteToolCall 已先插入 running 工具卡
          expect(event.options.map((o) => o.kind)).toEqual([
            'allow_once',
            'allow_session',
            'reject_once',
          ]);
          const runningTools = rawEvents.filter((e) => e.type === 'tool_upsert');
          expect(runningTools.length).toBeGreaterThanOrEqual(1);
          event.respond({ outcome: 'selected', optionId: 'allow-session' });
        }
      },
    });

    expect(opened.nativeSessionId).toBe('ses_demo_1');
    expect(opened.resumable).toBe(true);
    expect(opened.modelLabel).toBe('DeepSeek Chat');
    expect(opened.modeLabel).toBe('Code');

    projector.beginUserTurn('NEED_APPROVAL');
    const turnResult = await opened.handle.prompt('NEED_APPROVAL');
    projector.completeTurn(turnResult.usage);

    expect(turnResult.stopReason).toBe('completed');
    expect(turnResult.usage).toEqual({
      promptTokens: 12,
      completionTokens: 8,
      totalTokens: 20,
    });

    const messages = projector.getMessages();
    // 仅 1 条用户消息（回显的 user_message_chunk 被去重）+ 1 条助手消息
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('user');
    expect(messages[1]?.role).toBe('assistant');

    const assistantBlocks = messages[1]!.blocks;
    expect(assistantBlocks.map((b) => b.kind)).toEqual(['thinking', 'tool', 'text']);
    const toolBlock = assistantBlocks.find((b) => b.kind === 'tool')!;
    expect(toolBlock.tool?.status).toBe('succeeded');
    expect(toolBlock.tool?.chip).toBe('git status --short');
    // 确认假子进程收到了宿主对 fs/read_text_file 的 -32601 拒绝以及 allow-session 选项
    expect(toolBlock.tool?.result).toContain('approved=allow-session;fsProbe=-32601');

    expect(projector.getPlan()?.items).toHaveLength(2);

    await opened.handle.close();
  });

  it('兼容 OpenCode 1.19.3 session/load：发请求前预绑 ID 捕获前置重放通知，且未知自定义命令默认 resumable=false', async () => {
    const cwd = makeTempWorkspace('kpbl-acp-load-');
    const driver = new AcpStdioDriver();

    // 1. 已知可验证 flavor（opencode）走 session/load 重放历史并继续对话
    const resumed = await driver.open({
      def: makeFakeHarness('opencode-load', { flavor: 'opencode' }),
      workspaceRoot: cwd,
      nativeSessionId: 'ses_existing_99',
      onEvent: () => {},
    });

    expect(resumed.nativeSessionId).toBe('ses_existing_99');
    expect(resumed.resumable).toBe(true);
    expect(resumed.modelLabel).toBe('OpenCode Pro');
    expect(resumed.replayedMessages).toHaveLength(2);
    expect(resumed.replayedMessages?.[0]?.role).toBe('user');
    expect(resumed.replayedMessages?.[0]?.blocks[0]?.text).toContain('历史问题');
    expect(resumed.replayedMessages?.[1]?.role).toBe('assistant');
    expect(resumed.replayedMessages?.[1]?.blocks[0]?.text).toContain('历史回答');

    const nextTurn = await resumed.handle.prompt('继续');
    expect(nextTurn.stopReason).toBe('completed');
    await resumed.handle.close();

    // 2. 未经实测背书的 generic 自定义命令即使声明 loadSession: true，resumable 仍须为 false
    const genericOpened = await driver.open({
      def: makeFakeHarness('normal', { flavor: 'generic' }),
      workspaceRoot: cwd,
      onEvent: () => {},
    });
    expect(genericOpened.resumable).toBe(false);
    await genericOpened.handle.close();
  });

  it('支持 cancel() 发送 session/cancel 中断运行中的轮次并干净收口', async () => {
    const cwd = makeTempWorkspace('kpbl-acp-cancel-');
    const driver = new AcpStdioDriver();

    const opened = await driver.open({
      def: makeFakeHarness('normal', { flavor: 'opencode' }),
      workspaceRoot: cwd,
      onEvent: () => {},
    });

    const promptPromise = opened.handle.prompt('WAIT_CANCEL');
    await new Promise((resolve) => setTimeout(resolve, 80));
    await opened.handle.cancel();

    const result = await promptPromise;
    expect(result.stopReason).toBe('cancelled');
    await opened.handle.close();
  });

  it('无进展看门狗到期时以 EXTERNAL_TIMEOUT 拒绝，且投影器支持跨分片密钥脱敏、冷恢复 ID 递增与 620KiB 预算裁剪', async () => {
    const cwd = makeTempWorkspace('kpbl-acp-watchdog-');
    const fastWatchdogDriver = new AcpStdioDriver({ turnWatchdogMs: 120 });

    const opened = await fastWatchdogDriver.open({
      def: makeFakeHarness('normal', { flavor: 'opencode' }),
      workspaceRoot: cwd,
      onEvent: () => {},
    });
    openHandles.push(() => opened.handle.close());

    await expect(opened.handle.prompt('HANG_FOREVER')).rejects.toMatchObject({
      code: 'EXTERNAL_TIMEOUT',
    });

    // 验证投影器：1) replaceMessages 推进计数器防 ID 碰撞；2) 跨 chunk 切分密钥脱敏；3) 超大输出自动裁剪
    const projector = new ExternalTranscriptProjector('ext-proj-1', ['customSecretXYZ999']);
    projector.replaceMessages([
      {
        id: 'ext-proj-1:msg:5',
        role: 'user',
        state: 'completed',
        persisted: true,
        blocks: [{ id: 'b0', kind: 'text', text: 'old', state: 'completed', revision: 0 }],
      },
    ]);
    projector.beginUserTurn('new turn');
    expect(projector.getMessages().map((m) => m.id)).toEqual([
      'ext-proj-1:msg:5',
      'ext-proj-1:user:6',
    ]);

    projector.applyEvent({ type: 'text_delta', text: 'Key=customSecret' });
    projector.applyEvent({ type: 'text_delta', text: 'XYZ999 & Bearer ' });
    projector.applyEvent({ type: 'text_delta', text: 'splitTokenAbcdef123456!' });
    projector.applyEvent({
      type: 'tool_upsert',
      tool: {
        callId: 'big-tool',
        name: 'bash',
        displayName: '终端命令',
        invocation: '运行 big',
        input: 'A'.repeat(200_000),
        result: 'B'.repeat(900_000),
        status: 'succeeded',
      },
    });
    projector.completeTurn();

    expect(projector.wasTruncated()).toBe(true);
    const serialized = JSON.stringify(projector.getMessages());
    expect(serialized).not.toContain('customSecretXYZ999');
    expect(serialized).not.toContain('splitTokenAbcdef123456');
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(680 * 1024);
  });

  it('ExternalTranscriptProjector 在后续用户轮次自动清空已全部完结的计划，未完结计划跨轮次保留', () => {
    const projector = new ExternalTranscriptProjector('ext-plan-lifecycle');
    projector.beginUserTurn('第一轮任务');
    projector.applyEvent({
      type: 'plan_updated',
      items: [
        { id: '1', title: '步骤一', status: 'completed' },
        { id: '2', title: '步骤二', status: 'in_progress' },
      ],
    });
    projector.completeTurn();
    expect(projector.getPlan()?.items).toHaveLength(2);

    // 仍含进行中项时，后续轮次保留计划面板。
    projector.beginUserTurn('继续');
    expect(projector.getPlan()?.items).toHaveLength(2);

    // 全部完结后，本轮结束仍展示已完成计划，进入下一轮时自动清空。
    projector.applyEvent({
      type: 'plan_updated',
      items: [
        { id: '1', title: '步骤一', status: 'completed' },
        { id: '2', title: '步骤二', status: 'cancelled' },
      ],
    });
    projector.completeTurn();
    expect(projector.getPlan()?.items).toHaveLength(2);

    projector.beginUserTurn('下一轮新问题');
    expect(projector.getPlan()).toBeUndefined();

    // 回放历史时，已完结计划后紧跟的新用户消息同样触发清空。
    projector.applyEvent({
      type: 'plan_updated',
      items: [{ id: '3', title: '已完结回放项', status: 'completed' }],
    });
    expect(projector.getPlan()?.items).toHaveLength(1);
    projector.applyEvent({ type: 'user_delta', text: '回放新轮次', replay: true });
    expect(projector.getPlan()).toBeUndefined();
  });

  it('OpenCode 新建会话自动通过 session/set_config_option 同步本地 model.json 的模型与推理档位', async () => {
    const cwd = makeTempWorkspace('kpbl-acp-sync-cwd-');
    const home = makeTempWorkspace('kpbl-acp-sync-home-');
    const stateDir = path.join(home, '.local', 'state', 'opencode');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'model.json'),
      JSON.stringify({
        recent: [{ providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free' }],
        variant: { 'opencode/deepseek-v4.1-flash-free': 'max' },
      }),
    );

    // 跨平台纯函数先验证 macOS/Linux 与 Windows LOCALAPPDATA 候选路径解析
    expect(
      resolveOpenCodePreferredConfig({
        workspaceRoot: cwd,
        homeDir: home,
        env: {},
        platform: 'darwin',
      }),
    ).toEqual([
      { category: 'model', value: 'opencode/deepseek-v4.1-flash-free' },
      { category: 'thought_level', value: 'max' },
    ]);
    const winAppData = makeTempWorkspace('kpbl-acp-win-localappdata-');
    fs.mkdirSync(path.join(winAppData, 'opencode'), { recursive: true });
    fs.writeFileSync(
      path.join(winAppData, 'opencode', 'model.json'),
      JSON.stringify({ recent: [{ providerID: 'opencode', modelID: 'seaglass-alpha-free' }] }),
    );
    expect(
      resolveOpenCodePreferredConfig({
        workspaceRoot: cwd,
        homeDir: makeTempWorkspace('kpbl-acp-empty-home-'),
        env: { LOCALAPPDATA: winAppData },
        platform: 'win32',
      }),
    ).toEqual([{ category: 'model', value: 'opencode/seaglass-alpha-free' }]);

    // 真实拉起 process.execPath 子进程时使用当前宿主平台，防止在 Windows 下以 POSIX 绝对路径规则误拒盘符路径
    const driver = new AcpStdioDriver({ homeDir: home });
    const textChunks: string[] = [];
    const opened = await driver.open({
      def: makeFakeHarness('opencode-model-sync', { flavor: 'opencode' }),
      workspaceRoot: cwd,
      onEvent: (event) => {
        if (event.type === 'text_delta') textChunks.push(event.text);
      },
    });

    expect(opened.modelLabel).toBe('opencode/DeepSeek V4.1 Flash Free');
    expect(opened.modeLabel).toBe('Build');

    await opened.handle.prompt('hello');
    expect(textChunks.join('')).toBe(
      'model=opencode/deepseek-v4.1-flash-free;effort=max;mode=build;text=hello',
    );

    // 会话空闲态支持动态切换模型、推理档位与模式
    const afterModel = await opened.handle.setConfigOption!({
      configId: 'model',
      category: 'model',
      value: 'opencode/seaglass-alpha-free',
    });
    expect(afterModel.modelLabel).toBe('opencode/Seaglass Alpha Free');
    const afterEffort = await opened.handle.setConfigOption!({
      configId: 'effort',
      category: 'thought_level',
      value: 'high',
    });
    expect(afterEffort.thoughtLevelLabel).toBe('High');
    const afterMode = await opened.handle.setConfigOption!({
      configId: 'mode',
      category: 'mode',
      value: 'plan',
    });
    expect(afterMode.modeLabel).toBe('Plan');

    textChunks.length = 0;
    await opened.handle.prompt('after-switch');
    expect(textChunks.join('')).toBe(
      'model=opencode/seaglass-alpha-free;effort=high;mode=plan;text=after-switch',
    );
    await opened.handle.close();

    // 新建会话显式指定 modelId 时优先覆盖 OpenCode model.json 默认值，且 inspect 返回完整 configOptions
    const probed = await driver.inspect(
      makeFakeHarness('opencode-model-sync', { flavor: 'opencode' }),
      cwd,
    );
    expect(probed.available).toBe(true);
    expect(
      probed.configOptions?.find((opt) => opt.category === 'model')?.options.map((o) => o.value),
    ).toContain('opencode/seaglass-alpha-free');

    const explicitOpen = await driver.open({
      def: makeFakeHarness('opencode-model-sync', { flavor: 'opencode' }),
      workspaceRoot: cwd,
      initialConfig: [{ category: 'model', value: 'opencode/seaglass-alpha-free' }],
      onEvent: () => {},
    });
    expect(explicitOpen.modelLabel).toBe('opencode/Seaglass Alpha Free');
    expect(explicitOpen.configOptions?.find((opt) => opt.category === 'model')?.currentValue).toBe(
      'opencode/seaglass-alpha-free',
    );
    expect(normalizeAcpConfigOptions({ configOptions: [] })).toEqual([]);
    await explicitOpen.handle.close();
  });
});
