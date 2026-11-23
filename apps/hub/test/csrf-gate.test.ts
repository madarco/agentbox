import { describe, expect, it } from 'vitest';
import { csrfOutcome, gateCredential, type GateInput } from '../lib/session-gate';

// A docker box's web URL is http://127.0.0.1:<port> — the same SITE as a local hub
// on 127.0.0.1:8787, so the SameSite=Lax hub cookie rides along on a POST a page
// in the box sends. These pin that such a write is refused while the hub's own
// pages and every Bearer caller keep working.

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    mode: 'token',
    surface: 'api',
    publicPath: false,
    bearerApiKeyOk: false,
    hubTokenOk: true,
    hubTokenFromQuery: false,
    evidence: { kind: 'absent' },
    probe: 'skipped',
    now: 0,
    ...over,
  };
}

const HUB = '127.0.0.1:8787';
const write = {
  method: 'POST',
  host: HUB,
  origin: null as string | null,
  secFetchSite: null as string | null,
  contentType: 'application/json' as string | null,
  hasBody: true,
  surface: 'api' as const,
};

describe('gateCredential', () => {
  it('names the token source on the local hub', () => {
    expect(gateCredential(input({ hubTokenVia: 'bearer' }))).toBe('bearer');
    expect(gateCredential(input({ hubTokenVia: 'query' }))).toBe('query');
    expect(gateCredential(input({ hubTokenVia: 'cookie' }))).toBe('cookie');
    expect(gateCredential(input({ hubTokenOk: false }))).toBe('none');
  });

  it('treats the API key and a device token as bearer, a session as cookie', () => {
    const pw = { mode: 'password' as const, hubTokenOk: false };
    expect(gateCredential(input({ ...pw, bearerApiKeyOk: true }))).toBe('bearer');
    expect(gateCredential(input({ ...pw, deviceId: 'd1' }))).toBe('bearer');
    expect(
      gateCredential(input({ ...pw, evidence: { kind: 'cached', sessionExpiresAt: 1 } })),
    ).toBe('cookie');
  });

  it('an open hub has no credential to forge', () => {
    expect(gateCredential(input({ mode: 'off' }))).toBe('none');
  });
});

describe('csrfOutcome', () => {
  it("refuses a cookie POST from a box's web port (same site, other origin)", () => {
    expect(
      csrfOutcome({
        ...write,
        credential: 'cookie',
        origin: 'http://127.0.0.1:32768',
        secFetchSite: 'same-site',
      }),
    ).toBe('cross-site');
    // An older browser without Sec-Fetch-*: the Origin host decides.
    expect(csrfOutcome({ ...write, credential: 'cookie', origin: 'http://127.0.0.1:32768' })).toBe(
      'cross-site',
    );
  });

  it('refuses a cookie POST with no provenance at all, or Origin: null', () => {
    expect(csrfOutcome({ ...write, credential: 'cookie' })).toBe('cross-site');
    expect(csrfOutcome({ ...write, credential: 'cookie', origin: 'null' })).toBe('cross-site');
  });

  it("allows the hub's own pages", () => {
    expect(csrfOutcome({ ...write, credential: 'cookie', secFetchSite: 'same-origin' })).toBe('ok');
    expect(csrfOutcome({ ...write, credential: 'cookie', origin: `http://${HUB}` })).toBe('ok');
    // Behind Caddy: the browser's Origin is the public name, as is the Host.
    expect(
      csrfOutcome({
        ...write,
        credential: 'cookie',
        host: 'hub.example.com',
        origin: 'https://hub.example.com',
      }),
    ).toBe('ok');
  });

  it('refuses a same-origin cookie write whose body is not JSON (a simple request)', () => {
    expect(
      csrfOutcome({
        ...write,
        credential: 'cookie',
        secFetchSite: 'same-origin',
        contentType: 'text/plain;charset=UTF-8',
      }),
    ).toBe('not-json');
    expect(
      csrfOutcome({
        ...write,
        credential: 'cookie',
        secFetchSite: 'same-origin',
        contentType: 'application/json; charset=utf-8',
      }),
    ).toBe('ok');
    // A body-less action (start/stop) has no content type to check.
    expect(
      csrfOutcome({
        ...write,
        credential: 'cookie',
        secFetchSite: 'same-origin',
        contentType: null,
        hasBody: false,
      }),
    ).toBe('ok');
  });

  it('never touches reads or Bearer callers (CLI, tray)', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(
        csrfOutcome({ ...write, method, credential: 'cookie', origin: 'http://evil.test' }),
      ).toBe('ok');
    }
    expect(csrfOutcome({ ...write, credential: 'bearer', contentType: 'text/plain' })).toBe('ok');
    expect(csrfOutcome({ ...write, credential: 'query' })).toBe('ok');
    // Auth off: a non-browser caller (no provenance headers) is unaffected.
    expect(csrfOutcome({ ...write, credential: 'none', contentType: 'text/plain' })).toBe('ok');
  });

  it('with auth off, still refuses a cross-site browser page', () => {
    expect(
      csrfOutcome({
        ...write,
        credential: 'none',
        origin: 'http://127.0.0.1:32768',
        secFetchSite: 'same-site',
        contentType: 'text/plain',
      }),
    ).toBe('cross-site');
    expect(csrfOutcome({ ...write, credential: 'none', secFetchSite: 'same-origin' })).toBe('ok');
  });

  it('normalizes a proxied host: first X-Forwarded-Host entry, default port dropped', () => {
    const cookie = { ...write, credential: 'cookie' as const, origin: 'https://hub.example.com' };
    expect(csrfOutcome({ ...cookie, host: 'hub.example.com, 10.0.0.2:8787' })).toBe('ok');
    expect(csrfOutcome({ ...cookie, host: 'hub.example.com:443' })).toBe('ok');
    expect(csrfOutcome({ ...cookie, host: 'hub.example.com:8443' })).toBe('cross-site');
  });

  it('lets a same-origin Next server action through (text/plain body, page route)', () => {
    // Next 16 posts a server action as a string body with no content type, so
    // the browser sends text/plain; requiring JSON there broke every UI write.
    const action = {
      ...write,
      credential: 'cookie' as const,
      surface: 'page' as const,
      contentType: 'text/plain;charset=UTF-8',
      secFetchSite: 'same-origin',
      origin: `http://${HUB}`,
    };
    expect(csrfOutcome(action)).toBe('ok');
    // ...but a page-route write from a box's web port is still refused.
    expect(
      csrfOutcome({ ...action, secFetchSite: 'same-site', origin: 'http://127.0.0.1:32768' }),
    ).toBe('cross-site');
  });
});
