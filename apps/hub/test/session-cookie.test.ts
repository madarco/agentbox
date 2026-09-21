import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readCookieEvidence } from '../lib/session-cookie';

// The crypto half of the gate. `getCookieCache` is what turns "a cookie is there"
// into "this hub signed it and it hasn't expired"; if it ever silently stopped
// verifying, the gate would be back to the presence check this change removed.
// These tests mint the cookie the way better-auth does (see `setCookieCache` in
// better-auth/dist/cookies/index.mjs) and then attack it.

const SECRET = 'test-better-auth-secret-0123456789';
const TOKEN_COOKIE = 'better-auth.session_token=some-session-token.signature';

/** Reproduces better-auth's `compact` cookie-cache encoding. */
function mintCacheCookie(opts: {
  secret?: string;
  sessionExpiresAt: Date;
  cacheExpiresAt?: number;
}): string {
  const sessionData = {
    session: {
      id: 's1',
      token: 'some-session-token',
      expiresAt: opts.sessionExpiresAt,
      userId: 'u1',
    },
    user: { id: 'u1', email: 'admin@example.com' },
    updatedAt: Date.now(),
    version: '1',
  };
  const expiresAt = opts.cacheExpiresAt ?? Date.now() + 5 * 60 * 1000;
  const signature = createHmac('sha256', opts.secret ?? SECRET)
    .update(JSON.stringify({ ...sessionData, expiresAt }))
    .digest('base64url');
  return Buffer.from(JSON.stringify({ session: sessionData, expiresAt, signature })).toString(
    'base64url',
  );
}

function headers(cookie: string): Headers {
  return new Headers({ cookie });
}

const hour = 60 * 60 * 1000;

describe('readCookieEvidence', () => {
  it('reports `absent` when there is no session cookie at all', async () => {
    await expect(
      readCookieEvidence(headers(''), { secret: SECRET, secureCookies: false }),
    ).resolves.toEqual({
      kind: 'absent',
    });
    await expect(
      readCookieEvidence(headers('unrelated=1'), { secret: SECRET, secureCookies: false }),
    ).resolves.toEqual({ kind: 'absent' });
  });

  it('verifies a well-formed cache cookie and reports the session expiry', async () => {
    const expires = new Date(Date.now() + hour);
    const data = mintCacheCookie({ sessionExpiresAt: expires });
    const ev = await readCookieEvidence(
      headers(`${TOKEN_COOKIE}; better-auth.session_data=${data}`),
      { secret: SECRET, secureCookies: false },
    );
    expect(ev.kind).toBe('cached');
    expect(ev.kind === 'cached' && ev.sessionExpiresAt).toBe(expires.getTime());
  });

  it('finds the cookie under either name, whatever cookieSecure() says', async () => {
    // better-auth's own `useSecureCookies` default follows NODE_ENV and overrides
    // `advanced.defaultCookieAttributes`, so a production hetzner hub issues
    // `__Secure-`-prefixed cookies while `cookieSecure()` is false. Guessing one
    // name would be a silent permanent cache miss — a probe on every request.
    const data = mintCacheCookie({ sessionExpiresAt: new Date(Date.now() + hour) });
    for (const secureCookies of [true, false]) {
      for (const name of ['better-auth.session_data', '__Secure-better-auth.session_data']) {
        const ev = await readCookieEvidence(headers(`${TOKEN_COOKIE}; ${name}=${data}`), {
          secret: SECRET,
          secureCookies,
        });
        expect(ev.kind).toBe('cached');
      }
    }
  });

  describe('everything unproven degrades to `unverified` — never to `cached`, never a throw', () => {
    const cases: Array<[string, () => Promise<unknown>]> = [
      [
        'a tampered signature',
        () => {
          const data = mintCacheCookie({ sessionExpiresAt: new Date(Date.now() + hour) });
          const broken = data.slice(0, -4) + (data.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
          return readCookieEvidence(
            headers(`${TOKEN_COOKIE}; better-auth.session_data=${broken}`),
            {
              secret: SECRET,
              secureCookies: false,
            },
          );
        },
      ],
      [
        'a cookie signed with a different secret',
        () =>
          readCookieEvidence(
            headers(
              `${TOKEN_COOKIE}; better-auth.session_data=${mintCacheCookie({ secret: 'attacker-secret', sessionExpiresAt: new Date(Date.now() + hour) })}`,
            ),
            { secret: SECRET, secureCookies: false },
          ),
      ],
      [
        'an expired session',
        () =>
          readCookieEvidence(
            headers(
              `${TOKEN_COOKIE}; better-auth.session_data=${mintCacheCookie({ sessionExpiresAt: new Date(Date.now() - hour) })}`,
            ),
            { secret: SECRET, secureCookies: false },
          ),
      ],
      [
        'a lapsed cache cookie',
        () =>
          readCookieEvidence(
            headers(
              `${TOKEN_COOKIE}; better-auth.session_data=${mintCacheCookie({ sessionExpiresAt: new Date(Date.now() + hour), cacheExpiresAt: Date.now() - 1000 })}`,
            ),
            { secret: SECRET, secureCookies: false },
          ),
      ],
      [
        'garbage that is not base64 at all',
        () =>
          readCookieEvidence(
            headers(`${TOKEN_COOKIE}; better-auth.session_data=%%%not-base64%%%`),
            {
              secret: SECRET,
              secureCookies: false,
            },
          ),
      ],
      [
        'a session token cookie with no cache cookie (the >5min steady state)',
        () => readCookieEvidence(headers(TOKEN_COOKIE), { secret: SECRET, secureCookies: false }),
      ],
      [
        'no secret configured (getCookieCache throws; we must not)',
        () =>
          readCookieEvidence(
            headers(
              `${TOKEN_COOKIE}; better-auth.session_data=${mintCacheCookie({ sessionExpiresAt: new Date(Date.now() + hour) })}`,
            ),
            { secret: undefined, secureCookies: false },
          ),
      ],
    ];

    for (const [name, run] of cases) {
      it(name, async () => {
        await expect(run()).resolves.toEqual({ kind: 'unverified' });
      });
    }
  });
});
