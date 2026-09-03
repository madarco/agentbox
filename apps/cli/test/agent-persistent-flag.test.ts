import { describe, expect, it } from 'vitest';
import { resolveCreatePersistent } from '@agentbox/core';
import { agentCommandEntry, agentCommandIds } from '../src/agents/commands.js';

/**
 * `--persistent` on every agent command.
 *
 * The flag pair is declared ONCE, in the shared table
 * (`agents/command/options.ts`), so this asserts what that buys: no agent can
 * be missing it, and no agent can grow a different default for it. An always-on
 * `claude` or `codex` box is a legitimate ask — the flag reaching only
 * `agentbox create` was a scoping artifact, and `agentbox config set
 * box.persistent true` is not a discoverable substitute.
 */
describe('--persistent on the agent commands', () => {
  const ids = [...agentCommandIds()];

  it('offers --persistent AND --no-persistent on every agent, defaulting to neither', () => {
    for (const id of ids) {
      const command = agentCommandEntry(id)!.command;
      const flags = command.options.map((o) => o.long);
      expect(flags, `${id} is missing --persistent`).toContain('--persistent');
      // Both halves must exist: commander defaults a lone `--no-x` to true,
      // which would make "the user did not choose" indistinguishable from
      // "--persistent" and silently override `box.persistent`.
      expect(flags, `${id} is missing --no-persistent`).toContain('--no-persistent');
      expect(command.opts().persistent, `${id} defaults --persistent`).toBeUndefined();
    }
  });

  it('leaves a TUI agent expendable unless the flag says otherwise', () => {
    // The create path resolves through the same helper the service surface
    // uses, so the default is derived from `caps.surface` rather than from the
    // agent id — and a coding box (surface 'tui') keeps no opinion, which is
    // what lets `box.persistent` still decide.
    const tui = {
      caps: { surface: 'tui', resume: true, teleport: 'full', activitySource: [] },
    } as const;
    expect(resolveCreatePersistent({ spec: tui })).toBeUndefined();
    expect(resolveCreatePersistent({ spec: tui, flag: true })).toBe(true);
    expect(resolveCreatePersistent({ spec: tui, flag: false })).toBe(false);
  });
});
