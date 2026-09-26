import type { AgentSession } from '@kiturone/kapibala';
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../src/commands/dispatcher.js';
import { instructionsCommand } from '../src/commands/instructions.js';

describe('/instructions', () => {
  it('shows instruction sources without revealing their contents or changing permissions', () => {
    const session = {
      getInstructionSources: () => ['C:/work/AGENTS.md'],
      getMode: vi.fn(() => 'Plan'),
      switchMode: vi.fn(),
    } as unknown as AgentSession;
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      instructionsCommand([], { session } as CommandContext);
      expect(lines.join('\n')).toContain('C:/work/AGENTS.md');
      expect(lines.join('\n')).toContain('不改变工具注册、权限模式或审批规则');
      expect(session.switchMode).not.toHaveBeenCalled();
    } finally {
      console.log = original;
    }
  });
});
