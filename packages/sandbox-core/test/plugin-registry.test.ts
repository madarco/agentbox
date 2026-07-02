import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addPluginRecord,
  isSupportedApiVersion,
  pluginForProvider,
  pluginProviderNames,
  readPluginRegistry,
  readPluginRegistrySync,
  removePluginRecord,
  SUPPORTED_SDK_API_VERSIONS,
  type PluginRecord,
} from '../src/plugin-registry.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentbox-plugins-'));
  path = join(dir, 'plugins.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const rec = (overrides: Partial<PluginRecord> = {}): PluginRecord => ({
  packageName: 'agentbox-provider-fly',
  resolvedEntry: '/abs/fly/dist/index.js',
  version: '1.2.3',
  providers: ['fly'],
  apiVersion: 1,
  addedAt: '2026-07-02T00:00:00.000Z',
  ...overrides,
});

describe('plugin registry', () => {
  it('missing file reads as empty (sync + async)', async () => {
    expect(readPluginRegistrySync(path)).toEqual({ version: 1, plugins: [] });
    expect(await readPluginRegistry(path)).toEqual({ version: 1, plugins: [] });
  });

  it('add → read round-trips and is atomic JSON', async () => {
    await addPluginRecord(rec(), path);
    const file = readPluginRegistrySync(path);
    expect(file.version).toBe(1);
    expect(file.plugins).toHaveLength(1);
    expect(file.plugins[0]?.providers).toEqual(['fly']);
    // valid JSON with trailing newline
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  });

  it('add is an upsert keyed by packageName', async () => {
    await addPluginRecord(rec({ version: '1.0.0' }), path);
    await addPluginRecord(rec({ version: '2.0.0' }), path);
    const file = readPluginRegistrySync(path);
    expect(file.plugins).toHaveLength(1);
    expect(file.plugins[0]?.version).toBe('2.0.0');
  });

  it('resolves a provider name to its plugin and lists names', async () => {
    await addPluginRecord(rec(), path);
    await addPluginRecord(rec({ packageName: 'agentbox-provider-render', providers: ['render'] }), path);
    expect(pluginProviderNames(path).sort()).toEqual(['fly', 'render']);
    expect(pluginForProvider('render', path)?.packageName).toBe('agentbox-provider-render');
    expect(pluginForProvider('nope', path)).toBeNull();
  });

  it('remove by package name OR provider name', async () => {
    await addPluginRecord(rec(), path);
    expect(await removePluginRecord('fly', path)).toBe(1); // by provider name
    expect(readPluginRegistrySync(path).plugins).toHaveLength(0);
    await addPluginRecord(rec(), path);
    expect(await removePluginRecord('agentbox-provider-fly', path)).toBe(1); // by package name
    expect(await removePluginRecord('missing', path)).toBe(0);
  });

  it('corrupt registry degrades to empty on READ, never throws', () => {
    writeFileSync(path, '{ not json', 'utf8');
    expect(readPluginRegistrySync(path)).toEqual({ version: 1, plugins: [] });
    writeFileSync(path, JSON.stringify({ version: 99, plugins: [] }), 'utf8');
    expect(readPluginRegistrySync(path)).toEqual({ version: 1, plugins: [] });
  });

  it('a WRITE refuses to clobber a corrupt registry (no data loss)', async () => {
    writeFileSync(path, '{ not json — hand-edited', 'utf8');
    await expect(addPluginRecord(rec(), path)).rejects.toThrow(/corrupt|unrecognized/i);
    // the corrupt file is left intact, not overwritten with an empty registry
    expect(readFileSync(path, 'utf8')).toContain('hand-edited');
  });

  it('api-version gate', () => {
    expect(isSupportedApiVersion(1)).toBe(true);
    expect(isSupportedApiVersion(999)).toBe(false);
    expect(SUPPORTED_SDK_API_VERSIONS).toContain(1);
  });
});
