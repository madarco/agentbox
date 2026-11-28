import { describe, expect, it } from 'vitest';
import { mergeAccountIdentity, parseVolumeFiles } from '../src/sync/account-login.js';
import { dockerEnvByName } from '../src/sync/agents/shared.js';

describe('parseVolumeFiles', () => {
  it('decodes present files and marks absent ones null', () => {
    const b64 = Buffer.from('{"a":1}\nline2', 'utf8').toString('base64');
    const out = parseVolumeFiles(`.credentials.json\t${b64}\n_claude.json\t-\n`, [
      '.credentials.json',
      '_claude.json',
    ]);
    expect(out).toEqual({ '.credentials.json': '{"a":1}\nline2', '_claude.json': null });
  });

  it('a file the read never reported is an error, not an absent file', () => {
    expect(() => parseVolumeFiles('', ['.credentials.json'])).toThrow(/returned nothing/);
  });
});

describe('mergeAccountIdentity', () => {
  it('keeps the stored email and org when a re-login reads a plan only', () => {
    expect(
      mergeAccountIdentity({ email: 'a@b.c', org: 'Acme', plan: 'pro' }, { plan: 'max' }),
    ).toEqual({ email: 'a@b.c', org: 'Acme', plan: 'max' });
  });
  it('a new email wins, and nothing new keeps the stored identity', () => {
    expect(mergeAccountIdentity({ email: 'old@x' }, { email: 'new@x' })).toEqual({
      email: 'new@x',
    });
    const stored = { email: 'a@b.c' };
    expect(mergeAccountIdentity(stored, undefined)).toBe(stored);
    expect(mergeAccountIdentity(undefined, { plan: 'max' })).toEqual({ plan: 'max' });
  });
});

describe('dockerEnvByName (#437-6)', () => {
  it('moves values off the argv, keeps blanks and everything after the image', () => {
    const r = dockerEnvByName(
      [
        'run',
        '-e',
        'CLAUDE_CODE_OAUTH_TOKEN=sk-secret',
        '-e',
        'OPENAI_API_KEY=',
        '-v',
        'a:b',
        'img',
        '-e',
        'X=y',
      ],
      'img',
    );
    expect(r.argv).toEqual([
      'run',
      '-e',
      'CLAUDE_CODE_OAUTH_TOKEN',
      '-e',
      'OPENAI_API_KEY=',
      '-v',
      'a:b',
      'img',
      '-e',
      'X=y',
    ]);
    expect(r.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-secret' });
    expect(r.argv.join(' ')).not.toContain('sk-secret');
  });
  it('keeps a value that itself contains =', () => {
    expect(dockerEnvByName(['-e', 'K=a=b']).env).toEqual({ K: 'a=b' });
  });
});
