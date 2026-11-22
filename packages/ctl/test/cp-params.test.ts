import { describe, expect, it } from 'vitest';
import { buildCpParams, type CpCliOptions } from '../src/commands/cp.js';

const opts = { exclude: [] } as unknown as CpCliOptions;

describe('buildCpParams', () => {
  it('resolves the box destination of fromHost against the cwd it was typed in', () => {
    expect(buildCpParams('fromHost', ['data.csv', '.'], opts, '/workspace/web')).toMatchObject({
      sources: ['data.csv'],
      dest: '/workspace/web',
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
});
