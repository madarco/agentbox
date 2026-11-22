import { describe, expect, it } from 'vitest';
import { setDefaultCheckpointRefusal } from '../lib/backend/accounts';
import { parseCreateBox } from '../app/(dashboard)/api/v1/lib/validate';

describe('setDefaultCheckpointRefusal (#437-7)', () => {
  it('refuses a box on a named account, naming it', () => {
    expect(setDefaultCheckpointRefusal({ name: 'b1', accounts: { claude: 'work' } })).toMatch(
      /claude=work/,
    );
  });
  it('allows a default box (no or default-only accounts)', () => {
    expect(setDefaultCheckpointRefusal({ name: 'b1' })).toBeNull();
    expect(setDefaultCheckpointRefusal({ name: 'b1', accounts: { claude: 'default' } })).toBeNull();
  });
});

describe('opts.accounts on create (Phase 3)', () => {
  it('accepts { agent: account } and rejects a bad id', () => {
    const okRes = parseCreateBox({
      projectId: 'p1',
      provider: 'docker',
      agent: 'claude',
      opts: { accounts: { claude: 'work' } },
    });
    expect(okRes.ok && okRes.value.opts?.accounts).toEqual({ claude: 'work' });
    const bad = parseCreateBox({
      projectId: 'p1',
      provider: 'docker',
      agent: 'claude',
      opts: { accounts: { claude: 'Work Laptop' } },
    });
    expect(bad.ok).toBe(false);
  });
});
