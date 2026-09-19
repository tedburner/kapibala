import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** 隐藏式读取密钥；TTY 下仅显示掩码，管道输入下使用普通行读取。 */
export async function readSecret(
  prompt: string,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<string> {
  const ttyInput = input as NodeJS.ReadStream;
  if (!ttyInput.isTTY || typeof ttyInput.setRawMode !== 'function') {
    const rl = readline.createInterface({ input, output });
    try {
      return await new Promise<string>((resolve) => rl.question(prompt, resolve));
    } finally {
      rl.close();
    }
  }

  output.write(prompt);
  readline.emitKeypressEvents(ttyInput);
  const previousRawMode = ttyInput.isRaw;
  ttyInput.setRawMode(true);
  ttyInput.resume();

  return new Promise<string>((resolve, reject) => {
    const characters: string[] = [];

    const cleanup = () => {
      ttyInput.removeListener('keypress', onKeypress);
      ttyInput.setRawMode(previousRawMode ?? false);
    };

    const onKeypress = (value: string, key: readline.Key) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        output.write('\n');
        reject(new Error('API Key 输入已取消'));
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        output.write('\n');
        resolve(characters.join(''));
        return;
      }
      if (key.name === 'backspace') {
        if (characters.length > 0) {
          characters.pop();
          output.write('\b \b');
        }
        return;
      }
      if (!key.ctrl && !key.meta && value) {
        characters.push(value);
        output.write('*');
      }
    };

    ttyInput.on('keypress', onKeypress);
  });
}
