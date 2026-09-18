/**
 * The CLI's half of "the manager runs on your machine, its record lives on the
 * hub": which hub a refusal should be retried against, and whether a manager's
 * tmux session is reachable from here at all.
 */
import { describe, expect, it } from 'vitest';
import { retryOnLocalHub, runsHere } from '../src/commands/manager.js';
import { HubApiError } from '../src/control-plane/hub-api-client.js';

describe('runsHere', () => {
  it('is the manager host against this machine, not which hub answered', () => {
    expect(runsHere({ host: 'laptop' }, 'laptop')).toBe(true);
    expect(runsHere({ host: 'desktop' }, 'laptop')).toBe(false);
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

  it('does not retry a refusal about anything else', () => {
    expect(retryOnLocalHub(refusal('conflict', { host: 'laptop' }), 'laptop')).toBe(false);
    expect(retryOnLocalHub(refusal('not_found', { host: 'laptop' }), 'laptop')).toBe(false);
    expect(retryOnLocalHub(new Error('boom'), 'laptop')).toBe(false);
  });
});
