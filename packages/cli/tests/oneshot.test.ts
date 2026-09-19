import type { AgentSession, SessionEvent } from '@kiturone/kapibala';
import { describe, expect, it, vi } from 'vitest';
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
