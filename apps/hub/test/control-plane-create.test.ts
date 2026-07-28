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

  it('rejects docker — it needs the host folder a control box does not have', () => {
    for (const provider of ['docker', 'docker:workshop']) {
      const m = controlPlaneCreateRequest({ provider }, REPO);
      expect(m.ok).toBe(false);
      if (m.ok) return;
      expect(m.error).toMatch(/local checkout/);
    }
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
});
