import { describe, expect, it } from 'vitest';
import { defineTool } from '../src/capabilities/tools/index.js';
import { ToolRegistry } from '../src/capabilities/tools/registry.js';

describe('ToolRegistry source transactions and snapshots', () => {
  const makeTool = (name: string, description = 'desc') =>
    defineTool({
      name,
      description,
      parameters: { type: 'object', properties: {} },
      async execute() {
        return `executed: ${name}`;
      },
    });

  it('rejects candidate batch containing duplicate tool names within the same batch', () => {
    const registry = new ToolRegistry();
    const batch = [makeTool('tool_a'), makeTool('tool_b'), makeTool('tool_a')];

    expect(() => registry.replaceSource('mcp:test', batch)).toThrow(
      /duplicate tool name 'tool_a' within source batch/i,
    );
    expect(registry.list()).toHaveLength(0);
  });

  it('preserves existing tools when a conflict occurs on a subsequent tool in candidate batch', () => {
    const registry = new ToolRegistry({ conflictPolicy: 'error' });
    registry.register(makeTool('builtin_tool'), { source: 'builtin' });
    registry.register(makeTool('mcp_old_1'), { source: 'mcp:server_a' });

    // 候选批次中前一项没有冲突，但第二项与已有的 builtin_tool 冲突
    const candidateBatch = [makeTool('mcp_new_valid'), makeTool('builtin_tool')];

    expect(() => registry.replaceSource('mcp:server_a', candidateBatch)).toThrow(
      /Tool name conflict/i,
    );

    // 关键断言：原子性保证——原集合完全保留，候选批次中前面合法的工具绝不部分提交
    expect(registry.get('mcp_new_valid')).toBeUndefined();
    expect(registry.get('mcp_old_1')).toBeDefined();
    expect(registry.get('builtin_tool')).toBeDefined();
    expect(registry.list()).toHaveLength(2);
  });

  it('atomically replaces old source tools with new candidates on success', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('builtin_tool'), { source: 'builtin' });
    registry.replaceSource('mcp:server_a', [makeTool('alpha'), makeTool('beta')]);

    expect(registry.get('alpha')).toBeDefined();
    expect(registry.get('beta')).toBeDefined();
    expect(registry.sourceOf('alpha')).toBe('mcp:server_a');

    // 再次替换该 source 为 gamma
    registry.replaceSource('mcp:server_a', [makeTool('gamma')]);
    expect(registry.get('alpha')).toBeUndefined();
    expect(registry.get('beta')).toBeUndefined();
    expect(registry.get('gamma')).toBeDefined();
    expect(registry.get('builtin_tool')).toBeDefined();
  });

  it('unregisterSource only removes entries owned by that source', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('t1'), { source: 'source_a' });
    registry.register(makeTool('t2'), { source: 'source_b' });
    registry.register(makeTool('t3'), { source: 'source_a' });

    registry.unregisterSource('source_a');

    expect(registry.get('t1')).toBeUndefined();
    expect(registry.get('t3')).toBeUndefined();
    expect(registry.get('t2')).toBeDefined();
    expect(registry.sourceOf('t2')).toBe('source_b');
  });

  it('captures immutable snapshot that remains unaffected by subsequent registry modifications', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('t1'), { source: 'builtin' });
    registry.register(makeTool('t2'), { source: 'source_a' });

    const snap = registry.snapshot();
    expect(snap.version).toBe(registry.currentVersion);
    expect(snap.list()).toHaveLength(2);
    expect(snap.get('t1')).toBeDefined();

    // 在注册表中注销和新增工具
    registry.unregister('t1');
    registry.register(makeTool('t3'), { source: 'source_b' });

    // 关键断言：快照不受后续注册表变化影响
    expect(snap.list()).toHaveLength(2);
    expect(snap.get('t1')).toBeDefined();
    expect(snap.get('t3')).toBeUndefined();
    expect(snap.definitions()).toHaveLength(2);

    // 实时注册表已变化
    expect(registry.get('t1')).toBeUndefined();
    expect(registry.get('t3')).toBeDefined();
  });
});
