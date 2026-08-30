import { agentIds } from '@agentbox/sandbox-core';
import { describe, expect, it } from 'vitest';
import { agentCommandEntry, agentCommandIds, agentCommands } from '../src/agents/commands.js';

/**
 * The CLI's per-agent DISPATCH table, checked against the registry.
 *
 * Distinct from `agent-module-table.test.ts`, which covers the lazy module
 * table: this is the eager table that decides what actually RUNS for an agent —
 * the command `fork` delegates to and the wrapper `attach` hands the terminal
 * to. With `AgentId` open, both used to be `switch`es the compiler proved total,
 * and widening the type turned a missing arm into a silent fallthrough (`attach`
 * exiting 0 without attaching, `fork` dereferencing undefined). Both now throw
 * by name, and these assertions are what keep the table populated.
 *
 * `fork.ts` and `attach.ts` used to be read as SOURCE TEXT here because each
 * carried its own literal map and importing them pulled all three agent commands
 * in. There is one table now and it is importable, so this asserts on the real
 * object rather than on a regex over a file.
 */
describe('per-agent dispatch table', () => {
  it('registers a command for every agent in the registry', () => {
    expect([...agentCommandIds()].sort()).toEqual([...agentIds()].sort());
  });

  it('every entry carries both a command and an attach wrapper', () => {
    for (const id of agentIds()) {
      const entry = agentCommandEntry(id);
      expect(entry, `no command entry for '${id}'`).toBeDefined();
      expect(entry!.command.name()).toBe(id);
      expect(typeof entry!.attachWrapped).toBe('function');
    }
  });

  it('agentCommands() returns one command per agent, no duplicates', () => {
    const names = agentCommands().map((c) => c.name());
    expect(names.sort()).toEqual([...agentIds()].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it('an unknown agent gets no entry rather than someone else’s', () => {
    expect(agentCommandEntry('gemini')).toBeUndefined();
  });
});
