import { describe, expect, it } from 'vitest';
import { parseEnvFile } from '../src/env-loader.js';

describe('parseEnvFile', () => {
  it('parses basic KEY=value', () => {
    expect(parseEnvFile('FOO=bar\nBAZ=qux\n')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('handles `export KEY=value`', () => {
    expect(parseEnvFile('export DIGITALOCEAN_TOKEN=secret\n')).toEqual({ DIGITALOCEAN_TOKEN: 'secret' });
  });

  it('strips surrounding double and single quotes', () => {
    expect(
      parseEnvFile(`A="with spaces"\nB='with $special'`),
    ).toEqual({ A: 'with spaces', B: 'with $special' });
  });

  it('skips blank lines and # comments', () => {
    const body = '# leading\nFOO=1\n\n# trailing\nBAR=2\n';
    expect(parseEnvFile(body)).toEqual({ FOO: '1', BAR: '2' });
  });

  it('does not do variable interpolation (predictable, opinionated)', () => {
    expect(parseEnvFile('FOO=$BAR\n')).toEqual({ FOO: '$BAR' });
  });

  it('ignores lines without an `=` past column 0', () => {
    expect(parseEnvFile('= no key\nNOEQ\n')).toEqual({});
  });
});
