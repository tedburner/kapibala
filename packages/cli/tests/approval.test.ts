import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import type { ApprovalRequest } from '@kiturone/kapibala';
import { describe, expect, it } from 'vitest';
import { askWithReadline } from '../src/ui/approval.js';

const request: ApprovalRequest = {
  toolName: 'run_command',
  input: { command: 'echo ok' },
  capabilities: ['exec'],
  rootDir: 'C:\\work',
  sessionAllowed: true,
  shell: {
    command: 'echo ok',
    cwd: 'C:\\work',
    interpreter: 'powershell',
    executablePath: 'C:\\Windows\\PowerShell\\powershell.exe',
  },
};

describe('CLI approval input', () => {
  it('renders control characters visibly without letting the command rewrite the approval', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let prompt = '';
    output.on('data', (chunk: Buffer) => {
      prompt += chunk.toString('utf8');
    });
    const rl = readline.createInterface({ input, output });
    const command = 'printf side_effect; #\u001b[2K\rprintf benign\n\u009b2K\u202e';
    try {
      const approval = askWithReadline(
        rl,
        { ...request, input: { command }, shell: { ...request.shell!, command } },
        undefined,
        true,
      );
      input.write('3\n');
      await expect(approval).resolves.toBe('deny_once');
      expect(prompt).toContain('printf side_effect');
      expect(prompt).toContain('printf benign');
      expect(prompt).toContain('\\u001b[2K\\r');
      for (const code of [0x1b, 0x0d, 0x9b, 0x202e]) {
        expect(prompt).not.toContain(String.fromCharCode(code));
      }
    } finally {
      rl.close();
      input.destroy();
      output.destroy();
    }
  });

  it('consumes the approval answer without forwarding it as the next chat line', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let prompt = '';
    output.on('data', (chunk: Buffer) => {
      prompt += chunk.toString('utf8');
    });
    const rl = readline.createInterface({ input, output });
    const chatLines: string[] = [];
    let approval: string | undefined;
    try {
      const consume = (async () => {
        for await (const line of rl) {
          chatLines.push(line);
          if (line === 'chat') approval = await askWithReadline(rl, request, undefined, true);
          if (line === 'next') break;
        }
      })();
      input.write('chat\n');
      await new Promise<void>((resolve) => output.once('data', () => resolve()));
      input.write('1\n');
      input.write('next\n');
      await Promise.race([
        consume,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('input stalled')), 1_000),
        ),
      ]);
      expect(approval).toBe('allow_once');
      expect(chatLines).toEqual(['chat', 'next']);
      expect(prompt).toContain('C:\\Windows\\PowerShell\\powershell.exe');
      expect(prompt).toContain('C:\\work');
      expect(prompt).toContain('echo ok');
    } finally {
      rl.close();
      input.destroy();
      output.destroy();
    }
  });

  it('cancels a pending approval on abort', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const rl = readline.createInterface({ input, output });
    const controller = new AbortController();
    try {
      const choice = askWithReadline(rl, request, controller.signal, true);
      controller.abort();
      await expect(choice).resolves.toBe('cancel');
    } finally {
      rl.close();
      input.destroy();
      output.destroy();
    }
  });

  it('denies non-interactive requests', async () => {
    const rl = readline.createInterface({ input: new PassThrough(), output: new PassThrough() });
    try {
      await expect(askWithReadline(rl, request, undefined, false)).resolves.toBe('deny_once');
    } finally {
      rl.close();
    }
  });
});
