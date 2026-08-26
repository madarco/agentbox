import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseUserConfig, parseUserConfigObject, setConfigValue } from '../src/index.js';

/**
 * `box.provider: docker:<host>` is INPUT sugar. What gets stored is the pair
 * `box.provider` (a bare ProviderKind) + `box.remoteDockerHost`, so nothing
 * downstream has to re-split a config value and the type stays closed.
 */
describe('box.provider spec desugaring', () => {
  const parse = (yaml: string) => {
    const warnings: string[] = [];
    const out = parseUserConfig(yaml, '<test>', { onWarning: (m) => warnings.push(m) });
    return { box: out.box, warnings };
  };

  it('splits docker:<alias> into provider + remoteDockerHost', () => {
    const { box, warnings } = parse('box:\n  provider: docker:hub\n');
    expect(box).toEqual({ provider: 'remote-docker', remoteDockerHost: 'hub' });
    expect(warnings).toEqual([]);
  });

  it('splits the remote-docker: spelling the same way', () => {
    expect(parse('box:\n  provider: remote-docker:buildbox\n').box).toEqual({
      provider: 'remote-docker',
      remoteDockerHost: 'buildbox',
    });
  });

  it('keeps a user@host:port destination intact', () => {
    expect(parse('box:\n  provider: docker:dev@10.0.0.9:2222\n').box).toEqual({
      provider: 'remote-docker',
      remoteDockerHost: 'dev@10.0.0.9:2222',
    });
  });

  it('leaves a bare provider name alone', () => {
    expect(parse('box:\n  provider: e2b\n').box).toEqual({ provider: 'e2b' });
    expect(parse('box:\n  provider: remote-docker\n').box).toEqual({ provider: 'remote-docker' });
  });

  it('leaves an explicit remoteDockerHost alone when the provider is bare', () => {
    expect(parse('box:\n  provider: remote-docker\n  remoteDockerHost: buildbox\n').box).toEqual({
      provider: 'remote-docker',
      remoteDockerHost: 'buildbox',
    });
  });

  it('the spec wins over a conflicting remoteDockerHost in the same file, loudly', () => {
    const { box, warnings } = parse('box:\n  provider: docker:hub\n  remoteDockerHost: other\n');
    // The spec has always beaten the configured default on the CLI; keep that,
    // but never silently — the losing key looks live in the file.
    expect(box).toEqual({ provider: 'remote-docker', remoteDockerHost: 'hub' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('remoteDockerHost');
  });

  it('does not warn when the two agree', () => {
    expect(parse('box:\n  provider: docker:hub\n  remoteDockerHost: hub\n').warnings).toEqual([]);
  });

  it('applies to an agentbox.yaml defaults: block too', () => {
    const out = parseUserConfigObject({ box: { provider: 'docker:hub' } }, '<defaults>');
    expect(out.box).toEqual({ provider: 'remote-docker', remoteDockerHost: 'hub' });
  });

  it('still rejects a provider that is neither a name nor a docker spec', () => {
    expect(() => parseUserConfig('box:\n  provider: hetzner:nbg1\n', '<test>')).toThrow();
    expect(() => parseUserConfig('box:\n  provider: docker:\n', '<test>')).toThrow();
  });
});

describe('setConfigValue writes the pair', () => {
  it('box.provider=docker:hub lands as two leaves and round-trips', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentbox-desugar-'));
    const prev = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      const r = await setConfigValue('global', 'box.provider', 'docker:hub', home, { raw: true });
      expect(r.written).toEqual([
        { key: 'box.provider', value: 'remote-docker' },
        { key: 'box.remoteDockerHost', value: 'hub' },
      ]);
      const doc = parseYaml(readFileSync(r.path, 'utf8')) as { box: Record<string, string> };
      expect(doc.box.provider).toBe('remote-docker');
      expect(doc.box.remoteDockerHost).toBe('hub');
      // What we write must parse back to exactly what we wrote — no second desugar.
      expect(parseUserConfig(readFileSync(r.path, 'utf8'), r.path).box).toMatchObject({
        provider: 'remote-docker',
        remoteDockerHost: 'hub',
      });
    } finally {
      if (prev === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prev;
    }
  });

  it('a bare provider name writes exactly one leaf', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentbox-desugar-'));
    const prev = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      const r = await setConfigValue('global', 'box.provider', 'e2b', home, { raw: true });
      expect(r.written).toEqual([{ key: 'box.provider', value: 'e2b' }]);
    } finally {
      if (prev === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prev;
    }
  });
});
