import { describe, expect, it } from 'vitest';
import { PORTABLE_CREATE_OPT_KEYS, type PortableCreateOptKey } from '@agentbox/relay/control-plane';
import {
  controlPlaneCreateRequest,
  type ControlPlaneCreateInput,
} from '../lib/boxes/control-plane-create';

const REPO = 'https://github.com/acme/widgets.git';

describe('controlPlaneCreateRequest', () => {
  it('defaults to claude and asks the worker to start it', () => {
    const m = controlPlaneCreateRequest({ provider: 'e2b' }, REPO);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.request).toEqual({
      repoUrl: REPO,
      provider: 'e2b',
      agent: 'claude',
      startAgent: true,
    });
  });

  it('carries name, base branch and seed prompt', () => {
    const m = controlPlaneCreateRequest(
      {
        provider: 'hetzner',
        agent: 'codex',
        name: ' fix-login ',
        fromBranch: ' main ',
        prompt: 'go',
      },
      REPO,
    );
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.request).toEqual({
      repoUrl: REPO,
      provider: 'hetzner',
      branch: 'main',
      name: 'fix-login',
      agent: 'codex',
      prompt: 'go',
      startAgent: true,
    });
  });

  it('a no-agent box neither names an agent nor starts one', () => {
    const m = controlPlaneCreateRequest(
      { provider: 'e2b', agent: 'none', prompt: 'ignored' },
      REPO,
    );
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.request).toEqual({ repoUrl: REPO, provider: 'e2b' });
  });

  it('rejects bare docker — it needs the host folder a control box does not have', () => {
    const m = controlPlaneCreateRequest({ provider: 'docker' }, REPO);
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.error).toMatch(/local checkout/);
  });

  // `docker:<alias>` is remote-docker: it bind-mounts nothing and seeds the box
  // from a bundle over SSH, exactly like a cloud provider, so the clone path is
  // how a control box SHOULD build it.
  it('accepts a docker:<alias> engine spec and passes it through verbatim', () => {
    const m = controlPlaneCreateRequest({ provider: 'docker:workshop', agent: 'none' }, REPO);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.request).toEqual({ repoUrl: REPO, provider: 'docker:workshop' });
  });

  it('drops a whitespace-only name, branch and prompt rather than sending them', () => {
    const m = controlPlaneCreateRequest(
      { provider: 'e2b', name: '   ', fromBranch: '  ', prompt: '  ' },
      REPO,
    );
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.request).toEqual({
      repoUrl: REPO,
      provider: 'e2b',
      agent: 'claude',
      startAgent: true,
    });
  });

  // Regression: the mapping used to DROP agentArgs entirely, so a hub-routed
  // `claude -i` silently lost its processed args (e.g. --dangerously-skip-permissions).
  it('carries agentArgs end-to-end (the dropped-field regression this step fixes)', () => {
    const m = controlPlaneCreateRequest(
      {
        provider: 'e2b',
        agent: 'claude',
        prompt: 'go',
        agentArgs: ['--dangerously-skip-permissions', '-m', 'opus'],
      },
      REPO,
    );
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.request.agentArgs).toEqual(['--dangerously-skip-permissions', '-m', 'opus']);
  });

  it('an empty agentArgs array is not sent', () => {
    const m = controlPlaneCreateRequest({ provider: 'e2b', agent: 'claude', agentArgs: [] }, REPO);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect('agentArgs' in m.request).toBe(false);
  });

  it('carries the cloud-relevant box-shaping opts (snapshot/image/env/build/...)', () => {
    const m = controlPlaneCreateRequest(
      {
        provider: 'e2b',
        agent: 'none',
        opts: {
          snapshot: 'ckpt-1',
          image: 'tmpl-x',
          withEnv: true,
          withPlaywright: false,
          vnc: false,
          bundleDepth: 20,
          build: true,
          credentialSync: false,
        },
      },
      REPO,
    );
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.request.opts).toEqual({
      snapshot: 'ckpt-1',
      image: 'tmpl-x',
      withEnv: true,
      withPlaywright: false,
      vnc: false,
      bundleDepth: 20,
      build: true,
      credentialSync: false,
    });
  });

  it('omits opts entirely when none are set', () => {
    const m = controlPlaneCreateRequest({ provider: 'e2b', agent: 'none', opts: {} }, REPO);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect('opts' in m.request).toBe(false);
  });

  // The THIRD field this mapping has silently swallowed (`agentArgs` and
  // `persistent` were the first two). Pinned here because the failure is
  // invisible: the box builds and boots, it simply has no model auth.
  it('carries borrowCredentials — the selection, never the secret', () => {
    const m = controlPlaneCreateRequest(
      { provider: 'e2b', agent: 'pi', opts: { borrowCredentials: ['codex'] } },
      REPO,
    );
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.request.opts).toEqual({ borrowCredentials: ['codex'] });
  });

  it('drops an empty borrowCredentials rather than sending a meaningless field', () => {
    const m = controlPlaneCreateRequest(
      { provider: 'e2b', agent: 'none', opts: { borrowCredentials: [] } },
      REPO,
    );
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect('opts' in m.request).toBe(false);
  });

  it('startAgent:false builds a COLD box (the foreground create-then-adopt path)', () => {
    const m = controlPlaneCreateRequest(
      { provider: 'e2b', agent: 'claude', startAgent: false },
      REPO,
    );
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    // agent is named (so an adopt relaunches it) but the worker does NOT start it.
    expect(m.request).toEqual({ repoUrl: REPO, provider: 'e2b', agent: 'claude' });
    expect('startAgent' in m.request).toBe(false);
  });
});

describe('the box shape the submitting machine resolved', () => {
  it('carries size and location to the worker', () => {
    // The machine that submits is the only one with the project's config: this
    // box has no checkout and no ~/.agentbox/projects/<hash>. Dropping them
    // here is not "use the project's value", it is the provider's default —
    // which is how a project pinned to cx33 kept getting cx23.
    const m = controlPlaneCreateRequest(
      { provider: 'hetzner', opts: { size: 'cx33', location: 'nbg1' } },
      REPO,
    );
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.request.opts).toMatchObject({ size: 'cx33', location: 'nbg1' });
  });

  it('omits them when the submitter asked for nothing', () => {
    // Absent means "the control box decides", which is the right default only
    // when the project really has no preference.
    const m = controlPlaneCreateRequest({ provider: 'hetzner', opts: { vnc: false } }, REPO);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.request.opts).not.toHaveProperty('size');
    expect(m.request.opts).not.toHaveProperty('location');
  });
});

describe('the portable key list is the mapping', () => {
  // One value per key, so the round trip can assert on identity rather than
  // truthiness. A new key added to the list without a value here fails the next
  // test — which is the point: the list and the mapping cannot drift apart.
  const SAMPLE: Record<PortableCreateOptKey, unknown> = {
    snapshot: 'warm-1',
    image: 'ghcr.io/acme/box:dev',
    withPlaywright: true,
    withEnv: true,
    vnc: false,
    persistent: true,
    bundleDepth: 5,
    build: true,
    credentialSync: false,
    borrowCredentials: ['codex'],
    size: 'cx33',
    location: 'nbg1',
    inbound: 'locked',
    useBranch: 'feat/login',
    sessionName: 'work',
    imageRegistry: 'ghcr.io/acme',
    providerOptions: { timeoutMs: 2_700_000 },
  };

  it('carries every portable key, and the list names them all', () => {
    for (const key of PORTABLE_CREATE_OPT_KEYS) {
      expect(SAMPLE[key], `no sample value for the new key ${key}`).toBeDefined();
    }
    const opts = SAMPLE as ControlPlaneCreateInput['opts'];
    const m = controlPlaneCreateRequest({ provider: 'hetzner', opts }, REPO);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.request.opts).toEqual(SAMPLE);
    expect(m.dropped).toEqual([]);
  });

  it('leaves host-local knobs at home without calling them a drift', () => {
    // The CLI already warns about these; the box cannot honour them and the hub
    // repeating it on every create would be noise.
    const m = controlPlaneCreateRequest(
      {
        provider: 'hetzner',
        // What a docker-shaped caller sends: the hub takes the wider
        // CreateBoxInput, so these keys are legal on the wire.
        opts: { memory: '4g', cpus: '2', portless: true, size: 'cx33' } as never,
      },
      REPO,
    );
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.request.opts).toEqual({ size: 'cx33' });
    expect(m.dropped).toEqual([]);
  });

  it('reports a key it has never heard of', () => {
    // A newer CLI against an older control box: invisible to any client-side
    // check, so the hub is the only thing that can say it.
    const m = controlPlaneCreateRequest(
      { provider: 'hetzner', opts: { somethingNewerCLIsSend: 'yes' } as never },
      REPO,
    );
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.dropped).toEqual(['somethingNewerCLIsSend']);
  });

  it('refuses a direct-push create outright', () => {
    // It copies a git credential into a box on a machine the user does not own.
    const m = controlPlaneCreateRequest(
      { provider: 'hetzner', opts: { gitPushMode: 'direct' } },
      REPO,
    );
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.error).toContain('git.pushMode=direct is refused');
    expect(m.error).toContain('leases');
  });
});

describe('providerOptions on the wire', () => {
  it('carries the per-provider knobs the submitter resolved', () => {
    // Enumerating these key by key is what kept going stale: a hub-created
    // Vercel box ignored box.vercelTimeoutMs for exactly that reason.
    const m = controlPlaneCreateRequest(
      {
        provider: 'vercel',
        opts: { providerOptions: { timeoutMs: 2_700_000, networkPolicy: 'strict' } },
      },
      REPO,
    );
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.request.opts?.providerOptions).toEqual({
      timeoutMs: 2_700_000,
      networkPolicy: 'strict',
    });
  });
});
