import { describe, expect, it } from 'vitest';
import { AGENT_SYNC_SPECS } from '@agentbox/sandbox-core';
import { resolveSessionArgs } from '../src/commands/fork.js';
import { prepareTeleport } from '../src/session-teleport/index.js';
import { TeleportError } from '../src/session-teleport/types.js';

/**
 * `caps` is the registry's declaration of what an agent can do. It shipped with
 * ZERO consumers: `fork` tested `agent === 'opencode'` for resume and
 * `prepareTeleport` had a per-agent `case` for the stub. An agent added to the
 * registry could declare `resume: false` and still be offered `--session`.
 *
 * These drive off the registry rather than naming opencode, so they keep holding
 * for whichever agent declares the capability next.
 */
describe('caps gate behaviour, not the agent name', () => {
  const resumable = AGENT_SYNC_SPECS.filter((s) => s.caps.resume);
  const notResumable = AGENT_SYNC_SPECS.filter((s) => !s.caps.resume);

  it('the registry actually exercises both sides', () => {
    // Guards against this whole file silently passing because every agent
    // happens to share one capability.
    expect(resumable.length).toBeGreaterThan(0);
    expect(notResumable.length).toBeGreaterThan(0);
  });

  it('refuses --session for every agent that declares resume: false', () => {
    for (const spec of notResumable) {
      expect(() =>
        resolveSessionArgs(spec.id as 'claude' | 'codex' | 'opencode', {
          session: 'abc',
          workspace: '/tmp',
        }),
      ).toThrow(/resume is not supported/i);
      // …and starts fresh when no session was asked for.
      expect(
        resolveSessionArgs(spec.id as 'claude' | 'codex' | 'opencode', { workspace: '/tmp' }),
      ).toEqual([]);
    }
  });

  it('passes --resume through for every agent that declares resume: true', () => {
    for (const spec of resumable) {
      expect(
        resolveSessionArgs(spec.id as 'claude' | 'codex' | 'opencode', {
          session: 'abc',
          workspace: '/tmp',
        }),
      ).toEqual(['--resume', 'abc']);
    }
  });

  it('prepareTeleport throws for every agent that declares teleport: stub', async () => {
    for (const spec of AGENT_SYNC_SPECS.filter((s) => s.caps.teleport === 'stub')) {
      await expect(
        prepareTeleport({
          agent: spec.id as 'claude' | 'codex' | 'opencode',
          hostCwd: '/tmp',
          mode: { kind: 'continue' },
        }),
      ).rejects.toBeInstanceOf(TeleportError);
    }
  });
});
