import { describe, expect, it } from 'vitest';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { prepareTeleport } from '../src/session-teleport/index.js';
import { TeleportError } from '../src/session-teleport/types.js';

/**
 * OpenCode teleport is a v1 stub, and the refusal now comes from the registry
 * (`caps.teleport: 'stub'` + `caps.teleportStubReason`) rather than a per-agent
 * module. Same user-visible message; one fewer place a new agent has to touch.
 */
describe('opencode teleport refusal', () => {
  it('rejects with TeleportError and explains why', async () => {
    await expect(
      prepareTeleport({ agent: 'opencode', hostCwd: '/tmp', mode: { kind: 'continue' } }),
    ).rejects.toThrow(TeleportError);
    await expect(
      prepareTeleport({ agent: 'opencode', hostCwd: '/tmp', mode: { kind: 'continue' } }),
    ).rejects.toThrow(/opencode\.db/);
  });

  it('prints the reason the registry declares, verbatim', () => {
    // The message is data now, so this is the guard that it stays a real
    // explanation rather than decaying to the generic fallback.
    const caps = resolveAgentSpec('opencode').caps;
    expect(caps.teleport).toBe('stub');
    expect(caps.teleportStubReason).toContain('opencode.db');
  });
});
