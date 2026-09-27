import { PassThrough, Writable } from 'node:stream';
import type { AgentSession, SessionEvent } from '@kiturone/kapibala';
import { describe, expect, it, vi } from 'vitest';
import { CliInputCoordinator } from '../src/input-coordinator.js';
import { runOneShot } from '../src/oneshot.js';

function makeSession(events: SessionEvent[]): AgentSession {
  return {
    async *run() {
      for (const event of events) yield event;
    },
    destroy: vi.fn(async () => undefined),
  } as unknown as AgentSession;
}

describe('runOneShot', () => {
  it.each([false, true])(
    'aborts on terminal Ctrl+C and waits for cleanup (prior question: %s)',
    async (priorQuestion) => {
      const input = new PassThrough();
      const output = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      const coordinator = new CliInputCoordinator({
        input,
        output,
        interactive: true,
        terminal: true,
      });
      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let release!: () => void;
      const cleanup = new Promise<void>((resolve) => {
        release = resolve;
      });
      let signal: AbortSignal | undefined;
      const session = {
        async *run(_prompt: string, options: { signal: AbortSignal }) {
          signal = options.signal;
          started();
          await cleanup;
          yield { type: 'text_delta' as const, text: '' };
        },
        destroy: vi.fn(async () => undefined),
      } as unknown as AgentSession;
      let running: Promise<number> | undefined;
      try {
        if (priorQuestion) {
          const answer = coordinator.question('approval: ');
          input.write('1\n');
          await answer;
        }
        running = runOneShot({ session, prompt: 'test', inputCoordinator: coordinator });
        await ready;
        input.write('\x03');
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(signal?.aborted).toBe(true);
        expect(session.destroy).not.toHaveBeenCalled();
        release();
        expect(await running).toBe(130);
        expect(session.destroy).toHaveBeenCalledOnce();
      } finally {
        release();
        await running;
        coordinator.close();
        write.mockRestore();
      }
    },
  );

  it('returns a non-zero status when the session emits an error event', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const status = await runOneShot({
        session: makeSession([{ type: 'error', error: new Error('failed') }]),
        prompt: 'test',
      });
      expect(status).toBe(1);
    } finally {
      write.mockRestore();
    }
  });

  it('returns zero for a successful event stream', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const status = await runOneShot({ session: makeSession([]), prompt: 'test' });
      expect(status).toBe(0);
    } finally {
      write.mockRestore();
    }
  });
});
