import readline from 'node:readline';

export interface SelectOption<T = string> {
  label: string;
  value: T;
  description?: string;
  badge?: string;
}

export interface SelectConfig<T = string> {
  message: string;
  options: SelectOption<T>[];
  defaultIndex?: number;
}

/**
 * 现代终端交互式单选组件 (支持键盘 ↑/↓ 移动、数字直选、回车确认、Esc 取消)
 * 在非 TTY 或不支持 raw mode 的环境下自动平滑降级为数字编号输入
 */
export async function select<T = string>(config: SelectConfig<T>): Promise<T | null> {
  const { message, options, defaultIndex = 0 } = config;

  if (options.length === 0) {
    return null;
  }

  // 降级策略：非 TTY 环境 (如 CI、管道或受限终端)
  if (!process.stdin.isTTY) {
    return fallbackPrompt(config);
  }

  return new Promise<T | null>((resolve) => {
    let selectedIndex = Math.max(0, Math.min(defaultIndex, options.length - 1));
    let isRendered = false;

    // 暂停已有 readline 流以接管按键
    readline.emitKeypressEvents(process.stdin);
    const prevRawMode = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const render = () => {
      // 若已渲染过，先清除上一帧输出的行数
      if (isRendered) {
        // options 长度 + 标题 1 行 + 提示 1 行
        const totalLines = options.length + 2;
        process.stdout.write(`\x1b[${totalLines}A\r`);
      }

      let buffer = `\n\x1b[1m\x1b[36m? ${message}\x1b[0m \x1b[90m(按 ↑/↓ 移动，回车确认，Esc 取消)\x1b[0m\n`;

      options.forEach((opt, idx) => {
        const isCurrent = idx === selectedIndex;
        const pointer = isCurrent ? '\x1b[36m❯\x1b[0m' : ' ';
        const radio = isCurrent ? '\x1b[32m●\x1b[0m' : '\x1b[90m○\x1b[0m';
        const num = `\x1b[90m${idx + 1})\x1b[0m`;
        const labelText = isCurrent ? `\x1b[1m\x1b[32m${opt.label}\x1b[0m` : opt.label;
        const badge = opt.badge ? ` \x1b[33m[${opt.badge}]\x1b[0m` : '';
        const desc = opt.description ? ` \x1b[90m- ${opt.description}\x1b[0m` : '';

        buffer += `  ${pointer} ${radio} ${num} ${labelText}${badge}${desc}\x1b[K\n`;
      });

      process.stdout.write(buffer);
      isRendered = true;
    };

    const cleanup = () => {
      process.stdin.removeListener('keypress', onKeypress);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(prevRawMode ?? false);
      }
    };

    const onKeypress = (_str: string, key: readline.Key) => {
      if (!key) return;

      if (key.name === 'up' || key.name === 'k') {
        selectedIndex = selectedIndex > 0 ? selectedIndex - 1 : options.length - 1;
        render();
      } else if (key.name === 'down' || key.name === 'j') {
        selectedIndex = selectedIndex < options.length - 1 ? selectedIndex + 1 : 0;
        render();
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        const selected = options[selectedIndex]!;
        process.stdout.write(`\n\x1b[32m✔ 已选择: ${selected.label}\x1b[0m\n\n`);
        resolve(selected.value);
      } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cleanup();
        process.stdout.write('\n\x1b[90m(已取消选择)\x1b[0m\n\n');
        resolve(null);
      } else if (key.name && /^[1-9]$/.test(key.name)) {
        const num = Number.parseInt(key.name, 10);
        if (num >= 1 && num <= options.length) {
          selectedIndex = num - 1;
          render();
        }
      }
    };

    process.stdin.on('keypress', onKeypress);
    render();
  });
}

/**
 * 降级行式提示器
 */
async function fallbackPrompt<T>(config: SelectConfig<T>): Promise<T | null> {
  const { message, options, defaultIndex = 0 } = config;
  console.log(`\n? ${message}:`);
  options.forEach((opt, idx) => {
    const badge = opt.badge ? ` [${opt.badge}]` : '';
    const desc = opt.description ? ` (${opt.description})` : '';
    console.log(`  ${idx + 1}) ${opt.label}${badge}${desc}`);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const defaultVal = defaultIndex + 1;
  const answer = await new Promise<string>((res) => {
    rl.question(`\n请输入选项序号 [1-${options.length}] (默认 ${defaultVal}): `, (val) => {
      rl.close();
      res(val.trim());
    });
  });

  const pickedNum = Number.parseInt(answer || String(defaultVal), 10);
  if (pickedNum >= 1 && pickedNum <= options.length) {
    return options[pickedNum - 1]!.value;
  }
  return null;
}
