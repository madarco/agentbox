import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { maskKey } from '../src/credentials.js';
import { resolveCredentials, hasUsableCredentials } from '../src/sdk.js';
import { reloadVercelEnv } from '../src/env-loader.js';

const VERCEL_KEYS = [
  'VERCEL_OIDC_TOKEN',
  'VERCEL_TOKEN',
  'VERCEL_TEAM_ID',
  'VERCEL_PROJECT_ID',
  // Point HOME at a nonexistent dir so the loader can't pick up a real
  // ~/.agentbox/secrets.env on the dev machine running the test.
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of VERCEL_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  saved.HOME = process.env.HOME;
  process.env.HOME = '/nonexistent-agentbox-test-home';
  reloadVercelEnv();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  reloadVercelEnv();
});

describe('maskKey', () => {
  it('fully masks short values', () => {
    expect(maskKey('abcd')).toBe('****');
  });
  it('shows a prefix/suffix for long values', () => {
    expect(maskKey('abcdefghijklmnop')).toMatch(/^abcd…\*{8}mnop$/);
  });
});

// Build a fake-but-well-formed Vercel OIDC JWT (header.payload.sig) with the
// claims resolveCredentials decodes. Only the payload segment is read.
function makeOidcToken(claims: { owner_id: string; project_id: string; exp?: number }): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.sig`;
}

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;

describe('resolveCredentials / hasUsableCredentials', () => {
  it('decodes teamId/projectId from the OIDC token and returns explicit creds', () => {
    const tok = makeOidcToken({ owner_id: 'team_1', project_id: 'prj_1', exp: FUTURE });
    process.env.VERCEL_OIDC_TOKEN = tok;
    expect(hasUsableCredentials()).toBe(true);
    expect(resolveCredentials()).toEqual({ token: tok, teamId: 'team_1', projectId: 'prj_1' });
  });

  it('returns the token trio when no OIDC but the trio is present', () => {
    process.env.VERCEL_TOKEN = 't';
    process.env.VERCEL_TEAM_ID = 'team';
    process.env.VERCEL_PROJECT_ID = 'prj';
    expect(hasUsableCredentials()).toBe(true);
    expect(resolveCredentials()).toEqual({ token: 't', teamId: 'team', projectId: 'prj' });
  });

  it('prefers OIDC over a partial trio', () => {
    const tok = makeOidcToken({ owner_id: 'team_x', project_id: 'prj_x', exp: FUTURE });
    process.env.VERCEL_OIDC_TOKEN = tok;
    process.env.VERCEL_TOKEN = 't';
    expect(resolveCredentials()).toEqual({ token: tok, teamId: 'team_x', projectId: 'prj_x' });
  });

  it('throws a clear error when the OIDC token has expired', () => {
    process.env.VERCEL_OIDC_TOKEN = makeOidcToken({ owner_id: 'team_1', project_id: 'prj_1', exp: PAST });
    expect(() => resolveCredentials()).toThrow(/expired/i);
  });

  it('throws when the OIDC token cannot be decoded', () => {
    process.env.VERCEL_OIDC_TOKEN = 'not-a-jwt';
    expect(() => resolveCredentials()).toThrow(/could not be decoded/i);
  });

  it('throws an actionable error when nothing is configured', () => {
    expect(hasUsableCredentials()).toBe(false);
    expect(() => resolveCredentials()).toThrow(/credentials not configured/i);
  });

  it('does not treat a partial trio as usable', () => {
    process.env.VERCEL_TOKEN = 't';
    process.env.VERCEL_TEAM_ID = 'team';
    // missing VERCEL_PROJECT_ID
    expect(hasUsableCredentials()).toBe(false);
  });
});
