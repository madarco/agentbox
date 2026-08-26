import { beforeEach, describe, expect, it, vi } from 'vitest';

// Pure: every fs-backed dependency is mocked. `@agentbox/config` derives its
// global-config path from HOME at MODULE LOAD, so a test that let it run for
// real would write to the developer's own `~/.agentbox/config.yaml` (apps/cli
// has no HOME-isolating vitest setup file). The decisions are what matter here.
const hosts = new Map<string, { ssh: string }>();
/**
 * The global layer as the PARSER would hand it over: `box.provider` is always a
 * bare name, with the engine split out into `box.remoteDockerHost`. The mocked
 * writer desugars the same way `setConfigValue` really does, so these tests
 * exercise the pair semantics rather than a string compare that no longer
 * happens anywhere.
 */
let globalBox: { provider?: string; remoteDockerHost?: string } = {};

const desugar = (value: string): { provider?: string; remoteDockerHost?: string } => {
  const colon = value.indexOf(':');
  if (colon < 0) return { provider: value };
  return { provider: 'remote-docker', remoteDockerHost: value.slice(colon + 1) };
};

vi.mock('@agentbox/config', () => ({
  REMOTE_DOCKER: 'remote-docker',
  loadEffectiveConfig: vi.fn(async () => ({
    layers: { global: { values: { box: globalBox } } },
    effective: {},
  })),
  setConfigValue: vi.fn(async (_scope: string, key: string, value: string) => {
    globalBox =
      key === 'box.provider' ? { ...globalBox, ...desugar(value) } : { ...globalBox, [key]: value };
  }),
  unsetConfigValue: vi.fn(async (_scope: string, key: string) => {
    const leaf = key.slice('box.'.length) as 'provider' | 'remoteDockerHost';
    delete globalBox[leaf];
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
const { ensureHubDockerTarget, removeHubDockerTarget } =
  await import('../src/control-plane/hub-docker-target.js');

type DeployRecord = Awaited<ReturnType<typeof readDeployRecord>>;

beforeEach(() => {
  hosts.clear();
  globalBox = {};
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
    // The spec goes in; the PAIR comes out.
    expect(globalBox).toEqual({ provider: 'remote-docker', remoteDockerHost: 'hub' });
  });

  it('takes over plain docker', async () => {
    globalBox = { provider: 'docker' };
    await ensureHubDockerTarget(silent);
    expect(globalBox).toEqual({ provider: 'remote-docker', remoteDockerHost: 'hub' });
  });

  it.each(['e2b', 'hetzner', 'daytona'])('leaves a pinned cloud provider (%s) alone', async (p) => {
    globalBox = { provider: p };
    await ensureHubDockerTarget(silent);
    expect(globalBox).toEqual({ provider: p });
  });

  it('leaves another engine spec alone', async () => {
    globalBox = desugar('docker:buildbox');
    await ensureHubDockerTarget(silent);
    expect(globalBox).toEqual({ provider: 'remote-docker', remoteDockerHost: 'buildbox' });
  });

  it('never clobbers a default engine the user picked', async () => {
    // Setting the spec writes box.remoteDockerHost too, so a machine that already
    // has a default engine must be left alone even though its provider is unset.
    globalBox = { remoteDockerHost: 'buildbox' };
    await ensureHubDockerTarget(silent);
    expect(globalBox).toEqual({ remoteDockerHost: 'buildbox' });
  });

  it('does not flip when the control box does not know the `hub` engine', async () => {
    vi.mocked(controlBoxKnowsHost).mockResolvedValue(false);
    await ensureHubDockerTarget(silent);
    expect(globalBox.provider).toBeUndefined();
  });

  it('does nothing at all when the control box IS this machine', async () => {
    vi.mocked(controlBoxIsThisMachine).mockResolvedValue(true);
    await ensureHubDockerTarget(silent);
    expect(globalBox.provider).toBeUndefined();
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
    expect(globalBox).toEqual({ provider: 'remote-docker', remoteDockerHost: 'hub' });
  });
});

describe('removeHubDockerTarget', () => {
  it('undoes exactly what ensure put in place', async () => {
    await ensureHubDockerTarget(silent);
    await removeHubDockerTarget(silent);
    // BOTH leaves — leaving `remoteDockerHost: hub` behind would point the
    // default at an alias this function just deleted.
    expect(globalBox).toEqual({});
    expect(hosts.has('hub')).toBe(false);
  });

  it('keeps a default the user chose, and an alias they repointed', async () => {
    globalBox = { provider: 'e2b' };
    hosts.set('hub', { ssh: 'me@my-server' });
    await removeHubDockerTarget(silent);
    expect(globalBox).toEqual({ provider: 'e2b' });
    expect(hosts.get('hub')?.ssh).toBe('me@my-server');
  });

  it('keeps a remote-docker default pointed at some OTHER engine', async () => {
    globalBox = desugar('docker:buildbox');
    await removeHubDockerTarget(silent);
    expect(globalBox).toEqual({ provider: 'remote-docker', remoteDockerHost: 'buildbox' });
  });
});
