import { describe, expect, it } from 'vitest';
import { recreateRefusal, respecFromInspect, sessionGlobs } from '../src/account-recreate.js';

const INSPECT = {
  Image: 'sha256:abc',
  Mounts: [
    {
      Type: 'volume',
      Name: 'agentbox-claude-config',
      Destination: '/home/vscode/.claude',
      RW: true,
    },
    { Type: 'volume', Name: 'agentbox-docker-b1', Destination: '/var/lib/docker', RW: true },
    { Type: 'bind', Source: '/host/repo/.git', Destination: '/host-git/repo', RW: true },
    { Type: 'bind', Source: '/host/gitconfig', Destination: '/home/vscode/.gitconfig', RW: false },
  ],
  Config: {
    Env: [
      'PATH=/usr/bin',
      'AGENTBOX_RELAY_TOKEN=t0k',
      'CLAUDE_CODE_OAUTH_TOKEN=old',
      'ANTHROPIC_API_KEY=old-key',
    ],
  },
  HostConfig: {
    Init: true,
    Memory: 4_000_000_000,
    NanoCpus: 2_000_000_000,
    PortBindings: {
      '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }],
      '6080/tcp': [{ HostPort: '0' }],
    },
  },
};

describe('respecFromInspect', () => {
  const run = () =>
    respecFromInspect(INSPECT, {
      name: 'agentbox-x',
      image: 'agentbox-switch:b1-1',
      fromVolume: 'agentbox-claude-config',
      toVolume: 'agentbox-claude-config-acct-work',
      clearEnv: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
      setEnv: {},
    });

  it('keeps every mount, swapping only the account volume', () => {
    expect(run().spec.extraVolumes).toEqual([
      'agentbox-claude-config-acct-work:/home/vscode/.claude',
      'agentbox-docker-b1:/var/lib/docker',
      '/host/repo/.git:/host-git/repo',
      '/host/gitconfig:/home/vscode/.gitconfig:ro',
    ]);
  });

  it("keeps env and ports, drops the agent's account keys, keeps limits and init", () => {
    const r = run();
    expect(r.spec.env).toEqual({ PATH: '/usr/bin', AGENTBOX_RELAY_TOKEN: 't0k' });
    expect(r.spec.portMappings).toEqual([
      { containerPort: 80, hostPort: 0, hostIp: '127.0.0.1' },
      { containerPort: 6080, hostPort: 0 },
    ]);
    expect(r.spec.limits).toEqual({ memoryBytes: 4_000_000_000, cpus: 2 });
    expect(r.init).toBe(true);
    expect(r.spec.image).toBe('agentbox-switch:b1-1');
  });

  it('refuses a box that does not mount the old volume, or a mount it cannot carry', () => {
    expect(() =>
      respecFromInspect(INSPECT, {
        name: 'x',
        image: 'i',
        fromVolume: 'nope',
        toVolume: 'y',
        clearEnv: [],
        setEnv: {},
      }),
    ).toThrow(/does not mount nope/);
    expect(() =>
      respecFromInspect(
        { ...INSPECT, Mounts: [...INSPECT.Mounts, { Type: 'tmpfs', Destination: '/tmp' }] },
        {
          name: 'x',
          image: 'i',
          fromVolume: 'agentbox-claude-config',
          toVolume: 'y',
          clearEnv: [],
          setEnv: {},
        },
      ),
    ).toThrow(/cannot carry a tmpfs mount/);
  });
});

describe('recreate preconditions', () => {
  it('refuses cloud boxes, paused boxes and agents with no session layout', () => {
    expect(recreateRefusal({ provider: 'hetzner' }, 'claude', 'running')).toMatch(
      /cloud box to another login is not supported yet; use a setup token or API key/,
    );
    expect(recreateRefusal({ provider: 'docker' }, 'claude', 'paused')).toMatch(/paused/);
    expect(recreateRefusal({ provider: 'docker' }, 'codex', 'running')).toMatch(
      /not supported yet/,
    );
    expect(recreateRefusal({ provider: 'docker' }, 'claude', 'running')).toBeNull();
    expect(recreateRefusal({}, 'claude', 'exited')).toBeNull();
  });

  it('expands the session patterns', () => {
    expect(sessionGlobs(['projects/*/{id}.jsonl', 'projects/*/{id}'], 'abc')).toEqual([
      'projects/*/abc.jsonl',
      'projects/*/abc',
    ]);
  });
});
