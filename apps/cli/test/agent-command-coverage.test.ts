import { AGENT_SYNC_SPECS } from '@agentbox/sandbox-core';
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
    expect([...agentCommandIds()].sort()).toEqual([...AGENT_SYNC_SPECS.map((s) => s.id)].sort());
  });

  it('every TUI agent carries both a command and an attach wrapper', () => {
    const tui = AGENT_SYNC_SPECS.filter((s) => s.caps.surface !== 'service');
    expect(tui.length, 'the registry has no TUI agent left to check').toBeGreaterThan(0);
    for (const spec of tui) {
      const entry = agentCommandEntry(spec.id);
      expect(entry, `no command entry for '${spec.id}'`).toBeDefined();
      expect(entry!.command.name()).toBe(spec.id);
      expect(typeof entry!.attachWrapped).toBe('function');
    }
  });

  /**
   * The other half of the split, and the reason `attachWrapped` is optional.
   *
   * A `surface: 'service'` agent is a daemon the box's supervisor runs: there is
   * no tmux session, so an attach wrapper for it could only ever be a stub that
   * throws. It gets its command from the shared service factory instead, and
   * `attach` refuses it by name (`commands/attach.ts`). Asserting the ABSENCE
   * here is what keeps someone from "fixing" the missing wrapper with a stub.
   */
  it('every service agent carries a command and NO attach wrapper', () => {
    for (const spec of AGENT_SYNC_SPECS.filter((s) => s.caps.surface === 'service')) {
      const entry = agentCommandEntry(spec.id);
      expect(entry, `no command entry for '${spec.id}'`).toBeDefined();
      expect(entry!.command.name()).toBe(spec.id);
      expect(entry!.attachWrapped).toBeUndefined();
    }
  });

  it('agentCommands() returns one command per agent, no duplicates', () => {
    const names = agentCommands().map((c) => c.name());
    expect(names.sort()).toEqual([...AGENT_SYNC_SPECS.map((s) => s.id)].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it('an unknown agent gets no entry rather than someone else’s', () => {
    expect(agentCommandEntry('gemini')).toBeUndefined();
  });
});
