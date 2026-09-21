import { describe, expect, it } from 'vitest';
import {
  gateOutcome,
  sessionProbeOrigin,
  type CookieEvidence,
  type GateInput,
} from '../lib/session-gate';

// The hub's whole security boundary. `proxy.ts` is the only gate in front of ~80
// /api/v1 route handlers, none of which check identity themselves, and a control
// box holds agent credentials, per-box SSH PRIVATE keys and the owner's git token.
// These tests exist so a future refactor of the middleware can't quietly go back
// to trusting a cookie's mere presence — which is exactly what it did before.

const NOW = 1_700_000_000_000;

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    mode: 'password',
    surface: 'api',
    publicPath: false,
    bearerApiKeyOk: false,
    hubTokenOk: false,
    hubTokenFromQuery: false,
    evidence: { kind: 'absent' },
    probe: 'skipped',
    now: NOW,
    ...over,
  };
}

const cached = (expiresAt: number): CookieEvidence => ({
  kind: 'cached',
  sessionExpiresAt: expiresAt,
});

describe('gateOutcome — password profile (a deployed control box)', () => {
  describe('THE invariant: a present cookie is never a valid cookie', () => {
    it('a cookie that fails the crypto check is escalated, never allowed', () => {
      // `unverified` means "a session cookie is there, but nothing about it has
      // been proven" — the exact state the old gate treated as authorized.
      const out = gateOutcome(input({ evidence: { kind: 'unverified' } }));
      expect(out).toEqual({ kind: 'probe' });
      expect(out.kind).not.toBe('allow');
    });

    it('and once the session store has answered, a forged cookie is refused', () => {
      for (const probe of ['invalid', 'error'] as const) {
        expect(gateOutcome(input({ evidence: { kind: 'unverified' }, probe }))).toEqual({
          kind: 'api-401',
        });
      }
    });

    it('never allows on any combination that lacks proof', () => {
      const evidences: CookieEvidence[] = [
        { kind: 'absent' },
        { kind: 'unverified' },
        cached(NOW - 1), // expired
      ];
      for (const evidence of evidences) {
        for (const probe of ['skipped', 'invalid', 'error'] as const) {
          for (const surface of ['api', 'page'] as const) {
            expect(gateOutcome(input({ evidence, probe, surface })).kind).not.toBe('allow');
          }
        }
      }
    });
  });

  it('a verified, unexpired cache cookie authorizes without touching the session store', () => {
    expect(gateOutcome(input({ evidence: cached(NOW + 60_000) }))).toEqual({ kind: 'allow' });
  });

  it('an expired cache cookie escalates instead of allowing', () => {
    expect(gateOutcome(input({ evidence: cached(NOW - 1) }))).toEqual({ kind: 'probe' });
    expect(gateOutcome(input({ evidence: cached(NOW) }))).toEqual({ kind: 'probe' });
  });

  it('a valid probe authorizes (the cookie-cache lapsed, the session is real)', () => {
    expect(gateOutcome(input({ evidence: { kind: 'unverified' }, probe: 'valid' }))).toEqual({
      kind: 'allow',
    });
  });

  it('a session store that is down, unreachable or not yet migrated DENIES', () => {
    // `error` covers the cold-start window between the socket opening and the auth
    // tables existing, a probe timeout, and a 5xx. None of them may fall open.
    expect(gateOutcome(input({ evidence: { kind: 'unverified' }, probe: 'error' }))).toEqual({
      kind: 'api-401',
    });
  });

  it('no cookie at all denies without a probe — unauthenticated traffic cannot amplify', () => {
    expect(gateOutcome(input({ evidence: { kind: 'absent' } }))).toEqual({ kind: 'api-401' });
    expect(gateOutcome(input({ evidence: { kind: 'absent' }, surface: 'page' }))).toEqual({
      kind: 'signin-redirect',
    });
  });

  describe('the headless Bearer key (tray / CLI against a control box)', () => {
    it('authorizes the API surface with no cookie work at all', () => {
      expect(gateOutcome(input({ bearerApiKeyOk: true }))).toEqual({ kind: 'allow' });
    });

    it('but still cannot reach the UI — a leaked key is not a login', () => {
      expect(gateOutcome(input({ bearerApiKeyOk: true, surface: 'page' }))).toEqual({
        kind: 'signin-redirect',
      });
    });
  });

  it('deny answers JSON on the API surface and a redirect on pages', () => {
    // A non-browser client cannot follow a /signin redirect, so the surface split
    // is what keeps the tray working against a signed-out hub.
    expect(gateOutcome(input({ surface: 'api' }))).toEqual({ kind: 'api-401' });
    expect(gateOutcome(input({ surface: 'page' }))).toEqual({ kind: 'signin-redirect' });
  });

  it('the public API paths need no credentials', () => {
    expect(gateOutcome(input({ publicPath: true }))).toEqual({ kind: 'allow' });
  });

  it('a public PATH on the page surface is still gated (publicPath is an API concept)', () => {
    expect(gateOutcome(input({ publicPath: true, surface: 'page' }))).toEqual({
      kind: 'signin-redirect',
    });
  });
});

describe('gateOutcome — locked (a deployed hub with no BETTER_AUTH_SECRET)', () => {
  it('refuses everything with 503 rather than serving an open hub', () => {
    // Reachable today by cancelling the login prompt during `hub setup`/`hub deploy`.
    // Falling back to "no auth" there is how a public control box ends up wide open.
    for (const surface of ['api', 'page'] as const) {
      expect(gateOutcome(input({ mode: 'locked', surface }))).toEqual({ kind: 'misconfigured' });
    }
  });

  it('not even the API key or a valid session gets through', () => {
    expect(gateOutcome(input({ mode: 'locked', bearerApiKeyOk: true }))).toEqual({
      kind: 'misconfigured',
    });
    expect(gateOutcome(input({ mode: 'locked', evidence: cached(NOW + 60_000) }))).toEqual({
      kind: 'misconfigured',
    });
    expect(gateOutcome(input({ mode: 'locked', publicPath: true }))).toEqual({
      kind: 'misconfigured',
    });
  });
});

describe('gateOutcome — token profile (a plain local hub): unchanged behaviour', () => {
  const t = (over: Partial<GateInput> = {}) => input({ mode: 'token', ...over });

  it('a matching ?token= on a page sets the cookie and redirects to the clean URL', () => {
    expect(gateOutcome(t({ surface: 'page', hubTokenOk: true, hubTokenFromQuery: true }))).toEqual({
      kind: 'token-handshake',
    });
  });

  it('the handshake is page-only — an API client sends a Bearer instead', () => {
    expect(gateOutcome(t({ surface: 'api', hubTokenOk: true, hubTokenFromQuery: true }))).toEqual({
      kind: 'allow',
    });
  });

  it('a matching cookie or bearer authorizes both surfaces', () => {
    expect(gateOutcome(t({ hubTokenOk: true }))).toEqual({ kind: 'allow' });
    expect(gateOutcome(t({ hubTokenOk: true, surface: 'page' }))).toEqual({ kind: 'allow' });
  });

  it('no match is a plaintext 401 on pages and JSON on the API', () => {
    expect(gateOutcome(t({ surface: 'page' }))).toEqual({ kind: 'token-locked' });
    expect(gateOutcome(t({ surface: 'api' }))).toEqual({ kind: 'api-401' });
  });

  it('a better-auth session cookie means nothing here', () => {
    // The token profile has no better-auth store at all; only the hub token counts.
    expect(gateOutcome(t({ evidence: cached(NOW + 60_000), surface: 'page' }))).toEqual({
      kind: 'token-locked',
    });
  });

  it('the public API paths need no credentials', () => {
    expect(gateOutcome(t({ publicPath: true }))).toEqual({ kind: 'allow' });
  });
});

describe('gateOutcome — off (the operator disabled the gate)', () => {
  it('allows everything, including with no cookie', () => {
    expect(gateOutcome(input({ mode: 'off' }))).toEqual({ kind: 'allow' });
    expect(gateOutcome(input({ mode: 'off', surface: 'page' }))).toEqual({ kind: 'allow' });
  });
});

describe('sessionProbeOrigin', () => {
  it('embedded profiles probe loopback on their own port, never the request origin', () => {
    // Behind Caddy the request origin is the public https name, so probing it would
    // make authorization depend on the VPS resolving its own DNS and trusting its
    // own certificate — and every failure there is a fail-closed total lockout.
    expect(
      sessionProbeOrigin({
        profile: 'hetzner',
        requestOrigin: 'https://116.203.220.73.sslip.io',
        hubPort: '8787',
      }),
    ).toBe('http://127.0.0.1:8787');
    expect(
      sessionProbeOrigin({ profile: 'localhost', requestOrigin: 'http://x', hubPort: '9999' }),
    ).toBe('http://127.0.0.1:9999');
  });

  it('falls back to the default port when the env is unset or junk', () => {
    for (const hubPort of [undefined, '', 'nope', '0', '-1']) {
      expect(sessionProbeOrigin({ profile: 'hetzner', requestOrigin: 'http://x', hubPort })).toBe(
        'http://127.0.0.1:8787',
      );
    }
  });

  it('vercel has no long-lived process to loop back to, so it uses the request origin', () => {
    expect(
      sessionProbeOrigin({
        profile: 'vercel',
        requestOrigin: 'https://hub.vercel.app',
        hubPort: '8787',
      }),
    ).toBe('https://hub.vercel.app');
  });
});
