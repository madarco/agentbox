import { describe, expect, it } from 'vitest';
import { serviceSignInUrl } from '../src/agents/command/service-action.js';

/**
 * The link that actually opens a gateway's Control UI.
 *
 * openclaw's UI takes its token from the URL FRAGMENT, so a URL and a token on
 * two separate lines is a link the user assembles by hand — which is what made
 * `agentbox openclaw url` insufficient to get in.
 */
describe('serviceSignInUrl', () => {
  const token = { label: 'token', value: 'a74daa17', fragmentKey: 'token' };

  it('puts the token in the fragment, where the UI reads it', () => {
    expect(serviceSignInUrl('https://ada.localhost', [token])).toBe(
      'https://ada.localhost/#token=a74daa17',
    );
  });

  it('keeps a single slash when the URL already ends in one', () => {
    expect(serviceSignInUrl('http://127.0.0.1:18789/', [token])).toBe(
      'http://127.0.0.1:18789/#token=a74daa17',
    );
  });

  it('adds the root path to a bare authority', () => {
    // A fragment hung directly off `host:port` is not reliably openable.
    expect(serviceSignInUrl('http://127.0.0.1:18789', [token])).toContain('18789/#token=');
  });

  it('is null for an agent that declares no fragment field', () => {
    // Nothing to add, so the caller prints no extra line at all.
    expect(serviceSignInUrl('https://ada.localhost', [{ label: 'token', value: 'x' }])).toBeNull();
    expect(serviceSignInUrl('https://ada.localhost', [])).toBeNull();
  });

  it('escapes a value that would otherwise break the fragment', () => {
    expect(
      serviceSignInUrl('https://ada.localhost', [
        { label: 'token', value: 'a b&c=d', fragmentKey: 'token' },
      ]),
    ).toBe('https://ada.localhost/#token=a%20b%26c%3Dd');
  });

  it('joins several fragment fields, leaving non-fragment ones out', () => {
    expect(
      serviceSignInUrl('https://ada.localhost', [
        token,
        { label: 'user', value: 'ada', fragmentKey: 'user' },
        { label: 'note', value: 'not-in-url' },
      ]),
    ).toBe('https://ada.localhost/#token=a74daa17&user=ada');
  });
});
