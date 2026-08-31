import { describe, expect, it } from 'vitest';
import { agentIdsWiredIntoCli } from './_agents-in-cli.js';
import type { EffectiveConfig } from '@agentbox/config';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { resolveSessionName } from '../src/agents/command/start-attach.js';
import { loadAgentModule } from '../src/agents/index.js';
import type { AgentCliSpec } from '@agentbox/cli-kit';

/**
 * `<agent> attach` / `<agent> start` must target the CONFIGURED tmux session.
 *
 * The cloud branches used to fall back to the registry default — three copies of
 * `opts.sessionName ?? 'codex'` — while the docker branch read
 * `<agent>.sessionName`. With a custom session name, create started one session
 * and a later cloud attach silently created a second. Caught on review of the
 * command factory; the bug predates it in all three hand-written commands.
 */
describe('session name resolution', () => {
  const cfgWith = (id: string, name: string): EffectiveConfig =>
    ({ [id]: { sessionName: name } }) as unknown as EffectiveConfig;

  it('prefers --session-name over everything', async () => {
    for (const id of agentIdsWiredIntoCli()) {
      const { runtime } = await loadAgentModule(id);
      const a = { id, spec: resolveAgentSpec(id), runtime } as unknown as AgentCliSpec;
      expect(resolveSessionName(a, { sessionName: 'mine' }, cfgWith(id, 'configured'))).toBe(
        'mine',
      );
    }
  });

  it('falls back to the configured name, not the registry default', async () => {
    for (const id of agentIdsWiredIntoCli()) {
      const { runtime } = await loadAgentModule(id);
      const a = { id, spec: resolveAgentSpec(id), runtime } as unknown as AgentCliSpec;
      const configured = `${id}-custom`;
      expect(configured).not.toBe(resolveAgentSpec(id).sessionName);
      expect(resolveSessionName(a, {}, cfgWith(id, configured))).toBe(configured);
    }
  });
});
