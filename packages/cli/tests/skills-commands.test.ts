import type { AgentSession } from '@kiturone/kapibala';
import { describe, expect, it, vi } from 'vitest';
import { COMMAND_CATALOG } from '../src/commands/catalog.js';
import { type CommandContext, CommandDispatcher } from '../src/commands/dispatcher.js';
import { skillCommand, skillsCommand } from '../src/commands/skills.js';

function harness(busy = false) {
  const runSkill = vi.fn(async () => {});
  const getSkills = vi.fn(() => ({
    skills: [],
    diagnostics: [],
    activations: [],
    catalog: { included: [], omitted: 0 },
  }));
  const context: CommandContext = {
    session: { isBusy: () => busy, getSkills } as unknown as AgentSession,
    settings: { defaultModel: 'x', profiles: [] },
    onModelSwitched: () => {},
    onExit: () => {},
    runSkill,
  };
  const dispatcher = new CommandDispatcher();
  for (const name of ['skills', 'skill'])
    dispatcher.registerDefinition(
      COMMAND_CATALOG.find((d) => d.name === name)!,
      name === 'skills' ? skillsCommand : skillCommand,
    );
  return { context, dispatcher, runSkill, getSkills };
}
describe('skills commands', () => {
  it('preserves quoted task text, inner spaces and newlines through the host callback', async () => {
    const { dispatcher, context, runSkill } = harness();
    await dispatcher.dispatch('/skill write-guide 请保留 "a  b"\n第二行   ', context);
    expect(runSkill).toHaveBeenCalledWith('write-guide', '请保留 "a  b"\n第二行   ');
  });
  it('rejects missing tasks, invalid names and busy mutation without starting a run', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const h = harness();
      for (const input of ['/skill write-guide', '/skill ../outside task', '/skill write-guide   '])
        await h.dispatcher.dispatch(input, h.context);
      expect(h.runSkill).not.toHaveBeenCalled();
      const busy = harness(true);
      await busy.dispatcher.dispatch('/skill guide task', busy.context);
      expect(busy.runSkill).not.toHaveBeenCalled();
      await busy.dispatcher.dispatch('/skills 中文 query', busy.context);
      expect(busy.getSkills).toHaveBeenCalledWith('中文 query');
    } finally {
      log.mockRestore();
    }
  });
});
