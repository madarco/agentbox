import { describe, expect, it } from 'vitest';
import { controlPlaneCreateRequest } from '../lib/boxes/control-plane-create';

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
