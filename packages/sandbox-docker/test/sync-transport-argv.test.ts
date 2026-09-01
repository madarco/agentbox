import { describe, expect, it } from 'vitest';
import { __testing } from '../src/sync/sync-transport.js';

/**
 * The two transport modes must be PATH-COMPATIBLE: a caller passes box-absolute
 * paths and neither mode rewrites them. That is what lets one `pull(t)` body
 * serve a running box and a stopped one, instead of the three hand-rolled
 * `docker run -v` blocks the per-agent pulls used to carry.
 *
 * These assert argv rather than behaviour on purpose — this file had no test at
 * all, and the interesting bugs here are a missing `-i`, a lost `--user`, or a
 * volume mounted somewhere other than its box path.
 */
const container = __testing.containerRunner('agentbox-demo');
const volume = __testing.volumeRunner({
  volume: 'agentbox-claude-config',
  mountPath: '/home/vscode/.claude',
  image: 'agentbox/box:dev',
});

describe('container mode', () => {
  it('execs against the running container', () => {
    expect(container.argv(['ls', '/home/vscode/.claude'])).toEqual([
      'exec',
      'agentbox-demo',
      'ls',
      '/home/vscode/.claude',
    ]);
  });

  it('carries user, cwd, env and stdin', () => {
    expect(
      container.argv(['tar', '-xf', '-'], { stdin: true, user: '0:0', cwd: '/w', env: { A: 'b' } }),
    ).toEqual([
      'exec',
      '-i',
      '--user',
      '0:0',
      '-w',
      '/w',
      '-e',
      'A=b',
      'agentbox-demo',
      'tar',
      '-xf',
      '-',
    ]);
  });

  it('has a docker cp in both directions', () => {
    expect(container.cpIn('/h/f', '/b/f')).toEqual(['cp', '/h/f', 'agentbox-demo:/b/f']);
    expect(container.cpOut('/b/f', '/h/f')).toEqual(['cp', 'agentbox-demo:/b/f', '/h/f']);
  });
});

describe('volume mode', () => {
  it('mounts the volume AT ITS BOX PATH, so box-absolute paths resolve', () => {
    // The whole point: the same argument works in both modes.
    const argv = volume.argv(['ls', '/home/vscode/.claude']);
    expect(argv).toContain('-v');
    expect(argv).toContain('agentbox-claude-config:/home/vscode/.claude');
    expect(argv.slice(-2)).toEqual(['ls', '/home/vscode/.claude']);
  });

  it('runs a throwaway container as root by default', () => {
    expect(volume.argv(['true']).slice(0, 4)).toEqual(['run', '--rm', '--user', '0']);
  });

  it('honours an explicit user over the root default', () => {
    expect(volume.argv(['true'], { user: '1000:1000' })).toContain('1000:1000');
    expect(volume.argv(['true'], { user: '1000:1000' })).not.toContain('0');
  });

  it('mounts read-only when reading, writable otherwise', () => {
    expect(volume.argv(['cat', '/x'], { readOnly: true })).toContain(
      'agentbox-claude-config:/home/vscode/.claude:ro',
    );
    expect(volume.argv(['tar', '-xf', '-'], { stdin: true })).toContain(
      'agentbox-claude-config:/home/vscode/.claude',
    );
  });

  it('keeps stdin open for a streamed tarball', () => {
    expect(volume.argv(['tar', '-xf', '-'], { stdin: true })).toContain('-i');
    expect(volume.argv(['tar', '-xf', '-'])).not.toContain('-i');
  });

  it('has no docker cp — there is no container to address', () => {
    // The transport falls back to a tar stream, which is also what preserves
    // `auth.json`'s 0600 (a `cat` redirect would not).
    expect(volume.cpIn('/h/f', '/b/f')).toBeNull();
    expect(volume.cpOut('/b/f', '/h/f')).toBeNull();
  });
});
