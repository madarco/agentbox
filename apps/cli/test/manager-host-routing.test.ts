/**
 * The CLI's half of "the manager runs on your machine, its record lives on the
 * hub": which hub a refusal should be retried against, and whether a manager's
 * tmux session is reachable from here at all.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { retryOnLocalHub, runsHere, sendManagerMessage } from '../src/commands/manager.js';
import { HubApiError } from '../src/control-plane/hub-api-client.js';

// No HOME isolation in apps/cli: a default-argument `thisMachine()` would mint
// the developer's real ~/.agentbox/machine-id.
process.env['HOME'] = mkdtempSync(join(tmpdir(), 'agentbox-mhr-home-'));

const A = '11111111-2222-4333-8444-555555555555';
const B = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const C = '00000000-7777-4888-8999-aaaaaaaaaaaa';

describe('runsHere', () => {
  it('is the manager host against this machine, not which hub answered', () => {
    expect(runsHere({ host: 'laptop' }, 'laptop')).toBe(true);
    expect(runsHere({ host: 'desktop' }, 'laptop')).toBe(false);
  });

  it('decides by machine id when the record has one, so a hostname flip keeps it here', () => {
    const me = { id: A, label: 'laptop-2' };
    expect(runsHere({ host: 'laptop', machineId: A }, me)).toBe(true);
    // Same name, other machine.
    expect(runsHere({ host: 'laptop-2', machineId: B }, me)).toBe(false);
    // A record from before machine ids: only its hostname identifies it.
    expect(runsHere({ host: 'laptop-2' }, me)).toBe(true);
  });
});

describe('retryOnLocalHub', () => {
  const refusal = (code: string, details?: unknown) => new HubApiError('nope', code, 409, details);

  it('retries a wrong-host refusal that names this machine', () => {
    expect(retryOnLocalHub(refusal('wrong_host', { host: 'laptop' }), 'laptop')).toBe(true);
    expect(retryOnLocalHub(refusal('manager_unreachable', { host: 'laptop' }), 'laptop')).toBe(
      true,
    );
  });

  it('does not retry one that names another machine, or names none', () => {
    expect(retryOnLocalHub(refusal('wrong_host', { host: 'desktop' }), 'laptop')).toBe(false);
    expect(retryOnLocalHub(refusal('manager_unreachable'), 'laptop')).toBe(false);
    expect(retryOnLocalHub(refusal('wrong_host', { host: 42 }), 'laptop')).toBe(false);
  });

  it('retries a workspace refusal that lists this machine among the hosts', () => {
    // A workspace mapped from two PCs has no single right `host`, so the
    // refusal lists them all and each caller looks for its own.
    const hosts = { host: 'desktop', hosts: ['desktop', 'laptop'] };
    expect(retryOnLocalHub(refusal('wrong_host', hosts), 'laptop')).toBe(true);
    expect(retryOnLocalHub(refusal('wrong_host', hosts), 'desktop')).toBe(true);
    expect(retryOnLocalHub(refusal('wrong_host', hosts), 'tower')).toBe(false);
  });

  it('matches a refusal by machine id first, then by hostname for an id-less one', () => {
    const me = { id: A, label: 'laptop-2' };
    expect(retryOnLocalHub(refusal('wrong_host', { host: 'laptop', machineId: A }), me)).toBe(
      true,
    );
    expect(retryOnLocalHub(refusal('wrong_host', { host: 'laptop-2', machineId: B }), me)).toBe(
      false,
    );
    expect(retryOnLocalHub(refusal('wrong_host', { host: 'laptop-2' }), me)).toBe(true);
    // A workspace refusal: this machine is listed by id, under a stale name.
    const two = { host: 'desktop', hosts: ['desktop', 'laptop'], machineIds: [B, A] };
    expect(retryOnLocalHub(refusal('wrong_host', two), me)).toBe(true);
    // Every listed machine has an id and none is ours: a matching name is someone else's.
    const named = { host: 'desktop', hosts: ['desktop', 'laptop-2'], machineIds: [B, C] };
    expect(retryOnLocalHub(refusal('wrong_host', named), me)).toBe(false);
  });

  it('does not retry a refusal about anything else', () => {
    expect(retryOnLocalHub(refusal('conflict', { host: 'laptop' }), 'laptop')).toBe(false);
    expect(retryOnLocalHub(refusal('not_found', { host: 'laptop' }), 'laptop')).toBe(false);
    expect(retryOnLocalHub(new Error('boom'), 'laptop')).toBe(false);
  });
});

/**
 * The WIRING, not the predicate: `withHubClient` reports a `HubApiError` and
 * sets `process.exitCode` instead of rethrowing, so the retry has to be decided
 * inside the callback. The fake below swallows exactly the way the real one
 * does — a `catch` around it would see nothing.
 */
describe('sendManagerMessage', () => {
  const refusal = () => new HubApiError('runs elsewhere', 'wrong_host', 409, { host: 'laptop' });

  /** `withHubClient`'s contract: never rethrows, reports and sets an exit code. */
  function fakeWithHub(seen: { preferLocal?: boolean }[]) {
    return (async (opts: { preferLocal?: boolean }, fn: (client: never) => Promise<unknown>) => {
      seen.push({ preferLocal: opts.preferLocal });
      try {
        return await fn(undefined as never);
      } catch {
        process.exitCode = 1;
        return undefined;
      }
    }) as never;
  }

  beforeEach(() => {
    process.exitCode = undefined;
  });

  it('retries against the local hub when the record hub says the session runs here', async () => {
    const seen: { preferLocal?: boolean }[] = [];
    const typed: string[] = [];
    let call = 0;
    await sendManagerMessage(
      async () => {
        call += 1;
        if (call === 1) throw refusal();
        typed.push('sent');
      },
      { withHub: fakeWithHub(seen), host: 'laptop' },
    );
    expect(call).toBe(2);
    expect(typed).toEqual(['sent']);
    // The first attempt goes to whichever hub holds the record, the retry to this one.
    expect(seen.map((s) => s.preferLocal)).toEqual([undefined, true]);
    expect(process.exitCode).toBeUndefined();
  });

  it('clears an exit code the first attempt set when the retry lands', async () => {
    let call = 0;
    await sendManagerMessage(
      async () => {
        call += 1;
        if (call === 1) {
          process.exitCode = 1;
          throw refusal();
        }
      },
      { withHub: fakeWithHub([]), host: 'laptop' },
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('does not retry a refusal naming another machine, and lets the reporter have it', async () => {
    const seen: { preferLocal?: boolean }[] = [];
    let call = 0;
    await sendManagerMessage(
      async () => {
        call += 1;
        throw new HubApiError('runs elsewhere', 'wrong_host', 409, { host: 'desktop' });
      },
      { withHub: fakeWithHub(seen), host: 'laptop' },
    );
    expect(call).toBe(1);
    expect(seen).toHaveLength(1);
    expect(process.exitCode).toBe(1);
  });

  it('does not retry when the first attempt typed the message', async () => {
    const seen: { preferLocal?: boolean }[] = [];
    let call = 0;
    await sendManagerMessage(
      async () => {
        call += 1;
      },
      { withHub: fakeWithHub(seen), host: 'laptop' },
    );
    expect(call).toBe(1);
    expect(seen).toHaveLength(1);
  });
});
