import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registeredAgentSyncModules, requireAgentSyncModule } from '@agentbox/sandbox-docker';
import { registerAllAgentModules, registerInstalledAgentModules } from '../src/index.js';

/**
 * The plugin loader against a REAL package on disk, loaded by a real dynamic
 * `import()` — the whole point being that the specifier is variable, so mocking
 * the import would test nothing that matters.
 */
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentbox-agent-plugin-'));
  registerAllAgentModules();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write a package that exports `agentSpec` and optionally `agentSyncModule`. */
async function writePackage(id: string, opts: { moduleId?: string } = {}): Promise<string> {
  const pkgDir = join(dir, `agentbox-agent-${id}`);
  await mkdir(pkgDir, { recursive: true });
  const entry = join(pkgDir, 'index.mjs');
  const body =
    opts.moduleId === undefined
      ? ''
      : `
export const agentSyncModule = {
  id: ${JSON.stringify(opts.moduleId)},
  resolveVolume: () => ({ volume: 'agentbox-${id}-config' }),
  buildMounts: (s) => ({ extraVolumes: [], env: {}, volumeName: s.volume }),
  ensureVolume: () => Promise.resolve({ created: true, synced: false }),
  sessionInfo: () => Promise.resolve({ running: false, sessionName: ${JSON.stringify(id)}, startedAt: null }),
};`;
  await writeFile(entry, `export const agentSpec = { id: ${JSON.stringify(id)} };${body}\n`);
  return entry;
}

/**
 * Point the loader at a fixture registry file. A real file rather than a mocked
 * module: mocking would fork the module graph, and the loader would then
 * register into a different `sandbox-docker` instance than the one this test
 * reads — which is exactly how the first version of this test lied.
 */
async function loadWith(records: Array<{ packageName: string; entry: string; ids: string[] }>) {
  const registryPath = join(dir, 'agents.json');
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      agents: records.map((r) => ({
        packageName: r.packageName,
        resolvedEntry: r.entry,
        version: '1.0.0',
        specs: Object.fromEntries(r.ids.map((id) => [id, { id }])),
        apiVersion: 1,
        addedAt: '2026-08-31T00:00:00.000Z',
      })),
    }),
  );
  return registerInstalledAgentModules({ registryPath });
}

describe('registerInstalledAgentModules', () => {
  it("loads an installed agent's docker behavior through a real dynamic import", async () => {
    const entry = await writePackage('demo', { moduleId: 'demo' });
    const result = await loadWith([{ packageName: 'agentbox-agent-demo', entry, ids: ['demo'] }]);
    expect(result.loaded).toEqual(['demo']);
    expect(result.failed).toEqual([]);
    expect(registeredAgentSyncModules().map((m) => m.id)).toContain('demo');
    expect(requireAgentSyncModule('demo').resolveVolume({ isolate: false, boxId: 'b' })).toEqual({
      volume: 'agentbox-demo-config',
    });
  });

  it('accepts a data-only package as a no-op, not a failure', async () => {
    // An agent whose config is purely declarative needs no docker code at all.
    const entry = await writePackage('dataonly');
    const result = await loadWith([{ packageName: 'agentbox-agent-x', entry, ids: ['dataonly'] }]);
    expect(result).toEqual({ loaded: [], failed: [] });
  });

  it('refuses a module for an agent the package did not register', async () => {
    // Otherwise a plugin could hand back a module for `claude` and take over
    // the built-in — the code-half equivalent of shadowing.
    const entry = await writePackage('demo', { moduleId: 'claude' });
    const before = requireAgentSyncModule('claude');
    const result = await loadWith([{ packageName: 'agentbox-agent-demo', entry, ids: ['demo'] }]);
    expect(result.loaded).toEqual([]);
    expect(result.failed[0]?.reason).toMatch(/did not register/);
    expect(requireAgentSyncModule('claude')).toBe(before);
  });

  it('reports a package that cannot be loaded, and keeps going', async () => {
    const good = await writePackage('good', { moduleId: 'good' });
    const result = await loadWith([
      { packageName: 'agentbox-agent-gone', entry: join(dir, 'missing.mjs'), ids: ['gone'] },
      { packageName: 'agentbox-agent-good', entry: good, ids: ['good'] },
    ]);
    // A broken or half-uninstalled package must not take down every box
    // command, and must not stop the packages after it from loading.
    expect(result.failed.map((f) => f.packageName)).toEqual(['agentbox-agent-gone']);
    expect(result.loaded).toEqual(['good']);
  });
});
