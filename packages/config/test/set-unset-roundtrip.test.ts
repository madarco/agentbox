import { readFile, realpath } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEffectiveConfig } from '../src/load.js';
import { GLOBAL_CONFIG_FILE, projectConfigFile } from '../src/paths.js';
import { setConfigValue, unsetConfigValue } from '../src/write.js';
import { parse as parseYaml } from 'yaml';

let tmpCwd: string;

beforeEach(async () => {
  // realpath so the test's expected projectConfigFile(tmpCwd) matches the
  // canonical path that setConfigValue → findProjectRoot resolves to.
  tmpCwd = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-cfg-rt-')));
});

afterEach(async () => {
  await rm(tmpCwd, { recursive: true, force: true });
  await rm(join(homedir(), '.agentbox'), { recursive: true, force: true });
});

describe('set/unset roundtrip', () => {
  it('writes global config and loads it back', async () => {
    const r = await setConfigValue('global', 'box.withPlaywright', 'true', tmpCwd, { raw: true });
    expect(r.path).toBe(GLOBAL_CONFIG_FILE);
    expect(r.coerced).toBe(true);
    const loaded = await loadEffectiveConfig(tmpCwd);
    expect(loaded.effective.box.withPlaywright).toBe(true);
    expect(loaded.sources['box.withPlaywright']).toBe('global');
  });

  it('writes project config and loads it back', async () => {
    const r = await setConfigValue('project', 'engine.kind', 'orbstack', tmpCwd, { raw: true });
    expect(r.path).toBe(projectConfigFile(tmpCwd));
    const loaded = await loadEffectiveConfig(tmpCwd);
    expect(loaded.effective.engine.kind).toBe('orbstack');
    expect(loaded.sources['engine.kind']).toBe('project');
  });

  it('unset removes a leaf and prunes empty parent objects', async () => {
    await setConfigValue('global', 'box.withPlaywright', 'true', tmpCwd, { raw: true });
    await setConfigValue('global', 'box.vnc', 'false', tmpCwd, { raw: true });
    // Both leaves under `box`.
    let yaml = parseYaml(await readFile(GLOBAL_CONFIG_FILE, 'utf8')) as Record<string, unknown>;
    expect(yaml).toHaveProperty('box');

    await unsetConfigValue('global', 'box.withPlaywright', tmpCwd);
    yaml = parseYaml(await readFile(GLOBAL_CONFIG_FILE, 'utf8')) as Record<string, unknown>;
    expect(yaml['box']).toEqual({ vnc: false });

    await unsetConfigValue('global', 'box.vnc', tmpCwd);
    yaml = (parseYaml(await readFile(GLOBAL_CONFIG_FILE, 'utf8')) as Record<string, unknown> | null) ?? {};
    expect(yaml).not.toHaveProperty('box');
  });

  it('unset is a no-op when the leaf was already absent', async () => {
    const r = await unsetConfigValue('project', 'box.withPlaywright', tmpCwd);
    expect(r.existed).toBe(false);
  });

  it('set rejects unknown keys', async () => {
    await expect(
      setConfigValue('global', 'foo.bar', 'x', tmpCwd, { raw: true }),
    ).rejects.toThrow();
  });

  it('set rejects type-mismatched strings', async () => {
    await expect(
      setConfigValue('global', 'code.timeoutMs', 'banana', tmpCwd, { raw: true }),
    ).rejects.toThrow();
  });
});
