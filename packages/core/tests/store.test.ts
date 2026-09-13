import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JSONLMessageStore } from '../src/store/jsonl.js';
import type { CanonicalMessage } from '../src/types/index.js';

describe('JSONLMessageStore', () => {
  let tempDir: string;
  let storeFile: string;
  let store: JSONLMessageStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-store-test-'));
    storeFile = path.join(tempDir, 'messages.jsonl');
    store = new JSONLMessageStore(storeFile);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should append and load messages correctly', async () => {
    const msg1: CanonicalMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'Hello' }],
      timestamp: 1000,
    };
    const msg2: CanonicalMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi there!' }],
      timestamp: 2000,
    };

    await store.append(msg1);
    await store.append(msg2);

    const loaded = await store.load();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].role).toBe('user');
    expect(loaded[0].content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(loaded[1].role).toBe('assistant');
  });

  it('should ignore corrupted lines and recover cleanly', async () => {
    const validLine = JSON.stringify({
      ts: 1000,
      role: 'user',
      content: [{ type: 'text', text: 'Valid' }],
    });
    const brokenLine = '{"ts": 2000, "role": "assistant", "content": [{"type": "tex'; // broken json
    fs.writeFileSync(storeFile, `${validLine}\n${brokenLine}\n`, 'utf-8');

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].role).toBe('user');
  });

  it('should auto-heal dangling tool_use at the end of session', async () => {
    const userMsg: CanonicalMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'Check file' }],
      timestamp: 1000,
    };
    const assistantCallingTool: CanonicalMessage = {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call_abc',
          name: 'read_file',
          input: { path: 'a.txt' },
        },
      ],
      timestamp: 2000,
    };

    await store.append(userMsg);
    await store.append(assistantCallingTool);

    // Session crashed before tool returned
    const loaded = await store.load();
    expect(loaded).toHaveLength(3);
    const lastMsg = loaded[2];
    expect(lastMsg.role).toBe('tool');
    expect(lastMsg.content[0]).toEqual({
      type: 'tool_result',
      toolUseId: 'call_abc',
      content: 'Tool execution was interrupted or crashed in previous session',
      isError: true,
    });
  });

  it('should clear store file', async () => {
    await store.append({
      role: 'user',
      content: [{ type: 'text', text: 'Test' }],
    });
    expect(fs.existsSync(storeFile)).toBe(true);

    await store.clear();
    expect(fs.existsSync(storeFile)).toBe(false);
  });
});
