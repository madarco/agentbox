import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GLOBAL_CONFIG_FILE } from '../src/paths.js';
import { setConfigValue, unsetConfigValue } from '../src/write.js';
import { parse as parseYaml } from 'yaml';

/**
 * `config set` rewrites the whole file from the doc it read back. Now that the
 * parser DROPS unknown keys instead of throwing, reading through it would
 * silently delete any key this agentbox doesn't know — including one written by
 * a newer agentbox, which is exactly what we promised to preserve. `write.ts`
 * round-trips the raw YAML for this reason.
 */
let tmpCwd: string;

beforeEach(async () => {
  tmpCwd = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-cfg-preserve-')));
  await mkdir(dirname(GLOBAL_CONFIG_FILE), { recursive: true });
});

afterEach(async () => {
  await rm(tmpCwd, { recursive: true, force: true });
  await rm(join(homedir(), '.agentbox'), { recursive: true, force: true });
});

describe('unknown keys survive a write', () => {
  it('config set preserves a key this registry does not know', async () => {
    await writeFile(
      GLOBAL_CONFIG_FILE,
      'box:\n  provider: docker\n  keyFromANewerAgentbox: keep-me\n',
    );

    await setConfigValue('global', 'box.withPlaywright', 'true', tmpCwd, { raw: true });

    const doc = parseYaml(await readFile(GLOBAL_CONFIG_FILE, 'utf8')) as {
      box: Record<string, unknown>;
    };
    expect(doc.box.keyFromANewerAgentbox).toBe('keep-me');
    expect(doc.box.withPlaywright).toBe(true);
    expect(doc.box.provider).toBe('docker');
  });

  it('config unset preserves it too', async () => {
    await writeFile(
      GLOBAL_CONFIG_FILE,
      'box:\n  provider: docker\n  withPlaywright: true\n  keyFromANewerAgentbox: keep-me\n',
    );

    await unsetConfigValue('global', 'box.withPlaywright', tmpCwd);

    const doc = parseYaml(await readFile(GLOBAL_CONFIG_FILE, 'utf8')) as {
      box: Record<string, unknown>;
    };
    expect(doc.box.keyFromANewerAgentbox).toBe('keep-me');
    expect(doc.box).not.toHaveProperty('withPlaywright');
  });

  it('an unknown top-level section survives too', async () => {
    await writeFile(GLOBAL_CONFIG_FILE, 'futureSection:\n  x: 1\nbox:\n  provider: docker\n');

    await setConfigValue('global', 'box.withPlaywright', 'true', tmpCwd, { raw: true });

    const doc = parseYaml(await readFile(GLOBAL_CONFIG_FILE, 'utf8')) as Record<
      string,
      Record<string, unknown>
    >;
    expect(doc.futureSection).toEqual({ x: 1 });
  });
});
