import { afterEach, describe, expect, it } from 'vitest';
import { publishManagedCredentials, setCredentialPublisher } from '../src/index.js';

// The hook is process-global (one slot), so every test resets it.
afterEach(() => setCredentialPublisher(undefined));

describe('credential-publish hook', () => {
  it('is a no-op when no publisher is installed', async () => {
    // A provider package used on its own (no CLI) must publish nothing and not throw.
    await expect(publishManagedCredentials('e2b', { apiKey: 'k' })).resolves.toBeUndefined();
  });

  it('forwards the provider id and fields to the installed publisher', async () => {
    const calls: Array<{ id: string; fields: Record<string, string> }> = [];
    setCredentialPublisher(async (id, fields) => {
      calls.push({ id, fields });
    });
    await publishManagedCredentials('vercel', { token: 't', teamId: 'tm' });
    expect(calls).toEqual([{ id: 'vercel', fields: { token: 't', teamId: 'tm' } }]);
  });

  it('swallows a publisher failure so a local login is never broken', async () => {
    setCredentialPublisher(async () => {
      throw new Error('hub unreachable');
    });
    // Must resolve (not reject): the local secrets.env write is the guaranteed outcome.
    await expect(publishManagedCredentials('hetzner', { token: 't' })).resolves.toBeUndefined();
  });

  it('stops publishing once the publisher is cleared', async () => {
    let calls = 0;
    setCredentialPublisher(async () => {
      calls += 1;
    });
    await publishManagedCredentials('daytona', { apiKey: 'k' });
    setCredentialPublisher(undefined);
    await publishManagedCredentials('daytona', { apiKey: 'k' });
    expect(calls).toBe(1);
  });
});
