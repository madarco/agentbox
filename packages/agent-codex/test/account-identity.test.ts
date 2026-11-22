import { describe, expect, it } from 'vitest';
import { parseCodexAccountIdentity } from '../src/cli/account-identity.js';
import { buildCodexVolumeSyncScript } from '../src/docker-sync.js';

const jwt = (claims: object): string =>
  ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

describe('parseCodexAccountIdentity', () => {
  it('reads email and the ChatGPT plan from the id_token claims', () => {
    const auth = {
      tokens: {
        id_token: jwt({
          email: 'b@example.com',
          'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
        }),
      },
    };
    expect(parseCodexAccountIdentity({ 'auth.json': JSON.stringify(auth) })).toEqual({
      email: 'b@example.com',
      plan: 'plus',
    });
  });

  it('is undefined for an API-key auth.json or garbage', () => {
    expect(
      parseCodexAccountIdentity({ 'auth.json': JSON.stringify({ OPENAI_API_KEY: 'k' }) }),
    ).toBe(undefined);
    expect(parseCodexAccountIdentity({ 'auth.json': 'nope' })).toBe(undefined);
    expect(
      parseCodexAccountIdentity({ 'auth.json': JSON.stringify({ tokens: { id_token: 'x' } }) }),
    ).toBe(undefined);
  });
});

describe("named account volume seed never copies the host's auth.json", () => {
  it('excludes auth.json only for a named account', () => {
    expect(buildCodexVolumeSyncScript(false)).not.toContain('--exclude=/auth.json');
    expect(buildCodexVolumeSyncScript(false, { namedAccount: true })).toContain(
      '--exclude=/auth.json',
    );
    expect(buildCodexVolumeSyncScript(false, { namedAccount: true })).not.toContain(
      '--include=auth.json',
    );
  });
});
