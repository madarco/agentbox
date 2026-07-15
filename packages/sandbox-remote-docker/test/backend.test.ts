import { describe, expect, it } from 'vitest';
import {
  buildRunArgv,
  makeSnapshotName,
  mapDockerState,
  parseDockerPort,
  parseSize,
  parseSnapshotName,
} from '../src/backend.js';

describe('mapDockerState', () => {
  // A spec-mirror table: `docker inspect -f {{.State.Status}}` has a closed set
  // of values, and every one of them must land somewhere deliberate.
  const cases: Array<[string, string]> = [
    ['running', 'running'],
    ['paused', 'paused'],
    ['created', 'stopped'],
    ['exited', 'stopped'],
    ['dead', 'stopped'],
    ['restarting', 'stopped'],
    ['removing', 'stopped'],
    ['', 'missing'],
    ['who-knows', 'missing'],
  ];
  it.each(cases)('%s -> %s', (status, expected) => {
    expect(mapDockerState(status)).toBe(expected);
  });

  it('tolerates the trailing newline docker actually emits', () => {
    expect(mapDockerState('running\n')).toBe('running');
  });
});

describe('parseDockerPort', () => {
  it('reads the published loopback port', () => {
    expect(parseDockerPort('127.0.0.1:49153\n')).toBe(49153);
  });

  it('takes the first binding when docker lists several', () => {
    expect(parseDockerPort('127.0.0.1:49153\n[::1]:49154\n')).toBe(49153);
  });

  it('returns null when the port is not published', () => {
    expect(parseDockerPort('')).toBeNull();
  });
});

describe('parseSize', () => {
  it('reads `cpu-memory` GB', () => {
    expect(parseSize('4-8')).toEqual({ cpu: 4, memory: 8 });
  });

  it('accepts a bare cpu count', () => {
    expect(parseSize('4')).toEqual({ cpu: 4 });
  });

  it('is empty for unset / unparseable specs, so the box stays unlimited', () => {
    expect(parseSize(undefined)).toEqual({});
    expect(parseSize('')).toEqual({});
    expect(parseSize('cx33')).toEqual({});
  });
});

describe('snapshot names', () => {
  it('round-trips the host and the docker image ref', () => {
    const name = makeSnapshotName('dev@10.0.0.9:2222', 'agentbox-ckpt-9f2a_repo:setup');
    const parsed = parseSnapshotName(name);
    expect(parsed.host).toBe('dev@10.0.0.9:2222');
    // The image ref must come back untouched — `:setup` is docker's tag
    // separator, and the host half has colons of its own.
    expect(parsed.imageRef).toBe('agentbox-ckpt-9f2a_repo:setup');
  });

  it('rejects a name with no separator rather than committing to a bad ref', () => {
    expect(() => parseSnapshotName('agentbox-ckpt-x:setup')).toThrow(/malformed snapshot name/);
  });
});

describe('buildRunArgv', () => {
  const base = {
    container: 'agentbox-box',
    image: 'agentbox/box:abc',
    env: { AGENTBOX: '1' },
    ports: [80, 6080, 8788, 22],
    dockerVolume: 'agentbox-docker-agentbox-box',
  };

  it('carries the cap/security/cgroup set the in-box dockerd needs', () => {
    const argv = buildRunArgv(base);
    for (const flag of [
      '--cap-add=SYS_ADMIN',
      '--cap-add=NET_ADMIN',
      '--device=/dev/fuse',
      '--security-opt=apparmor:unconfined',
      '--security-opt=seccomp=unconfined',
      '--cgroupns=private',
    ]) {
      expect(argv).toContain(flag);
    }
  });

  it('publishes each port on the REMOTE loopback with an ephemeral host port', () => {
    const argv = buildRunArgv(base);
    expect(argv).toContain('127.0.0.1:0:80');
    expect(argv).toContain('127.0.0.1:0:6080');
    expect(argv).toContain('127.0.0.1:0:8788');
    expect(argv).toContain('127.0.0.1:0:22');
  });

  it('mounts /var/lib/docker on a volume so `docker commit` cannot swallow the inner images', () => {
    const argv = buildRunArgv(base);
    expect(argv).toContain('agentbox-docker-agentbox-box:/var/lib/docker');
  });

  it("applies no limits by default — a remote engine is the user's own machine", () => {
    const argv = buildRunArgv(base);
    expect(argv).not.toContain('--cpus');
    expect(argv).not.toContain('--memory');
  });

  it('applies limits when --size asked for them', () => {
    const argv = buildRunArgv({ ...base, cpu: 4, memory: 8 });
    expect(argv[argv.indexOf('--cpus') + 1]).toBe('4');
    expect(argv[argv.indexOf('--memory') + 1]).toBe('8g');
  });

  it('ends with the image and a command that keeps the container alive', () => {
    const argv = buildRunArgv(base);
    expect(argv.slice(-3)).toEqual(['agentbox/box:abc', 'sleep', 'infinity']);
  });
});
