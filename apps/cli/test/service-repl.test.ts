import { describe, expect, it } from 'vitest';
import { AGENT_SYNC_SPECS } from '@agentbox/sandbox-core';
import { isServiceAgent } from '@agentbox/core';
import { serviceReplArgv } from '../src/agents/service-repl.js';

/**
 * Which agents have a client to attach to.
 *
 * `agentbox open --in iterm2` on a service box used to land in a bare shell
 * AFTER an error: `open` shells `agentbox attach`, which refused a service
 * agent outright, and `keepShell: true` left the pane alive. A daemon that
 * ships a terminal client has something better to open, and the command is
 * registry data so the attach path implements it once for every service agent.
 */
describe('serviceReplArgv', () => {
  it('answers with the argv for a service agent that declares one', () => {
    const declaring = AGENT_SYNC_SPECS.filter((s) => s.service?.repl?.length);
    expect(declaring.length, 'no service agent declares a repl').toBeGreaterThan(0);
    for (const spec of declaring) {
      expect(serviceReplArgv(spec)).toEqual(spec.service!.repl);
    }
  });

  it('answers undefined for a TUI agent, whatever else it declares', () => {
    // A TUI agent has a real attachWrapped; routing it here would attach to the
    // wrong thing.
    for (const spec of AGENT_SYNC_SPECS.filter((s) => !isServiceAgent(s))) {
      expect(serviceReplArgv(spec)).toBeUndefined();
    }
  });

  it('answers undefined for an unknown agent rather than throwing', () => {
    expect(serviceReplArgv(undefined)).toBeUndefined();
  });

  it('is argv, not a shell line', () => {
    // The distinction is load-bearing: it is passed to tmux/`buildAttach` as
    // separate words, so a single "openclaw tui" string would be run as a
    // binary literally named `openclaw tui`.
    for (const spec of AGENT_SYNC_SPECS.filter((s) => s.service?.repl?.length)) {
      const argv = serviceReplArgv(spec)!;
      expect(Array.isArray(argv)).toBe(true);
      expect(argv[0]).not.toContain(' ');
    }
  });

  it('names a binary the agent actually installs', () => {
    // The client has to exist in the box. Catches a repl pointing at a tool the
    // install recipe never puts there.
    for (const spec of AGENT_SYNC_SPECS.filter((s) => s.service?.repl?.length)) {
      expect(serviceReplArgv(spec)![0]).toBe(spec.binary);
    }
  });
});
