import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// stateBoxAccount reads ~/.agentbox/state.json: point HOME at an empty dir.
process.env.HOME = mkdtempSync(join(tmpdir(), 'agentbox-regacct-'));

const { describe, expect, it } = await import('vitest');
const { registrationBoxAccount, UNVERIFIABLE_ACCOUNT } =
  await import('../src/credentials-fanout.js');

describe('registrationBoxAccount (#442 review)', () => {
  it("a registration's named account wins", async () => {
    const store = { getBox: () => Promise.resolve({ accounts: { claude: 'work' } }) };
    expect(await registrationBoxAccount(store, 'b1', 'claude')).toBe('work');
  });

  it('a store that fails to answer is unverifiable, never the default', async () => {
    const store = { getBox: () => Promise.reject(new Error('store down')) };
    expect(await registrationBoxAccount(store, 'b1', 'claude')).toBe(UNVERIFIABLE_ACCOUNT);
  });

  it('no registration falls through to state.json (none here: default)', async () => {
    const store = { getBox: () => Promise.resolve(undefined) };
    expect(await registrationBoxAccount(store, 'b1', 'claude')).toBeUndefined();
  });
});
