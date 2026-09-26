import { describe, expect, it, vi } from 'vitest';
import { createEventRenderer } from '../src/ui/events.js';

describe('debug output channel', () => {
  it('keeps ordinary stdout clean while sending step diagnostics to stderr', () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const renderer = createEventRenderer({
      debug: true,
      isTTY: false,
      getGitBranch: () => undefined,
      write: (chunk) => stdout.push(chunk),
      debugWrite: (chunk) => stderr.push(chunk),
    });
    renderer.render({
      type: 'step_log',
      log: {
        timestamp: Date.now(),
        turn: 1,
        stage: 'model_request_start',
        message: 'request started',
      },
    });
    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toContain('model_request_start');
  });
});
