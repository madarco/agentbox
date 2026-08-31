import { describe, expect, it, vi } from 'vitest';
import { probeDaytonaAuth } from '../src/credentials.js';

/**
 * `client.list()` is lazy — awaiting it alone resolves the generator object and
 * never touches the network, so login validation happily accepted a revoked key
 * and the failure only surfaced as "Invalid credentials" during a later bake.
 * These pin that the probe actually pulls a page.
 */
describe('probeDaytonaAuth', () => {
  it('starts the generator instead of just awaiting it', async () => {
    const started = vi.fn();
    const client = {
      list: () =>
        (async function* () {
          started();
          yield { id: 'sb-1' };
        })(),
    };
    await probeDaytonaAuth(client);
    expect(started).toHaveBeenCalledOnce();
  });

  it('propagates the auth error the first page raises', async () => {
    const client = {
      list: () =>
        (async function* () {
          throw new Error('Invalid credentials');
          yield undefined;
        })(),
    };
    await expect(probeDaytonaAuth(client)).rejects.toThrow('Invalid credentials');
  });

  // An org with no sandboxes is still a successful round trip — the loop just
  // ends, and treating that as a failure would reject every fresh account.
  it('accepts an organization with no sandboxes', async () => {
    const client = {
      list: () =>
        (async function* () {
          // no sandboxes
        })(),
    };
    await expect(probeDaytonaAuth(client)).resolves.toBeUndefined();
  });

  // Only the first page matters: validation must not walk a large account.
  it('stops after the first item', async () => {
    const seen: string[] = [];
    const client = {
      list: () =>
        (async function* () {
          seen.push('a');
          yield { id: 'a' };
          seen.push('b');
          yield { id: 'b' };
        })(),
    };
    await probeDaytonaAuth(client);
    expect(seen).toEqual(['a']);
  });
});
