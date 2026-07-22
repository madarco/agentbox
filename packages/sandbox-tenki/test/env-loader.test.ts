import { describe, expect, it } from 'vitest';
import { parseEnvFile } from '../src/env-loader.js';

describe('parseEnvFile', () => {
  it('handles bare KEY=value', () => {
    expect(parseEnvFile('TENKI_AUTH_TOKEN=tk_abc')).toEqual({ TENKI_AUTH_TOKEN: 'tk_abc' });
  });

  it('handles double-quoted, single-quoted, and `export`-prefixed forms', () => {
    const body = ['TENKI_AUTH_TOKEN="quoted"', "TENKI_BASE_URL='single'", 'export FOO=bar'].join(
      '\n',
    );
    expect(parseEnvFile(body)).toEqual({
      TENKI_AUTH_TOKEN: 'quoted',
      TENKI_BASE_URL: 'single',
      FOO: 'bar',
    });
  });

  it('skips blank lines and comments', () => {
    const body = ['', '# header', 'TENKI_AUTH_TOKEN=tk_abc', '#trailing', ''].join('\n');
    expect(parseEnvFile(body)).toEqual({ TENKI_AUTH_TOKEN: 'tk_abc' });
  });

  it('ignores malformed lines (no = sign)', () => {
    expect(parseEnvFile('no_equals_here\nTENKI_AUTH_TOKEN=tk_abc')).toEqual({
      TENKI_AUTH_TOKEN: 'tk_abc',
    });
  });

  it('preserves = signs inside values', () => {
    expect(parseEnvFile('TENKI_AUTH_TOKEN=ab=cd=ef')).toEqual({ TENKI_AUTH_TOKEN: 'ab=cd=ef' });
  });
});
