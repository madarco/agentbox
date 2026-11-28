import { describe, expect, it } from 'vitest';
import {
  dropOrphanAccountVolume,
  mergeAccountIdentity,
  parseVolumeFiles,
} from '../src/sync/account-login.js';
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
      mergeAccountIdentity({ email: 'a@b.c', org: 'Acme', plan: 'pro' }, { plan: 'max' }, true),
    ).toEqual({ email: 'a@b.c', org: 'Acme', plan: 'max' });
  });
  it("never keeps another subscription's email (sameLogin false, or plans differ)", () => {
    const stored = { email: 'a@b.c', org: 'Acme', plan: 'max' };
    expect(mergeAccountIdentity(stored, { plan: 'max' }, false)).toEqual({ plan: 'max' });
    // Cannot tell from the credentials: only a matching plan keeps the label.
    expect(mergeAccountIdentity(stored, { plan: 'pro' })).toEqual({ plan: 'pro' });
    expect(mergeAccountIdentity(stored, { plan: 'max' })).toEqual(stored);
  });

  it('a new email wins, and nothing new keeps the stored identity', () => {
    expect(mergeAccountIdentity({ email: 'old@x' }, { email: 'new@x' }, true)).toEqual({
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
    expect(dockerEnvByName(['-e', 'API_KEY=a=b']).env).toEqual({ API_KEY: 'a=b' });
  });
  it("leaves keys the host's docker client reads on the argv", () => {
    const r = dockerEnvByName([
      '-e',
      'DOCKER_HOST=unix:///x',
      '-e',
      'PATH=/bin',
      '-e',
      'TERM=xterm',
    ]);
    expect(r.env).toEqual({});
    expect(r.argv).toEqual(['-e', 'DOCKER_HOST=unix:///x', '-e', 'PATH=/bin', '-e', 'TERM=xterm']);
  });
});

describe('dropOrphanAccountVolume', () => {
  const tmp = async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const d = mkdtempSync(join(tmpdir(), 'agentbox-orphan-'));
    return { d, path: join(d, 'accounts.json') };
  };

  it('keeps the volume when accounts.json cannot be trusted (its rows read as none)', async () => {
    const { writeFileSync } = await import('node:fs');
    const { d, path } = await tmp();
    writeFileSync(path, '{not json');
    const removed: string[] = [];
    const r = await dropOrphanAccountVolume(
      'claude',
      'work',
      'vol-work',
      { path, stateDir: d },
      (v) => {
        removed.push(v);
        return Promise.resolve({ exitCode: 0 });
      },
    );
    expect(r).toBe(false);
    expect(removed).toEqual([]);
  });

  it('removes it when the store is fine and has no such account, retrying while in use', async () => {
    const { d, path } = await tmp();
    let calls = 0;
    const r = await dropOrphanAccountVolume(
      'claude',
      'work',
      'vol-work',
      { path, stateDir: d },
      () =>
        Promise.resolve(
          ++calls === 1 ? { exitCode: 1, stderr: 'volume is in use' } : { exitCode: 0 },
        ),
    );
    expect(r).toBe(true);
    expect(calls).toBe(2);
  }, 10_000);
});
