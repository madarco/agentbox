import { describe, expect, it } from 'vitest';
import { buildCpArgv, cpFlags, normalizeCpParams } from '../src/cp-rpc.js';

const idHost = (p: string) => p; // identity resolver for argv-shape assertions

describe('normalizeCpParams', () => {
  it('passes through the new {sources, dest} shape', () => {
    expect(normalizeCpParams('cp.toHost', { sources: ['/a', '/b'], dest: './out/' })).toEqual({
      sources: ['/a', '/b'],
      dest: './out/',
    });
  });

  it('derives sources/dest from the legacy toHost {boxPath, hostPath}', () => {
    expect(normalizeCpParams('cp.toHost', { boxPath: '/a', hostPath: './out' })).toEqual({
      sources: ['/a'],
      dest: './out',
    });
  });

  it('derives sources/dest from the legacy fromHost {boxPath, hostPath}', () => {
    // fromHost: host is the source, box is the destination.
    expect(normalizeCpParams('cp.fromHost', { boxPath: '/dst', hostPath: './a' })).toEqual({
      sources: ['./a'],
      dest: '/dst',
    });
  });

  it('throws on a payload with neither shape', () => {
    expect(() => normalizeCpParams('cp.toHost', {})).toThrow(/non-empty \{sources\}/);
    expect(() => normalizeCpParams('cp.toHost', { boxPath: '/a' })).toThrow(/non-empty \{sources\}/);
  });
});

describe('cpFlags', () => {
  it('forwards excludes, no-default-excludes, and yes', () => {
    expect(
      cpFlags({ sources: ['/a'], dest: '/d', exclude: ['*/cache', '.git'], defaultExcludes: false, yes: true }),
    ).toEqual(['--exclude', '*/cache', '--exclude', '.git', '--no-default-excludes', '--yes']);
  });

  it('emits nothing when no flags are set', () => {
    expect(cpFlags({ sources: ['/a'], dest: '/d' })).toEqual([]);
  });
});

describe('buildCpArgv', () => {
  it('toHost: box sources get the <name>: prefix, host dest is resolved', () => {
    const { argv, detail, contextArgv } = buildCpArgv({
      method: 'cp.toHost',
      boxName: 'mybox',
      sources: ['/workspace/a.log', '/workspace/b.log'],
      dest: './out/',
      resolveHost: () => '/abs/out/',
      flags: [],
    });
    expect(argv).toEqual(['cp', 'mybox:/workspace/a.log', 'mybox:/workspace/b.log', '/abs/out/']);
    expect(detail).toBe('/workspace/a.log, /workspace/b.log -> /abs/out/');
    expect(contextArgv).toEqual(['/workspace/a.log', '/workspace/b.log', '/abs/out/']);
  });

  it('fromHost: host sources are resolved, box dest gets the <name>: prefix', () => {
    const { argv } = buildCpArgv({
      method: 'cp.fromHost',
      boxName: 'mybox',
      sources: ['a.txt', 'b.txt'],
      dest: '/workspace/dest/',
      resolveHost: (p) => `/abs/${p}`,
      flags: ['--exclude', '.git'],
    });
    expect(argv).toEqual([
      'cp',
      '/abs/a.txt',
      '/abs/b.txt',
      'mybox:/workspace/dest/',
      '--exclude',
      '.git',
    ]);
  });

  it('the excludes the consent prompt advertises actually reach the argv (regression: cloud used to drop them)', () => {
    const params = { sources: ['/a'], dest: './out/', exclude: ['node_modules'] };
    const { argv } = buildCpArgv({
      method: 'cp.toHost',
      boxName: 'b',
      sources: params.sources,
      dest: params.dest,
      resolveHost: idHost,
      flags: cpFlags(params),
    });
    expect(argv).toContain('--exclude');
    expect(argv).toContain('node_modules');
  });
});
