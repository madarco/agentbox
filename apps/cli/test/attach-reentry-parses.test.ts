import { describe, expect, it } from 'vitest';
import { AGENT_SYNC_SPECS } from '@agentbox/sandbox-core';
import { agentCommandEntry } from '../src/agents/commands.js';

/**
 * Every agent `runWrappedAttach` can re-invoke must ACCEPT that invocation.
 *
 * The bug this pins: `buildAgentboxAttachArgv` emits
 * `agentbox <agent> attach <box> --attach-in same` to open a new pane for
 * `attach.openIn: split|window|tab` (the built-in default is `split`). The
 * service factory's new `attach` subcommand declared neither flag, so commander
 * rejected the re-entry and the pane died instead of showing the REPL.
 *
 * Neither live test caught it: `open --in` already passes `--inline` through the
 * GENERIC attach command, and under the PTY harness `detectHostTerminal()` is
 * `unknown`, so both paths skipped the re-entry entirely. Parsing the argv is
 * what actually checks the contract.
 */
function attachSub(id: string) {
  return agentCommandEntry(id)?.command.commands.find((c) => c.name() === 'attach');
}

describe('attach re-entry argv parses', () => {
  it('every agent with an attach subcommand accepts --attach-in', () => {
    const withAttach = AGENT_SYNC_SPECS.filter((s) => attachSub(s.id));
    expect(withAttach.length).toBeGreaterThan(0);
    for (const spec of withAttach) {
      const sub = attachSub(spec.id)!;
      const flags = sub.options.map((o) => o.long);
      expect(flags, `${spec.id} attach is missing --attach-in`).toContain('--attach-in');
      expect(flags, `${spec.id} attach is missing --inline`).toContain('--inline');
    }
  });

  it('a service agent that declares a repl has an attach subcommand', () => {
    for (const spec of AGENT_SYNC_SPECS.filter((s) => s.service?.repl?.length)) {
      expect(attachSub(spec.id), `${spec.id} declares a repl but has no attach`).toBeDefined();
    }
  });

  it('a service agent with no repl has none, so nothing re-invokes it', () => {
    for (const spec of AGENT_SYNC_SPECS.filter(
      (s) => s.caps.surface === 'service' && !s.service?.repl?.length,
    )) {
      expect(attachSub(spec.id)).toBeUndefined();
    }
  });
});
