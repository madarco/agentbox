import { describe, expect, it } from 'vitest';
import { parseEnvFile } from '../src/env-loader.js';

describe('parseEnvFile', () => {
  it('parses bare KEY=value', () => {
    expect(parseEnvFile('VERCEL_TOKEN=abc')).toEqual({ VERCEL_TOKEN: 'abc' });
  });

  it('strips surrounding single and double quotes', () => {
    expect(parseEnvFile('A="x y"\nB=\'z\'')).toEqual({ A: 'x y', B: 'z' });
  });

  it('honors the export prefix', () => {
    expect(parseEnvFile('export VERCEL_OIDC_TOKEN=tok')).toEqual({ VERCEL_OIDC_TOKEN: 'tok' });
  });

  it('ignores comments and blank lines', () => {
    expect(parseEnvFile('# comment\n\nK=v\n')).toEqual({ K: 'v' });
  });

  it('ignores lines without a key', () => {
    expect(parseEnvFile('=novalue\njust-a-word')).toEqual({});
  });
});
