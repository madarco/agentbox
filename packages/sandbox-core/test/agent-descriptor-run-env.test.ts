import { describe, expect, it } from 'vitest';
import { buildAgentDescriptors, serviceWithRunEnv } from '../src/sync/agent-descriptor.js';
import { AGENT_SYNC_SPECS } from '../src/sync/registry.js';

const payload = buildAgentDescriptors();
const openclaw = payload.agents.find((a) => a.id === 'openclaw')!;
const spec = AGENT_SYNC_SPECS.find((s) => s.id === 'openclaw')!;

/**
 * `boxRunEnv` reaches a box's processes differently on every provider, and on
 * the two VPS ones it did not arrive at all: they carry it through
 * `/etc/agentbox/box.env`, which both filter to `AGENTBOX_*` because that file
 * is world-readable. openclaw's `OPENCLAW_WORKSPACE_DIR` was dropped there, so
 * onboard ran against `~/.openclaw/workspace` instead of `/workspace` — and
 * nothing failed loudly, because the gateway still bound its port and passed
 * its health check.
 */
describe('the units an agent contributes', () => {
  it("carries the agent's declared run-env, so no provider has to", () => {
    expect(spec.boxRunEnv.OPENCLAW_WORKSPACE_DIR).toBe('/workspace');
    expect(openclaw.service?.env?.OPENCLAW_WORKSPACE_DIR).toBe('/workspace');
  });

  it('puts it on every task, not just the service', () => {
    // `openclaw onboard` is a TASK, and it is the one that reads this variable
    // and writes it into `agents.defaults.workspace`. A service-only fix would
    // have left the actual bug in place.
    const tasks = openclaw.service?.tasks ?? [];
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) expect(t.env?.OPENCLAW_WORKSPACE_DIR).toBe('/workspace');
    expect(tasks.map((t) => t.name)).toContain('openclaw-onboard');
  });

  it("lets a unit's own env win over the agent-wide default", () => {
    // `boxRunEnv` is the agent-wide DEFAULT; a unit that sets the same key
    // meant to, so the merge order matters and is easy to write backwards.
    const merged = serviceWithRunEnv(
      {
        name: 's',
        command: 'run',
        env: { SHARED: 'service', OWN: 'service' },
        tasks: [
          { name: 't1', command: 'a', env: { SHARED: 'task' } },
          { name: 't2', command: 'b' },
        ],
      },
      { SHARED: 'run-env', FROM_RUN_ENV: 'yes' },
    );
    expect(merged.env).toEqual({ SHARED: 'service', OWN: 'service', FROM_RUN_ENV: 'yes' });
    expect(merged.tasks?.[0]?.env).toEqual({ SHARED: 'task', FROM_RUN_ENV: 'yes' });
    expect(merged.tasks?.[1]?.env).toEqual({ SHARED: 'run-env', FROM_RUN_ENV: 'yes' });
  });

  it('leaves an agent that declares no run-env untouched', () => {
    // Every field must survive the merge; the spread is easy to get wrong.
    for (const s of AGENT_SYNC_SPECS) {
      if (!s.service || Object.keys(s.boxRunEnv).length > 0) continue;
      const wire = payload.agents.find((a) => a.id === s.id)!;
      expect(wire.service).toEqual(s.service);
    }
  });

  it('preserves the rest of the service definition', () => {
    // The merge rebuilds the object, so a dropped field would silently cost a
    // service its readiness probe or its exposed port.
    expect(openclaw.service?.command).toBe(spec.service?.command);
    expect(openclaw.service?.readyWhen).toEqual(spec.service?.readyWhen);
    expect(openclaw.service?.expose).toEqual(spec.service?.expose);
    expect(openclaw.service?.tasks?.map((t) => t.needs)).toEqual(
      spec.service?.tasks?.map((t) => t.needs),
    );
  });
});
