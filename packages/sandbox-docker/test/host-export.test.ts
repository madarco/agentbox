import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('detectEngine', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('execa');
  });

  async function loadWithDockerInfoOs(os: string): Promise<typeof import('../src/host-export.js')> {
    vi.doMock('execa', () => ({
      execa: vi.fn(async () => ({ stdout: os, stderr: '', exitCode: 0 })),
    }));
    const mod = await import('../src/host-export.js');
    mod.__setEngineForTesting(null);
    return mod;
  }

  it('detects OrbStack', async () => {
    const mod = await loadWithDockerInfoOs('OrbStack');
    expect(await mod.detectEngine()).toBe('orbstack');
  });

  it('detects Docker Desktop', async () => {
    const mod = await loadWithDockerInfoOs('Docker Desktop 4.30.0');
    expect(await mod.detectEngine()).toBe('docker-desktop');
  });

  it('falls back to "other" for unknown engines', async () => {
    const mod = await loadWithDockerInfoOs('Ubuntu 22.04');
    expect(await mod.detectEngine()).toBe('other');
  });

  it('caches the result across calls', async () => {
    let calls = 0;
    vi.doMock('execa', () => ({
      execa: vi.fn(async () => {
        calls += 1;
        return { stdout: 'OrbStack', stderr: '', exitCode: 0 };
      }),
    }));
    const mod = await import('../src/host-export.js');
    mod.__setEngineForTesting(null);
    await mod.detectEngine();
    await mod.detectEngine();
    await mod.detectEngine();
    expect(calls).toBe(1);
  });
});

describe('getHostPaths', () => {
  let dir: string;
  const originalHome = process.env['HOME'];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentbox-hostpath-test-'));
    process.env['HOME'] = dir;
    vi.resetModules();
  });

  afterEach(async () => {
    vi.resetModules();
    vi.doUnmock('execa');
    process.env['HOME'] = originalHome;
    await rm(dir, { recursive: true, force: true });
  });

  it('derives merged and upper export paths from the box id', async () => {
    vi.doMock('execa', () => ({
      execa: vi.fn(async () => ({ stdout: 'Docker Desktop', stderr: '', exitCode: 0 })),
    }));
    const { getHostPaths, __setEngineForTesting } = await import('../src/host-export.js');
    __setEngineForTesting(null);

    const paths = await getHostPaths({ id: 'abcd1234', upperVolume: 'agentbox-upper-abcd1234' });
    expect(paths.boxDir).toBe(join(dir, '.agentbox', 'boxes', 'abcd1234'));
    expect(paths.mergedExport).toBe(join(dir, '.agentbox', 'boxes', 'abcd1234', 'workspace'));
    expect(paths.upperExport).toBe(join(dir, '.agentbox', 'boxes', 'abcd1234', 'upper'));
    // Docker Desktop: no live host path.
    expect(paths.upperLiveOnHost).toBeNull();
  });

  it('returns the OrbStack live path when ~/OrbStack/docker/volumes/<vol>/upper exists', async () => {
    // Simulate OrbStack's documented shared-folder layout under the fake HOME.
    // Note: OrbStack exposes volume contents *directly* under <vol>/; there's
    // no _data subdir.
    const orbVolDir = join(dir, 'OrbStack', 'docker', 'volumes', 'agentbox-upper-deadbeef');
    await mkdir(join(orbVolDir, 'upper'), { recursive: true });

    vi.doMock('execa', () => ({
      execa: vi.fn(async (_cmd: string, args: readonly string[]) => {
        if (args[0] === 'info') return { stdout: 'OrbStack', stderr: '', exitCode: 0 };
        // We expect resolveUpperLiveOnHost to NOT need to call volume inspect
        // when the OrbStack path already exists, but tolerate the call anyway.
        if (args[0] === 'volume' && args[1] === 'inspect') {
          return { stdout: '/var/lib/docker/volumes/agentbox-upper-deadbeef/_data', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 1 };
      }),
    }));
    const { getHostPaths, __setEngineForTesting } = await import('../src/host-export.js');
    __setEngineForTesting(null);

    const paths = await getHostPaths({ id: 'deadbeef', upperVolume: 'agentbox-upper-deadbeef' });
    expect(paths.upperLiveOnHost).toBe(join(orbVolDir, 'upper'));
  });

  it('falls back to the docker-reported mountpoint when OrbStack path is absent and the mountpoint is a real host path', async () => {
    const customDir = join(dir, 'somewhere', 'else', 'agentbox-upper-cafef00d');
    await mkdir(join(customDir, 'upper'), { recursive: true });

    vi.doMock('execa', () => ({
      execa: vi.fn(async (_cmd: string, args: readonly string[]) => {
        if (args[0] === 'info') return { stdout: 'OrbStack', stderr: '', exitCode: 0 };
        if (args[0] === 'volume' && args[1] === 'inspect') {
          return { stdout: customDir, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 1 };
      }),
    }));
    const { getHostPaths, __setEngineForTesting } = await import('../src/host-export.js');
    __setEngineForTesting(null);

    const paths = await getHostPaths({ id: 'cafef00d', upperVolume: 'agentbox-upper-cafef00d' });
    expect(paths.upperLiveOnHost).toBe(join(customDir, 'upper'));
  });

  it('returns null when no host-side upper path can be found', async () => {
    vi.doMock('execa', () => ({
      execa: vi.fn(async (_cmd: string, args: readonly string[]) => {
        if (args[0] === 'info') return { stdout: 'OrbStack', stderr: '', exitCode: 0 };
        if (args[0] === 'volume' && args[1] === 'inspect') {
          return { stdout: '/var/lib/docker/volumes/nope/_data', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 1 };
      }),
    }));
    const { getHostPaths, __setEngineForTesting } = await import('../src/host-export.js');
    __setEngineForTesting(null);

    const paths = await getHostPaths({ id: 'missing0', upperVolume: 'agentbox-upper-missing0' });
    expect(paths.upperLiveOnHost).toBeNull();
  });
});

describe('BOXES_ROOT / boxRunDirFor', () => {
  const originalHome = process.env['HOME'];

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    process.env['HOME'] = originalHome;
  });

  it('roots under $HOME/.agentbox/boxes', async () => {
    process.env['HOME'] = '/tmp/fake-home';
    const { BOXES_ROOT, boxRunDirFor } = await import('../src/host-export.js');
    expect(BOXES_ROOT).toBe('/tmp/fake-home/.agentbox/boxes');
    expect(boxRunDirFor('abcd1234')).toBe('/tmp/fake-home/.agentbox/boxes/abcd1234');
  });
});

