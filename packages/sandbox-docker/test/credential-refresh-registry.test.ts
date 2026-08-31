import { describe, expect, it, beforeEach } from 'vitest';
import { dockerCredentialRefresh } from '../src/credential-refresh.js';
import {
  registerAgentSyncModule,
  registeredAgentSyncModules,
  type AgentSyncModule,
} from '../src/sync/agents/module.js';

/**
 * `dockerCredentialRefresh` used to name three agents in sequence: a claude sync
 * gated on claude's token expiry, then a codex extract, then an opencode
 * extract. A fourth agent got no host-backup refresh at all — silently, since
 * every step is best-effort — so its cloud boxes were seeded from a stale token.
 *
 * It walks the module registry now. These tests are about THAT property: every
 * registered agent is offered the step, and one agent's failure cannot swallow
 * another's.
 */
function stub(id: string, calls: string[], opts: { throws?: boolean } = {}): AgentSyncModule {
  return {
    id,
    resolveVolume: () => ({ volume: `v-${id}`, isolated: false }),
    buildMounts: () => ({ args: [], env: {} }),
    ensureVolume: async () => ({ created: false, synced: false }),
    sessionInfo: async () => ({ running: false, sessionName: id, startedAt: null, title: null }),
    refreshHostBackup: async () => {
      calls.push(id);
      if (opts.throws) throw new Error(`${id} exploded`);
    },
  } as unknown as AgentSyncModule;
}

describe('dockerCredentialRefresh walks the agent registry', () => {
  let calls: string[];
  beforeEach(() => {
    calls = [];
  });

  it('offers the step to a newly registered agent, with no edit here', async () => {
    // The whole point: a fourth agent is refreshed because it registered, not
    // because this function learned its name.
    registerAgentSyncModule(stub('zz-fourth-agent', calls));
    await dockerCredentialRefresh({});
    expect(calls).toContain('zz-fourth-agent');
  });

  it('keeps going when one agent throws', async () => {
    registerAgentSyncModule(stub('zz-boom', calls, { throws: true }));
    registerAgentSyncModule(stub('zz-after', calls));
    await expect(dockerCredentialRefresh({})).resolves.toBeUndefined();
    expect(calls).toContain('zz-boom');
    expect(calls).toContain('zz-after');
  });

  it('skips an agent that declares no refresh step', async () => {
    const bare = { ...stub('zz-bare', calls) };
    delete (bare as { refreshHostBackup?: unknown }).refreshHostBackup;
    registerAgentSyncModule(bare as AgentSyncModule);
    await expect(dockerCredentialRefresh({})).resolves.toBeUndefined();
    expect(calls).not.toContain('zz-bare');
    expect(registeredAgentSyncModules().some((m) => m.id === 'zz-bare')).toBe(true);
  });
});
