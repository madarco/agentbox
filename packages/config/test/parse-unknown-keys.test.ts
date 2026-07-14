import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseUserConfig } from '../src/parse.js';
import { loadEffectiveConfig, setConfigWarningSink } from '../src/load.js';
import { UserConfigError } from '../src/types.js';

/**
 * Unknown keys must WARN, never throw. The parser is inlined into provider
 * plugins (the SDK bundles @agentbox/config), so a plugin pinned to an older SDK
 * reads the user's config with a stale key registry — a throw there breaks every
 * published plugin the moment we add a config key. See docs/provider-plugins.md.
 */
describe('unknown keys are warnings, not errors', () => {
  it('unknown leaf is skipped and reported', () => {
    const warnings: string[] = [];
    const out = parseUserConfig('box:\n  provider: docker\n  totallyNewKey: x\n', '<test>', {
      onWarning: (m) => warnings.push(m),
    });
    expect(out.box?.provider).toBe('docker');
    expect(out.box).not.toHaveProperty('totallyNewKey');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('unknown key "totallyNewKey"');
  });

  it('unknown top-level section is skipped and reported', () => {
    const warnings: string[] = [];
    const out = parseUserConfig('futureSection:\n  enabled: true\n', '<test>', {
      onWarning: (m) => warnings.push(m),
    });
    expect(out).not.toHaveProperty('futureSection');
    expect(warnings[0]).toContain('unknown config section "futureSection"');
  });

  it('regression: a key this parser predates does not abort the load', () => {
    // The live failure (2026-07-14): an islo create died mid-flight because the
    // plugin's bundled parser (SDK 2.2.0) had never heard of `box.daytonaVmBaseImage`,
    // added to the CLI two days after that SDK was cut. That key is in the
    // registry now, so the fixture uses a name no registry has — which is
    // precisely what any future key looks like to an already-published plugin.
    const warnings: string[] = [];
    const out = parseUserConfig(
      'box:\n  provider: docker\n  someKeyAddedNextRelease: ghcr.io/x/y:sha-abc\n',
      '<test>',
      { onWarning: (m) => warnings.push(m) },
    );
    expect(out.box?.provider).toBe('docker'); // the rest of the config still applies
    expect(warnings).toHaveLength(1);
  });

  it('parses clean with no sink registered (a plugin registers none)', () => {
    expect(() => parseUserConfig('box:\n  someFutureKey: 1\n', '<test>')).not.toThrow();
  });

  it('still throws on a wrong type', () => {
    expect(() => parseUserConfig('box:\n  withPlaywright: 7\n', '<test>')).toThrow(UserConfigError);
  });

  it('still throws on a renamed key (a real migration, not a forward-compat miss)', () => {
    expect(() => parseUserConfig('box:\n  snapshot: foo\n', '<test>')).toThrow(/renamed/);
  });
});

describe('loadEffectiveConfig surfaces warnings', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'agentbox-cfg-warn-'));
    await mkdir(join(homedir(), '.agentbox'), { recursive: true });
  });

  afterEach(async () => {
    setConfigWarningSink(null);
    await rm(cwd, { recursive: true, force: true });
    await rm(join(homedir(), '.agentbox'), { recursive: true, force: true });
  });

  it('collects warnings on LoadedConfig and emits them to the sink', async () => {
    await writeFile(
      join(homedir(), '.agentbox', 'config.yaml'),
      'box:\n  provider: docker\n  aKeyFromTheFuture: yes-please\n',
    );
    const emitted: string[] = [];
    setConfigWarningSink((m) => emitted.push(m));

    const r = await loadEffectiveConfig(cwd);

    expect(r.effective.box.provider).toBe('docker');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('aKeyFromTheFuture');
    expect(emitted).toEqual(r.warnings);
  });

  it('warnings is empty on a clean config', async () => {
    await writeFile(join(homedir(), '.agentbox', 'config.yaml'), 'box:\n  provider: docker\n');
    const r = await loadEffectiveConfig(cwd);
    expect(r.warnings).toEqual([]);
  });
});
