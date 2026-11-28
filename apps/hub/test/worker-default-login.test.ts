import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

// Scratch HOME before the imports: the backup, the agent's own login file and
// the hub config are all read from it.
const home = mkdtempSync(join(tmpdir(), 'agentbox-worker-default-'));
const realHome = process.env.HOME;
process.env.HOME = home;
const { resolveWorkerAccounts } = await import('../lib/hub-worker');
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

const LOGIN = JSON.stringify({ claudeAiOauth: { refreshToken: 'fake-rt', expiresAt: 5 } });
const ownLogin = join(home, '.claude', '.credentials.json');
const backup = join(home, '.agentbox', 'claude-credentials.json');
afterEach(() => {
  rmSync(ownLogin, { force: true });
  rmSync(backup, { force: true });
});

const create = (provider: string, log?: (l: string) => void) =>
  resolveWorkerAccounts({
    agentId: 'claude',
    names: undefined,
    borrowCredentials: [],
    requesterMachine: undefined,
    startsSession: true,
    provider,
    ...(log ? { log } : {}),
  });

describe('the default-login refusal counts every source a create seeds from (#528)', () => {
  it("takes the agent's own host login file when there is no backup", async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(ownLogin, LOGIN);
    await expect(create('hetzner')).resolves.toEqual({});
  });

  it('takes the backup', async () => {
    mkdirSync(join(home, '.agentbox'), { recursive: true });
    writeFileSync(backup, LOGIN);
    await expect(create('hetzner')).resolves.toEqual({});
  });

  it('refuses a cloud box with no login anywhere', async () => {
    await expect(create('hetzner')).rejects.toThrow(/no claude login \(the default account\)/);
  });

  it('only warns for a docker-shaped box, whose config volume it cannot read', async () => {
    const lines: string[] = [];
    await expect(create('docker:box1', (l) => lines.push(l))).resolves.toEqual({});
    expect(lines.join('\n')).toMatch(/warning: this hub has no claude login.*config volume/);
  });

  it('does not check at all for a cold create (the PC attaches and can sign in)', async () => {
    await expect(
      resolveWorkerAccounts({
        agentId: 'claude',
        names: undefined,
        borrowCredentials: [],
        requesterMachine: undefined,
        startsSession: false,
        provider: 'hetzner',
      }),
    ).resolves.toEqual({});
  });
});
