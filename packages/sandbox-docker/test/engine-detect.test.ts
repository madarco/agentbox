import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// execa is mocked so the tests never shell out to a real docker.
const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execaMock }));

// `engine.kind` comes from the user's config; drive it per-test.
const { pin } = vi.hoisted(() => ({ pin: { value: 'auto' as string } }));
// Partial mock: the module is imported for real elsewhere in the graph (the
// agent registry reads STATE_DIR at import time), so only the one call the
// engine probe makes is replaced.
vi.mock('@agentbox/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agentbox/config')>()),
  loadEffectiveConfig: async () => ({ effective: { engine: { kind: pin.value } } }),
}));

import { detectEngine, setEngineOverride } from '../src/sync/host-export.js';

function daemonSays(os: string): void {
  execaMock.mockResolvedValue({ stdout: os, stderr: '', exitCode: 0 });
}

describe('detectEngine', () => {
  beforeEach(() => {
    execaMock.mockReset();
    pin.value = 'auto';
    setEngineOverride(null); // also clears the cache
  });
  afterEach(() => {
    setEngineOverride(null);
  });

  it('reads the engine off `docker info`', async () => {
    daemonSays('OrbStack');
    expect(await detectEngine()).toBe('orbstack');
    daemonSays('Docker Desktop');
    setEngineOverride(null);
    expect(await detectEngine()).toBe('docker-desktop');
  });

  it('falls back to "other" on an unknown daemon or a failed probe', async () => {
    daemonSays('Ubuntu 24.04');
    expect(await detectEngine()).toBe('other');
  });

  it('caches, so a burst of calls costs one probe', async () => {
    daemonSays('OrbStack');
    await detectEngine();
    await detectEngine();
    await detectEngine();
    expect(execaMock).toHaveBeenCalledTimes(1);
  });

  it('holds its answer for the life of the process', async () => {
    // Deliberate: switching engines is rare enough that a live re-probe in
    // every docker-touching process is not worth its cost. `agentbox hub` and
    // `agentbox relay` therefore keep the engine they started with -- restart
    // them after a switch, or their boxes keep being advertised at the old
    // engine's URLs.
    daemonSays('OrbStack');
    expect(await detectEngine()).toBe('orbstack');
    daemonSays('Docker Desktop');
    expect(await detectEngine()).toBe('orbstack');
    expect(execaMock).toHaveBeenCalledTimes(1);
  });

  it('honours an engine.kind pin without probing at all', async () => {
    pin.value = 'orbstack';
    daemonSays('Docker Desktop');
    expect(await detectEngine()).toBe('orbstack');
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('probes when the pin is auto, in the same process', async () => {
    // The pin is read on the same one-shot path as the probe, so clearing it
    // takes effect in the next process -- here, the next cleared cache.
    pin.value = 'orbstack';
    expect(await detectEngine()).toBe('orbstack');
    pin.value = 'auto';
    daemonSays('Docker Desktop');
    setEngineOverride(null);
    expect(await detectEngine()).toBe('docker-desktop');
  });
});
