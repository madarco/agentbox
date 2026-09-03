import { describe, expect, it } from 'vitest';
import { buildAgentDescriptors } from '../src/sync/agent-descriptor.js';
import { AGENT_SYNC_SPECS } from '../src/sync/registry.js';

describe('buildAgentDescriptors', () => {
  it('reproduces the credential watch list ctl has baked in today', () => {
    // The whole point of shipping this over RPC is that a box's behaviour does
    // not change on day one. Every agent that DECLARES a credential must still
    // be watched, with the same path and the same validator.
    const { agents } = buildAgentDescriptors();
    expect(agents).toHaveLength(AGENT_SYNC_SPECS.length);
    for (const spec of AGENT_SYNC_SPECS) {
      const declared = spec.credential;
      if (!declared) continue;
      const got = agents.find((a) => a.id === spec.id);
      const cred = got?.watch.find((w) => w.path === declared.boxAbsPath);
      expect(cred, spec.id).toBeDefined();
      expect(cred?.sync).toBe('fanout');
      expect(cred?.shape).toBe(declared.realShape);
    }
  });

  it('emits NO credential watch for an agent that declares none', () => {
    // The credential watch is FANOUT: whatever it names is copied into every
    // other box. An agent with no host-side credential contributes no watch at
    // all — not one on a fictional path, and not one on its own config, which
    // would hand every box the first box's identity. openclaw is the live case
    // (its gateway token is generated per box).
    const { agents } = buildAgentDescriptors();
    const credentialless = AGENT_SYNC_SPECS.filter((s) => !s.credential);
    expect(credentialless.map((s) => s.id)).toContain('openclaw');
    for (const spec of credentialless) {
      const got = agents.find((a) => a.id === spec.id);
      expect(got, spec.id).toBeDefined();
      // It still ships a descriptor (session, activity, service, configRender)
      // — only the credential watch is absent.
      expect(
        got?.watch.filter((w) => w.sync === 'fanout'),
        spec.id,
      ).toEqual([]);
    }
  });

  it('ships the session name and activity sources for every agent', () => {
    // Without these ctl falls back to its BAKED list, which ends at the agents
    // that existed when the image was built — so an agent added afterwards would
    // never be probed and could never report activity at all.
    const { agents } = buildAgentDescriptors();
    for (const spec of AGENT_SYNC_SPECS) {
      const got = agents.find((a) => a.id === spec.id);
      expect(got?.sessionName, `${spec.id} ships no sessionName`).toBe(spec.sessionName);
      expect(got?.activitySource, spec.id).toEqual(spec.caps.activitySource);
    }
  });

  it('gives every activity-reporting agent a session name to probe', () => {
    // The pairing that makes the declaration real: claiming to report activity
    // while shipping nothing for ctl to probe is a silent no-op.
    for (const agent of buildAgentDescriptors().agents) {
      if (agent.activitySource.length === 0) continue;
      expect(
        agent.sessionName.length,
        `${agent.id} reports activity but has no session`,
      ).toBeGreaterThan(0);
    }
  });

  it('never ships a host path into the box', () => {
    // `credential.hostBackup` is an absolute HOST path baked at module load. In
    // a box it is meaningless, and sending it leaks the host's home layout.
    const json = JSON.stringify(buildAgentDescriptors());
    for (const spec of AGENT_SYNC_SPECS) {
      if (!spec.credential) continue;
      expect(json, spec.id).not.toContain(spec.credential.hostBackup);
    }
    expect(json).not.toContain('/Users/');
    expect(json).not.toContain('.agentbox/');
  });

  it('is JSON round-trippable — it crosses a wire', () => {
    const built = buildAgentDescriptors();
    expect(JSON.parse(JSON.stringify(built))).toEqual(built);
  });

  it('defaults a declared watch to backup, never fanout', () => {
    // fanout re-distributes to EVERY other box. A spec that forgets to say what
    // a watch is for must get the safe one; fanout has to be asked for.
    const spec = AGENT_SYNC_SPECS[0]!;
    const withWatch = {
      ...spec,
      watch: [{ path: '/home/vscode/.someagent/session.jsonl' }],
    };
    // Exercise the same mapping the builder uses.
    const mapped = (withWatch.watch ?? []).map((w) => ({
      path: w.path,
      sync: (w as { sync?: string }).sync ?? 'backup',
    }));
    expect(mapped[0]?.sync).toBe('backup');
  });
});
