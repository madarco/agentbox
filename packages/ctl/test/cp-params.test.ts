import { describe, expect, it } from 'vitest';
import { buildCpParams, type CpCliOptions } from '../src/commands/cp.js';

const opts = { exclude: [] } as unknown as CpCliOptions;

describe('buildCpParams', () => {
  it('resolves the box destination of fromHost against the cwd it was typed in', () => {
    expect(buildCpParams('fromHost', ['data.csv', '.'], opts, '/workspace/web')).toMatchObject({
      sources: ['data.csv'],
      dest: '/workspace/web/',
    });
    expect(buildCpParams('fromHost', ['a', 'b', 'out/'], opts, '/workspace').dest).toBe(
      '/workspace/out/',
    );
  });

  it('resolves the box sources of toHost and leaves the host destination as typed', () => {
    expect(
      buildCpParams('toHost', ['dist/app.js', './out/'], opts, '/workspace/web'),
    ).toMatchObject({
      sources: ['/workspace/web/dist/app.js'],
      dest: './out/',
    });
  });

  it('leaves absolute box paths alone', () => {
    expect(buildCpParams('fromHost', ['x', '/tmp/in'], opts, '/workspace').dest).toBe('/tmp/in');
  });

  it('keeps the destination a directory: `.`, `..`, a typed slash, or an existing dir (sign-off of #426)', () => {
    // The exact case that deleted /workspace/README.md: `cd s7 && cp fromHost ./README.md .`
    expect(buildCpParams('fromHost', ['./README.md', '.'], opts, '/workspace/s7').dest).toBe(
      '/workspace/s7/',
    );
    expect(buildCpParams('fromHost', ['x', '..'], opts, '/workspace/s7').dest).toBe('/workspace/');
    expect(buildCpParams('fromHost', ['x', 'sub/.'], opts, '/workspace').dest).toBe(
      '/workspace/sub/',
    );
    const dirs = new Set(['/workspace/existing']);
    const isDirectory = (p: string) => dirs.has(p);
    expect(
      buildCpParams('fromHost', ['x', 'existing'], opts, '/workspace', { isDirectory }).dest,
    ).toBe('/workspace/existing/');
    // A name that does not exist stays a target FILE path (rename on copy).
    expect(
      buildCpParams('fromHost', ['x', 'new-name.csv'], opts, '/workspace', { isDirectory }).dest,
    ).toBe('/workspace/new-name.csv');
  });
});
