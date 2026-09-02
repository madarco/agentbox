import { describe, expect, it } from 'vitest';
import { AGENT_SYNC_SPECS } from '@agentbox/sandbox-core';
import { resolveSessionArgs } from '../src/commands/fork.js';
import { prepareTeleport } from '../src/session-teleport/index.js';
import { TeleportError } from '@agentbox/cli-kit';

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
        resolveSessionArgs(spec.id, {
          session: 'abc',
          workspace: '/tmp',
        }),
      ).toThrow(/resume is not supported/i);
      // …and starts fresh when no session was asked for.
      expect(resolveSessionArgs(spec.id, { workspace: '/tmp' })).toEqual([]);
    }
  });

  it('passes --resume through for every agent that declares resume: true', () => {
    for (const spec of resumable) {
      expect(
        resolveSessionArgs(spec.id, {
          session: 'abc',
          workspace: '/tmp',
        }),
      ).toEqual(['--resume', 'abc']);
    }
  });

  /**
   * `caps.surface` is the second capability with real consumers, and its rules
   * are structural rather than behavioural: what a service agent MUST declare,
   * and what a TUI agent must not.
   *
   * Driven off the registry, so the day a service agent lands these hold for it
   * without a line changing here — the same arrangement `resume` uses above.
   */
  it('a service agent declares the units that run it; a TUI agent declares none', () => {
    for (const spec of AGENT_SYNC_SPECS) {
      if (spec.caps.surface === 'service') {
        expect(spec.service, `service agent '${spec.id}' declares no service block`).toBeDefined();
        // A daemon has no session to attach to, resume, or teleport into.
        expect(spec.caps.resume, `service agent '${spec.id}' cannot resume`).toBe(false);
        expect(spec.caps.teleport, `service agent '${spec.id}' cannot teleport`).toBe('stub');
        continue;
      }
      expect(
        spec.service,
        `TUI agent '${spec.id}' must not declare a service block`,
      ).toBeUndefined();
    }
  });

  it('a configRender declares the command that performs the merge', () => {
    // The merge is the tool's job (Phase 3): a spec that names a file to render
    // but no command to render it through has no way to apply anything.
    for (const spec of AGENT_SYNC_SPECS.filter((s) => s.configRender)) {
      const render = spec.configRender!;
      expect(render.applyCmd.length, `${spec.id}: configRender.applyCmd is empty`).toBeGreaterThan(
        0,
      );
      expect(
        render.overlayKey.length,
        `${spec.id}: configRender.overlayKey is empty`,
      ).toBeGreaterThan(0);
      expect(render.file.startsWith('/'), `${spec.id}: configRender.file must be absolute`).toBe(
        true,
      );
    }
  });

  it('prepareTeleport throws for every agent that declares teleport: stub', async () => {
    for (const spec of AGENT_SYNC_SPECS.filter((s) => s.caps.teleport === 'stub')) {
      await expect(
        prepareTeleport({
          agent: spec.id,
          hostCwd: '/tmp',
          mode: { kind: 'continue' },
        }),
      ).rejects.toBeInstanceOf(TeleportError);
    }
  });
});
