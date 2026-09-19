import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A service agent's create must take the same route a TUI agent's does.
 *
 * It did not: `service-action.ts` called `provider.create` inline and consulted
 * none of the routing, so with a control box configured `agentbox openclaw`
 * built a local docker box while `agentbox claude` refused on the same machine —
 * and a cloud bot built from here never registered on the control plane (no
 * approvals, no `/rpc` forwarding, no relay git push, no `ctl open` mirroring).
 *
 * Source-level, because this file's create path is one long action body with no
 * seam a unit test can drive; the assertions below are exactly the calls whose
 * absence was the bug.
 */
const SRC = readFileSync(
  join(__dirname, '..', 'src', 'agents', 'command', 'service-action.ts'),
  'utf8',
);

describe('service-agent create routing', () => {
  it('honours the docker gate before it builds anything', () => {
    const refusalAt = SRC.indexOf('dockerProviderRefusal(');
    const warnAt = SRC.indexOf('localDockerUnsupportedWarning(');
    const createAt = SRC.indexOf('providerForCreate(');
    expect(refusalAt, 'the create path must consult dockerProviderRefusal').toBeGreaterThan(-1);
    expect(warnAt, 'and warn on the unsupported hub.mode=local pair').toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(-1);
    expect(refusalAt).toBeLessThan(createAt);
    expect(warnAt).toBeLessThan(createAt);
  });

  it('refuses a capped provider before it routes, not as a hub job failure', () => {
    const refusalAt = SRC.indexOf('persistentRefusal(');
    const routeAt = SRC.indexOf('resolveCreateRouting({');
    expect(refusalAt).toBeGreaterThan(-1);
    expect(routeAt).toBeGreaterThan(-1);
    expect(refusalAt).toBeLessThan(routeAt);
  });

  it('routes the create to the control box, cold (no session to start)', () => {
    expect(SRC).toContain('resolveCreateRouting({');
    expect(SRC).toContain('createCloudBoxViaHubAndAdopt({');
    // A service agent has no tmux session and no seed prompt, so the queued `-i`
    // shape must not be used here.
    expect(SRC).not.toContain('enqueueAgentJobViaHub');
    expect(SRC).not.toContain('cloudAgentAttach');
    // The adopted box is the one the rest of the command waits on — a hub create
    // whose result is discarded would build a box and then build a second one.
    expect(SRC).toContain('box = adopted;');
    // `null` back means the control box is not fully configured for this create,
    // so the local build below is the fallback, not a second box.
    expect(SRC).toContain('let adopted: BoxRecord | null = null;');
  });

  it('the hub create carries the approved carry, the name and the model auth', () => {
    const at = SRC.indexOf('createCloudBoxViaHubAndAdopt({');
    const call = SRC.slice(at, at + 1200);
    expect(call).toContain('agent: spec.id');
    expect(call).toContain('carry,');
    expect(call).toContain('name: opts.name');
    expect(call).toContain('persistent');
    expect(call).toContain('borrowCredentials');
  });

  it('the local create request carries the control-plane and git-push fields', () => {
    const at = SRC.indexOf('await provider.create({');
    expect(at).toBeGreaterThan(-1);
    const call = SRC.slice(at, SRC.indexOf('});', at));
    // Without these a cloud bot built here is laptop-tethered.
    expect(call).toContain('controlPlaneUrl: cfg.relay.controlPlaneUrl');
    expect(call).toContain('gitPushMode: cfg.git.pushMode');
    expect(call).toContain('hubGitAuth: cfg.hub.gitAuth');
    // Sizing AND the per-provider session lifetime, which for a daemon is the
    // difference between a bot and an outage.
    expect(call).toContain('providerOptions: sizing');
    // Unrelated to the hub, fixed in passing: the TUI path folds `browser.default`
    // into the playwright decision and this one read the bare key.
    expect(call).toContain("cfg.box.withPlaywright || cfg.browser.default !== 'agent-browser'");
  });
});
