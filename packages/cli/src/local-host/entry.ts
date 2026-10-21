import type { ConnectOptions } from './connect.js';

/** 只识别显式本地子命令，普通提问保持走原入口；校验先于配置或进程副作用。 */
export type LocalCommand =
  | { command: 'serve'; stdio: boolean; child: boolean; runtimeDir?: string }
  | { command: 'daemon'; action: 'start' | 'status' | 'stop'; runtimeDir?: string }
  | ({ command: 'connect' } & ConnectOptions);

/** 白名单解析本地参数；不接受网络端口、权限提升或临时密钥等未实现选项。 */
export function parseLocalCommand(argv: string[]): LocalCommand | undefined {
  const command = argv[0];
  if (!['serve', 'daemon', 'connect'].includes(command)) return undefined;
  const options: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const strings = new Set(['--runtime-dir', '--workspace', '--resume', '--prompt', '-p']);
  for (let i = 1; i < argv.length; i++) {
    const name = argv[i];
    if (name === '--stdio' || name === '--local-daemon-child') options[name] = true;
    else if (strings.has(name)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
      options[name === '-p' ? '--prompt' : name] = value;
    } else if (name.startsWith('-')) throw new Error(`Unsupported local option: ${name}`);
    else positional.push(name);
  }
  const runtimeDir = options['--runtime-dir'] as string | undefined;
  if (
    command === 'serve' &&
    positional.length === 0 &&
    Boolean(options['--stdio']) !== Boolean(options['--local-daemon-child']) &&
    Object.keys(options).every((key) =>
      ['--stdio', '--local-daemon-child', '--runtime-dir'].includes(key),
    )
  ) {
    if (options['--local-daemon-child'] && !runtimeDir)
      throw new Error('Daemon child requires runtime directory');
    return {
      command,
      stdio: Boolean(options['--stdio']),
      child: Boolean(options['--local-daemon-child']),
      runtimeDir,
    };
  }
  if (
    command === 'daemon' &&
    positional.length === 1 &&
    ['start', 'status', 'stop'].includes(positional[0]) &&
    Object.keys(options).every((key) => key === '--runtime-dir')
  ) {
    return { command, action: positional[0] as 'start' | 'status' | 'stop', runtimeDir };
  }
  if (
    command === 'connect' &&
    positional.length === 0 &&
    Object.keys(options).every((key) => strings.has(key))
  ) {
    return {
      command,
      runtimeDir,
      workspace: options['--workspace'] as string | undefined,
      resume: options['--resume'] as string | undefined,
      prompt: options['--prompt'] as string | undefined,
    };
  }
  throw new Error('Invalid local command; use serve --stdio, daemon start|status|stop, or connect');
}

/** 分流完成后才动态加载实现；原 CLI 的 help/version 不初始化守护进程。 */
export async function runLocalCommand(command: LocalCommand): Promise<void> {
  if (command.command === 'connect') {
    await (await import('./connect.js')).runConnectedClient(command);
    return;
  }
  const daemon = await import('./daemon.js');
  if (command.command === 'daemon') {
    if (command.action === 'start') console.log(JSON.stringify(await daemon.startDaemon(command)));
    else if (command.action === 'status')
      console.log(JSON.stringify(await daemon.getDaemonStatus(command)));
    else {
      await daemon.stopDaemon(command);
      console.log('Local daemon stopped');
    }
    return;
  }
  if (command.child) {
    await daemon.runDaemon(command.runtimeDir!);
    return;
  }
  const { createResourceFactory } = await import('./resources.js');
  const { LocalHostServer } = await import('./server.js');
  const { createStdioTransport } = await import('../transport/stdio.js');
  const transport = createStdioTransport(process.stdin, process.stdout);
  const host = new LocalHostServer({
    ...createResourceFactory(),
    onShutdown: () => {
      void transport.close();
    },
  });
  try {
    await host.accept(transport);
  } finally {
    await host.shutdown();
    await transport.close();
    process.stdin.pause();
  }
}
