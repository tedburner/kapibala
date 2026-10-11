import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CliInputCoordinator } from '../src/input-coordinator.js';
import { createEventRenderer } from '../src/ui/events.js';

describe('current run output folding', () => {
  it('keeps actual Ctrl+O bytes out of modal answers in terminal readline', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const coordinator = new CliInputCoordinator({
      input,
      output,
      interactive: true,
      terminal: true,
    });
    let toggles = 0;
    coordinator.onDetailToggle(() => toggles++);
    const answer = coordinator.question('choice: ');
    input.write('\x0f1\n');
    expect(await answer).toBe('1');
    expect(toggles).toBe(0);
    coordinator.close();
  });
  it('keeps every assistant text delta visible but folds thoughts and expands cached detail', () => {
    let output = '';
    const renderer = createEventRenderer({
      isTTY: true,
      write: (text) => {
        output += text;
      },
      cacheBytes: 128,
    });
    renderer.render({ type: 'thinking_delta', thinking: 'private process shown on demand' });
    renderer.render({ type: 'text_delta', text: 'intermediate answer' });
    expect(output).not.toContain('private process');
    expect(output).toContain('intermediate answer');
    renderer.toggleDetail();
    expect(output).toContain('本轮过程详情快照');
    expect(output).toContain('private process shown on demand');
    renderer.finish();
    const finished = output;
    renderer.finish();
    renderer.toggleDetail();
    expect(output).toBe(finished);
  });
  it('caps the UI cache with UTF8-safe clipping and never caps nonTTY detailed streaming', () => {
    let output = '';
    const renderer = createEventRenderer({
      isTTY: true,
      cacheBytes: 32,
      write: (s) => {
        output += s;
      },
    });
    renderer.render({ type: 'thinking_delta', thinking: '中文🙂'.repeat(1000) });
    renderer.toggleDetail();
    expect(output).toContain('缓存已截断');
    expect(output).not.toContain('�');
    let detailed = '';
    const full = createEventRenderer({
      isTTY: false,
      outputDetail: 'detailed',
      cacheBytes: 32,
      write: (s) => {
        detailed += s;
      },
    });
    const body = '中文🙂'.repeat(150000);
    full.render({ type: 'thinking_delta', thinking: body });
    full.render({
      type: 'tool_start',
      id: 'x',
      name: 'plugin',
      input: { text: body, apiKey: 'sensitive-value' },
    });
    full.render({ type: 'tool_finish', id: 'x', name: 'plugin', result: body, isError: false });
    full.finish();
    expect(detailed.split(body).length).toBe(4);
    expect(detailed).not.toContain('sensitive-value');
    expect(detailed).not.toContain('缓存已截断');
    expect(detailed).not.toContain('\x1b');
  });
  it('invalidates terminal anchors across host output and resize without erasing scrollback', () => {
    let output = '';
    let columns = 100;
    const renderer = createEventRenderer({
      isTTY: true,
      columns: () => columns,
      write: (s) => {
        output += s;
      },
    });
    renderer.render({ type: 'tool_start', id: 'x', name: 'read_file', input: { path: 'x' } });
    renderer.invalidateAnchor();
    columns = 40;
    renderer.render({
      type: 'tool_finish',
      id: 'x',
      name: 'read_file',
      result: 'content',
      isError: false,
    });
    renderer.toggleDetail();
    expect(output).not.toMatch(new RegExp(`${String.fromCharCode(27)}\\[\\d+A`));
    expect(output).not.toContain('\x1b[2J');
    expect(output).toContain('content');
  });
  it('owns Ctrl+O once and disables it for secret/menu/approval questions and after cleanup', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const coordinator = new CliInputCoordinator({
      input,
      output,
      interactive: true,
      terminal: false,
    });
    let toggles = 0;
    const unbind = coordinator.onDetailToggle(() => toggles++);
    input.emit('keypress', '\x0f', { name: 'o', ctrl: true });
    expect(toggles).toBe(1);
    const secret = coordinator.readSecret('secret: ');
    input.emit('keypress', '\x0f', { name: 'o', ctrl: true });
    input.write('hidden-value\n');
    expect(await secret).toBe('hidden-value');
    expect(toggles).toBe(1);
    unbind();
    unbind();
    input.emit('keypress', '\x0f', { name: 'o', ctrl: true });
    expect(toggles).toBe(1);
    coordinator.close();
    expect(input.listenerCount('keypress')).toBe(0);
  });
});
