import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedHostBackupsFromCustody } from '../lib/hub-worker';

const blob = (expiresAt: number) =>
  JSON.stringify({ claudeAiOauth: { refreshToken: 'r', expiresAt } });

const M = '11111111-2222-3333-4444-555555555555';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentbox-seed-acct-'));
  // The store's rows: the seed only refreshes an account this machine has.
  writeFileSync(
    join(dir, 'accounts.json'),
    JSON.stringify({
      version: 1,
      accounts: [
        { agent: 'claude', id: 'work', kind: 'login', createdAt: 't' },
        { agent: 'claude', id: 'ci', kind: 'setup-token', createdAt: 't' },
      ],
    }),
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A custody holding only named-account objects (no default one, so the real home is never read or written). */
function custody(objects: Record<string, string>) {
  return {
    get: (path: string) =>
      Promise.resolve(
        objects[path] === undefined
          ? null
          : { entry: { path } as never, data: Buffer.from(objects[path]!) },
      ),
    list: (prefix?: string) =>
      Promise.resolve(
        Object.keys(objects)
          .filter((p) => !prefix || p.startsWith(prefix))
          .map((path) => ({ path, size: 0, sha256: '', mode: 0o600, updatedAt: '' })),
      ),
  };
}

describe('seedHostBackupsFromCustody per account (llm-accounts Phase 4)', () => {
  it("materializes a named account's secret from its custody path", async () => {
    const logs: string[] = [];
    await seedHostBackupsFromCustody(
      custody({
        'agents/claude/accounts/11111111-2222-3333-4444-555555555555/work/.credentials.json':
          blob(200),
      }),
      (l) => logs.push(l),
      dir,
      M,
    );
    const written = readFileSync(join(dir, 'credentials', 'claude', 'work.json'), 'utf8');
    expect(JSON.parse(written).claudeAiOauth.expiresAt).toBe(200);
    expect(logs.join('\n')).toMatch(/seeded claude account 'work'/);
  });

  it('never downgrades a newer local account copy', async () => {
    mkdirSync(join(dir, 'credentials', 'claude'), { recursive: true });
    writeFileSync(join(dir, 'credentials', 'claude', 'work.json'), blob(500));
    await seedHostBackupsFromCustody(
      custody({
        'agents/claude/accounts/11111111-2222-3333-4444-555555555555/work/.credentials.json':
          blob(200),
      }),
      () => {},
      dir,
      M,
    );
    const kept = readFileSync(join(dir, 'credentials', 'claude', 'work.json'), 'utf8');
    expect(JSON.parse(kept).claudeAiOauth.expiresAt).toBe(500);
  });

  it('ignores malformed paths and bad ids', async () => {
    await seedHostBackupsFromCustody(
      custody({
        'agents/claude/accounts/11111111-2222-3333-4444-555555555555/Bad Id/.credentials.json':
          blob(1),
        'agents/claude/accounts/11111111-2222-3333-4444-555555555555/work/other.json': blob(1),
      }),
      () => {},
      dir,
      M,
    );
    expect(() => readFileSync(join(dir, 'credentials', 'claude', 'work.json'))).toThrow();
  });

  it('a rotated pasted token replaces the old one (no expiry to order by)', async () => {
    mkdirSync(join(dir, 'credentials', 'claude'), { recursive: true });
    const tok = (t: string) => JSON.stringify({ kind: 'setup-token', token: t }) + '\n';
    writeFileSync(join(dir, 'credentials', 'claude', 'ci.json'), tok('old-token-aaaaaaaaaaaaaaaa'));
    await seedHostBackupsFromCustody(
      custody({
        'agents/claude/accounts/11111111-2222-3333-4444-555555555555/ci/.credentials.json': tok(
          'new-token-bbbbbbbbbbbbbbbb',
        ),
      }),
      () => {},
      dir,
      M,
    );
    expect(readFileSync(join(dir, 'credentials', 'claude', 'ci.json'), 'utf8')).toBe(
      tok('new-token-bbbbbbbbbbbbbbbb'),
    );
  });
  it("never seeds another machine's account of the same name", async () => {
    await seedHostBackupsFromCustody(
      custody({
        'agents/claude/accounts/99999999-2222-3333-4444-555555555555/work/.credentials.json':
          blob(9),
      }),
      () => {},
      dir,
      M,
    );
    expect(() => readFileSync(join(dir, 'credentials', 'claude', 'work.json'))).toThrow();
  });
});

describe('seedHostBackupsFromCustody and a removed account', () => {
  it('never brings back the secret of an account the store no longer has', async () => {
    const logs: string[] = [];
    await seedHostBackupsFromCustody(
      custody({
        'agents/claude/accounts/11111111-2222-3333-4444-555555555555/gone/.credentials.json':
          blob(900),
      }),
      (l) => logs.push(l),
      dir,
      M,
    );
    expect(() => readFileSync(join(dir, 'credentials', 'claude', 'gone.json'))).toThrow();
    expect(logs.join('\n')).toMatch(/no such account/);
  });
});
