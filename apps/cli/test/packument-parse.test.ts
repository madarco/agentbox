import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NPM_REGISTRY, packumentUrl, parsePackument } from '../src/lib/npm-packument.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, '_fixtures', name), 'utf8'));

describe('packumentUrl', () => {
  it('percent-encodes a scoped name, which is a 404 raw', () => {
    expect(packumentUrl('@tenkicloud/agentbox-provider')).toBe(
      `${DEFAULT_NPM_REGISTRY}/@tenkicloud%2Fagentbox-provider`,
    );
  });

  it('leaves an unscoped name alone', () => {
    expect(packumentUrl('agentbox-provider-islo')).toBe(
      `${DEFAULT_NPM_REGISTRY}/agentbox-provider-islo`,
    );
  });

  it('accepts a custom registry with or without a trailing slash', () => {
    expect(packumentUrl('x', 'http://localhost:4873')).toBe('http://localhost:4873/x');
    expect(packumentUrl('x', 'http://localhost:4873/')).toBe('http://localhost:4873/x');
  });
});

describe('parsePackument', () => {
  it('reads the real tenki document', () => {
    const p = parsePackument(fixture('packument-tenki.json'));
    expect(p).not.toBeNull();
    expect(p?.distTags['latest']).toBe('0.1.1');
    expect(p?.versions.map((v) => v.version).sort()).toEqual(['0.1.0', '0.1.1']);
    // The field the whole feature turns on, and the one the abbreviated
    // packument would have stripped.
    expect(p?.versions.every((v) => v.providerApiVersion === 2)).toBe(true);
    expect(p?.versions.find((v) => v.version === '0.1.1')?.sdkRange).toBe('^2');
  });

  it('reads the real islo document', () => {
    const p = parsePackument(fixture('packument-islo.json'));
    expect(p?.versions).toHaveLength(1);
    expect(p?.versions[0]).toMatchObject({
      version: '0.1.0',
      providerApiVersion: 2,
      sdkRange: '^2.1.0',
    });
  });

  it('normalises npm deprecation (a string reason) to a boolean', () => {
    const p = parsePackument({
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { deprecated: 'use v2', agentbox: { providerApiVersion: 4 } } },
    });
    expect(p?.versions[0]?.deprecated).toBe(true);
  });

  it('omits the fields a publish simply does not carry', () => {
    const p = parsePackument({ versions: { '1.0.0': {} } });
    expect(p?.versions[0]).toEqual({ version: '1.0.0' });
  });

  it('skips a malformed version entry instead of losing the package', () => {
    const p = parsePackument({
      versions: { '1.0.0': null, '1.1.0': { agentbox: { providerApiVersion: 4 } } },
    });
    expect(p?.versions.map((v) => v.version)).toEqual(['1.1.0']);
  });

  it.each([null, 'nope', 42, [], {}, { versions: 'no' }])('rejects %j', (body) => {
    expect(parsePackument(body)).toBeNull();
  });

  it('tolerates a document with no dist-tags', () => {
    expect(parsePackument({ versions: { '1.0.0': {} } })?.distTags).toEqual({});
  });
});
