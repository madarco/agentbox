import { beforeEach, describe, expect, it, vi } from 'vitest';

// Pure: every fs-backed dependency is mocked. `@agentbox/config` derives its
// global-config path from HOME at MODULE LOAD, so a test that let it run for
// real would write to the developer's own `~/.agentbox/config.yaml` (apps/cli
// has no HOME-isolating vitest setup file). The decisions are what matter here.
const hosts = new Map<string, { ssh: string }>();
let globalProvider: string | undefined;

vi.mock('@agentbox/config', () => ({
  loadEffectiveConfig: vi.fn(async () => ({
    layers: { global: { values: { box: { provider: globalProvider } } } },
    effective: {},
  })),
  setConfigValue: vi.fn(async (_scope: string, _key: string, value: string) => {
    globalProvider = value;
  }),
  unsetConfigValue: vi.fn(async () => {
    globalProvider = undefined;
  }),
}));
vi.mock('@agentbox/sandbox-remote-docker', () => ({
  getHostAlias: vi.fn((alias: string) => hosts.get(alias)),
  upsertHostAlias: vi.fn((alias: string, ssh: string) => hosts.set(alias, { ssh })),
  removeHostAlias: vi.fn((alias: string) => hosts.delete(alias)),
}));
vi.mock('../src/control-plane/remote-hub.js', () => ({
  controlBoxIsThisMachine: vi.fn(async () => false),
}));
vi.mock('../src/control-plane/deploy-hetzner.js', () => ({
  readDeployRecord: vi.fn(async () => ({ ip: '10.0.0.1', sshKeyDir: '/keys' })),
}));
vi.mock('../src/control-plane/remote-docker-share.js', () => ({
  controlBoxKnowsHost: vi.fn(async () => true),
}));

const { controlBoxIsThisMachine } = await import('../src/control-plane/remote-hub.js');
const { readDeployRecord } = await import('../src/control-plane/deploy-hetzner.js');
const { controlBoxKnowsHost } = await import('../src/control-plane/remote-docker-share.js');
const { ensureHubDockerTarget, removeHubDockerTarget, HUB_PROVIDER_SPEC } =
  await import('../src/control-plane/hub-docker-target.js');

type DeployRecord = Awaited<ReturnType<typeof readDeployRecord>>;

beforeEach(() => {
  hosts.clear();
  globalProvider = undefined;
  vi.mocked(controlBoxIsThisMachine).mockResolvedValue(false);
  vi.mocked(readDeployRecord).mockResolvedValue({
    ip: '10.0.0.1',
    sshKeyDir: '/keys',
  } as unknown as DeployRecord);
  vi.mocked(controlBoxKnowsHost).mockResolvedValue(true);
});

const silent = () => {};

describe('ensureHubDockerTarget — the default flip', () => {
  it('takes over an unset default', async () => {
    await ensureHubDockerTarget(silent);
    expect(globalProvider).toBe(HUB_PROVIDER_SPEC);
  });

  it('takes over plain docker', async () => {
    globalProvider = 'docker';
    await ensureHubDockerTarget(silent);
    expect(globalProvider).toBe(HUB_PROVIDER_SPEC);
  });

  it.each(['e2b', 'hetzner', 'daytona'])('leaves a pinned cloud provider (%s) alone', async (p) => {
    globalProvider = p;
    await ensureHubDockerTarget(silent);
    expect(globalProvider).toBe(p);
  });

  it('leaves another engine spec alone', async () => {
    globalProvider = 'docker:buildbox';
    await ensureHubDockerTarget(silent);
    expect(globalProvider).toBe('docker:buildbox');
  });

  it('does not flip when the control box does not know the `hub` engine', async () => {
    vi.mocked(controlBoxKnowsHost).mockResolvedValue(false);
    await ensureHubDockerTarget(silent);
    expect(globalProvider).toBeUndefined();
  });

  it('does nothing at all when the control box IS this machine', async () => {
    vi.mocked(controlBoxIsThisMachine).mockResolvedValue(true);
    await ensureHubDockerTarget(silent);
    expect(globalProvider).toBeUndefined();
    expect(hosts.has('hub')).toBe(false);
  });
});

describe('ensureHubDockerTarget — the host alias', () => {
  it('registers `hub` against the managed ssh alias', async () => {
    await ensureHubDockerTarget(silent);
    expect(hosts.get('hub')?.ssh).toBe('agentbox-hub');
  });

  it('never repoints a `hub` alias the user owns', async () => {
    hosts.set('hub', { ssh: 'me@my-server' });
    const lines: string[] = [];
    await ensureHubDockerTarget((l) => lines.push(l));
    expect(hosts.get('hub')?.ssh).toBe('me@my-server');
    expect(lines.join('\n')).toContain('left alone');
  });

  it('skips the alias without a local deploy record, but still flips the default', async () => {
    vi.mocked(readDeployRecord).mockResolvedValue(null as unknown as DeployRecord);
    await ensureHubDockerTarget(silent);
    expect(hosts.has('hub')).toBe(false);
    expect(globalProvider).toBe(HUB_PROVIDER_SPEC);
  });
});

describe('removeHubDockerTarget', () => {
  it('undoes exactly what ensure put in place', async () => {
    await ensureHubDockerTarget(silent);
    await removeHubDockerTarget(silent);
    expect(globalProvider).toBeUndefined();
    expect(hosts.has('hub')).toBe(false);
  });

  it('keeps a default the user chose, and an alias they repointed', async () => {
    globalProvider = 'e2b';
    hosts.set('hub', { ssh: 'me@my-server' });
    await removeHubDockerTarget(silent);
    expect(globalProvider).toBe('e2b');
    expect(hosts.get('hub')?.ssh).toBe('me@my-server');
  });
});
