import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { mergeConfigYaml, setConfigValue } from '../src/write.js';
import { parseUserConfig } from '../src/parse.js';
import { UserConfigError } from '../src/types.js';

/**
 * `mergeConfigYaml` exists so a caller holding a config file that isn't on this
 * machine can set one key in it — specifically the hetzner control-plane deploy
 * writing `box.claudeInstall` into the VPS's config. The hub writes that same
 * file itself (`box.remoteDockerHost` from the Settings UI), so preserving
 * unrelated keys is the property that actually matters here: losing it silently
 * drops the control box's own settings on every redeploy.
 */
describe('mergeConfigYaml', () => {
  it('sets a key into an empty body', () => {
    const out = mergeConfigYaml('', 'box.claudeInstall', 'npm');
    expect(parseUserConfig(out, '<t>').box?.claudeInstall).toBe('npm');
  });

  it('preserves unrelated keys the hub wrote itself', () => {
    const existing = 'schema: 1\nbox:\n  remoteDockerHost: my-server\n';
    const out = mergeConfigYaml(existing, 'box.claudeInstall', 'npm');
    const parsed = parseUserConfig(out, '<t>');
    expect(parsed.box?.remoteDockerHost).toBe('my-server');
    expect(parsed.box?.claudeInstall).toBe('npm');
  });

  it('preserves keys outside the branch being written', () => {
    const existing = 'schema: 1\nrelay:\n  controlPlaneUrl: https://plane.example\n';
    const out = mergeConfigYaml(existing, 'box.claudeInstall', 'npm');
    const parsed = parseUserConfig(out, '<t>');
    expect(parsed.relay?.controlPlaneUrl).toBe('https://plane.example');
    expect(parsed.box?.claudeInstall).toBe('npm');
  });

  it('overwrites an existing value rather than duplicating it', () => {
    const out = mergeConfigYaml('box:\n  claudeInstall: native\n', 'box.claudeInstall', 'npm');
    expect(parseUserConfig(out, '<t>').box?.claudeInstall).toBe('npm');
    expect(out.match(/claudeInstall/g)).toHaveLength(1);
  });

  it('stamps the schema on a body that had none', () => {
    const out = mergeConfigYaml('', 'box.claudeInstall', 'npm');
    expect(parseUserConfig(out, '<t>').schema).toBe(1);
  });

  it('is idempotent — merging the same value twice is a no-op', () => {
    const once = mergeConfigYaml('', 'box.claudeInstall', 'npm');
    expect(mergeConfigYaml(once, 'box.claudeInstall', 'npm')).toBe(once);
  });

  it('rejects an unknown key', () => {
    expect(() => mergeConfigYaml('', 'box.nonsense', 'x')).toThrow(UserConfigError);
  });

  it('rejects a body whose top level is not a mapping', () => {
    expect(() => mergeConfigYaml('- a\n- b\n', 'box.claudeInstall', 'npm')).toThrow(UserConfigError);
  });
});

describe('setConfigValue (unchanged by the shared-merge refactor)', () => {
  it('still merges into an existing file rather than replacing it', async () => {
    // The refactor routed both through one parse; pin that the on-disk path
    // still preserves neighbours exactly as before.
    await setConfigValue('global', 'box.remoteDockerHost', 'my-server', process.cwd(), {
      raw: true,
    });
    const { path } = await setConfigValue('global', 'box.claudeInstall', 'npm', process.cwd(), {
      raw: true,
    });
    const parsed = parseUserConfig(await readFile(path, 'utf8'), path);
    expect(parsed.box?.remoteDockerHost).toBe('my-server');
    expect(parsed.box?.claudeInstall).toBe('npm');
  });
});
