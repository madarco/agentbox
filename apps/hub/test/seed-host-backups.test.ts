import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

// Redirect HOME before importing anything that resolves ~/.agentbox — the
// credential backups these tests read and write live there.
const TEST_HOME = await mkdtemp(join(tmpdir(), 'agentbox-seed-backups-'));
const REAL_HOME = process.env['HOME'];
process.env['HOME'] = TEST_HOME;

const { seedHostBackupsFromCustody } = await import('../lib/hub-worker');
const { readCredentialBackup, writeCredentialBackup } = await import('@agentbox/sandbox-core');

const claudeBlob = (expiresAt: number, token = 'a') =>
  JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'r', expiresAt } });

/** Custody stub: only `get`, which is all the seeder uses. */
function custodyWith(entries: Record<string, string>) {
  return {
    get: (path: string) =>
      Promise.resolve(
        entries[path] === undefined
          ? null
          : { entry: { path }, data: Buffer.from(entries[path], 'utf8') },
      ),
  } as never;
}

const CLAUDE = 'agents/claude/.credentials.json';

afterEach(async () => {
  await rm(join(TEST_HOME, '.agentbox'), { recursive: true, force: true });
});
afterAll(async () => {
  process.env['HOME'] = REAL_HOME;
  await rm(TEST_HOME, { recursive: true, force: true });
});

describe('seedHostBackupsFromCustody', () => {
  // THE BUG: a box's refreshed token had just landed in the host backup, and the
  // next create replaced it with custody's hours-old copy. Claude's OAuth refresh
  // rotates the refresh token, so the older blob is dead — the box came up
  // logged out and could not recover.
  it('keeps a newer local backup instead of custody’s older copy', async () => {
    const fresh = claudeBlob(9_000, 'fresh');
    await writeCredentialBackup('claude', fresh);
    const said: string[] = [];

    await seedHostBackupsFromCustody(custodyWith({ [CLAUDE]: claudeBlob(1_000, 'stale') }), (l) =>
      said.push(l),
    );

    expect(await readCredentialBackup('claude')).toBe(fresh);
    expect(said.join(' ')).toContain('kept the local claude credentials');
  });

  it('takes custody’s copy when it is newer', async () => {
    await writeCredentialBackup('claude', claudeBlob(1_000, 'old'));
    const newer = claudeBlob(9_000, 'new');

    await seedHostBackupsFromCustody(custodyWith({ [CLAUDE]: newer }), () => {});

    expect(await readCredentialBackup('claude')).toBe(newer);
  });

  it('seeds when this machine has no backup at all', async () => {
    const blob = claudeBlob(9_000);
    await seedHostBackupsFromCustody(custodyWith({ [CLAUDE]: blob }), () => {});
    expect(await readCredentialBackup('claude')).toBe(blob);
  });

  it('leaves the backup alone when custody holds nothing', async () => {
    const mine = claudeBlob(9_000, 'mine');
    await writeCredentialBackup('claude', mine);
    await seedHostBackupsFromCustody(custodyWith({}), () => {});
    expect(await readCredentialBackup('claude')).toBe(mine);
  });

  // codex/opencode blobs carry no ordering field — last-writer-wins by content.
  it('accepts a changed codex blob, which has no expiry to compare', async () => {
    await writeCredentialBackup('codex', JSON.stringify({ tokens: { access: 'old' } }));
    const next = JSON.stringify({ tokens: { access: 'new' } });

    await seedHostBackupsFromCustody(custodyWith({ 'agents/codex/auth.json': next }), () => {});

    expect(await readCredentialBackup('codex')).toBe(next);
  });

  it('writes the backup 0600', async () => {
    await seedHostBackupsFromCustody(custodyWith({ [CLAUDE]: claudeBlob(9_000) }), () => {});
    const { stat } = await import('node:fs/promises');
    const path = join(TEST_HOME, '.agentbox', 'claude-credentials.json');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    // sanity: the file really is where we think it is
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ claudeAiOauth: {} });
  });

  it('survives a custody read that throws', async () => {
    const mine = claudeBlob(9_000, 'mine');
    await writeCredentialBackup('claude', mine);
    const exploding = { get: () => Promise.reject(new Error('disk gone')) } as never;

    await expect(seedHostBackupsFromCustody(exploding, () => {})).resolves.toBeUndefined();
    expect(await readCredentialBackup('claude')).toBe(mine);
  });
});
