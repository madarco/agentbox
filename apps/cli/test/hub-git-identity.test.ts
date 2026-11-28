import { describe, expect, it } from 'vitest';
import {
  describeHubGitIdentityOffer,
  offerHubGitIdentity,
} from '../src/control-plane/hub-git-identity.js';

const ADA = { name: 'Ada Lovelace', email: 'ada@example.com' };

function fakeHub(answer: { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }));
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('offering this PC identity to a hub it enrolls on', () => {
  it('PUTs the identity with ifUnset, so a chosen default is never replaced', async () => {
    const hub = fakeHub({ status: 200, body: { identity: ADA } });
    const r = await offerHubGitIdentity({
      url: 'https://hub.example.com/',
      bearer: 'tok',
      fetch: hub.f,
      readIdentity: () => ADA,
    });
    expect(r).toEqual({ outcome: 'set', identity: ADA });
    expect(hub.calls).toHaveLength(1);
    expect(hub.calls[0]?.url).toBe('https://hub.example.com/api/v1/settings/git-identity');
    expect(hub.calls[0]?.init.method).toBe('PUT');
    expect(JSON.parse(String(hub.calls[0]?.init.body))).toEqual({ identity: ADA, ifUnset: true });
    expect(describeHubGitIdentityOffer(r)).toContain('Ada Lovelace <ada@example.com>');
  });

  it('reports a hub that already had one, and says nothing about it', async () => {
    const team = { name: 'Team', email: 'team@example.com' };
    const hub = fakeHub({ status: 200, body: { identity: team, unchanged: true } });
    const r = await offerHubGitIdentity({
      url: 'https://hub.example.com',
      bearer: 'tok',
      fetch: hub.f,
      readIdentity: () => ADA,
    });
    expect(r).toEqual({ outcome: 'kept', identity: team });
    expect(describeHubGitIdentityOffer(r)).toBeNull();
  });

  it('sends nothing when this PC has no identity', async () => {
    const hub = fakeHub({ status: 200, body: {} });
    const r = await offerHubGitIdentity({
      url: 'https://hub.example.com',
      bearer: 'tok',
      fetch: hub.f,
      readIdentity: () => undefined,
    });
    expect(r.outcome).toBe('no-local-identity');
    expect(hub.calls).toHaveLength(0);
  });

  it('treats an older hub (404) as unsupported, quietly', async () => {
    const hub = fakeHub({ status: 404, body: {} });
    const r = await offerHubGitIdentity({
      url: 'https://hub.example.com',
      bearer: 'tok',
      fetch: hub.f,
      readIdentity: () => ADA,
    });
    expect(r).toEqual({ outcome: 'unsupported', status: 404 });
    expect(describeHubGitIdentityOffer(r)).toBeNull();
  });
});
