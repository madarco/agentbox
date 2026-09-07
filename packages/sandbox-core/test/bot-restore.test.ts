/**
 * The restore half of the bot-backup concern.
 *
 * The load-bearing assertion here is the stale-sidecar removal, and it pins a
 * MEASURED failure rather than a hypothetical one: pushing a backup's
 * `openclaw.sqlite` over a fresh box's without removing that box's own
 * `-wal`/`-shm` left the gateway refusing to start with
 * `SQLite integrity_check failed … row 1 missing from index`, in a restart loop.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRecordingTransport } from '../src/sync/recording-transport.js';
import {
  botBackupDir,
  linkLatest,
  listBackups,
  pruneBackups,
  readBackupManifest,
  resolveBotBundle,
  restoreAgentState,
  writeBackupManifest,
  type BackupManifest,
} from '../src/sync/concerns/bot-backup.js';

const OPENCLAW_DIR = '/home/vscode/.openclaw';

function project(): string {
  return mkdtempSync(join(tmpdir(), 'agentbox-bot-restore-'));
}

function manifest(over: Partial<BackupManifest> = {}): BackupManifest {
  return {
    version: 1,
    stamp: '2026-09-07T14-03-11Z',
    bot: 'ada',
    boxId: 'b0dc0ffee',
    boxName: 'ada',
    provider: 'docker',
    agent: 'openclaw',
    state: true,
    ...over,
  };
}

/** A bundle on disk, as `download --backup` would have left it. */
async function makeBundle(
  root: string,
  stamp: string,
  opts: { state?: boolean; databases?: string[] } = {},
): Promise<string> {
  const dir = botBackupDir(root, 'ada', stamp);
  mkdirSync(join(dir, 'workspace'), { recursive: true });
  writeFileSync(join(dir, 'workspace', 'SOUL.md'), '# Ada\n');
  if (opts.state !== false) {
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(join(dir, 'state', 'openclaw.json'), '{}');
    for (const rel of opts.databases ?? []) {
      mkdirSync(join(dir, 'state', rel, '..'), { recursive: true });
      writeFileSync(join(dir, 'state', rel), '');
    }
  }
  await writeBackupManifest(dir, manifest({ stamp, state: opts.state !== false }));
  return dir;
}

describe('restoreAgentState', () => {
  it('clears the stale write-ahead logs of the databases it replaces, then pushes', async () => {
    const root = project();
    const dir = await makeBundle(root, '2026-09-07T14-03-11Z', {
      databases: [join('state', 'openclaw.sqlite'), join('agents', 'main', 'agent', 'a.sqlite')],
    });
    const t = makeRecordingTransport();

    const r = await restoreAgentState({
      agent: 'openclaw',
      transport: t,
      srcDir: join(dir, 'state'),
    });

    const rm = t.ops.find((o) => o.op === 'exec');
    const cmd = String((rm?.args as { cmd?: string[] }).cmd?.join(' ') ?? '');
    for (const rel of ['state/openclaw.sqlite', 'agents/main/agent/a.sqlite']) {
      expect(cmd).toContain(`${OPENCLAW_DIR}/${rel}-wal`);
      expect(cmd).toContain(`${OPENCLAW_DIR}/${rel}-shm`);
    }
    expect(r.clearedSidecars).toHaveLength(4);

    // Order matters: removing the sidecars AFTER the push would delete the ones
    // the restored database legitimately needs on its next open.
    const kinds = t.ops.map((o) => o.op);
    expect(kinds.indexOf('exec')).toBeLessThan(kinds.indexOf('pushTree'));
  });

  it('pushes the state dir with NO exclude — a restore is what puts the databases back', async () => {
    // `agentPushExcludes` would add LIVE_DATABASE_EXCLUDES (`*.sqlite*`) here,
    // which is exactly the gateway state a restore exists to return.
    const root = project();
    const dir = await makeBundle(root, '2026-09-07T14-03-11Z', {
      databases: [join('state', 'openclaw.sqlite')],
    });
    const t = makeRecordingTransport();

    await restoreAgentState({ agent: 'openclaw', transport: t, srcDir: join(dir, 'state') });

    const push = t.ops.find((o) => o.op === 'pushTree');
    expect(push?.args).toMatchObject({
      hostSrcDir: join(dir, 'state'),
      boxDestDir: OPENCLAW_DIR,
    });
    const opts = (push?.args as { opts?: { exclude?: string[] } }).opts;
    expect(opts?.exclude ?? []).toEqual([]);
  });

  it('runs no removal when the bundle carries no database', async () => {
    const root = project();
    const dir = await makeBundle(root, '2026-09-07T14-03-11Z');
    const t = makeRecordingTransport();

    const r = await restoreAgentState({
      agent: 'openclaw',
      transport: t,
      srcDir: join(dir, 'state'),
    });

    expect(r.clearedSidecars).toEqual([]);
    expect(t.ops.map((o) => o.op)).toEqual(['pushTree']);
  });
});

describe('resolveBotBundle', () => {
  it('follows the `latest` link when no stamp is given', async () => {
    const root = project();
    await makeBundle(root, '2026-09-01T00-00-00Z');
    await makeBundle(root, '2026-09-07T14-03-11Z');
    await linkLatest(root, 'ada', '2026-09-01T00-00-00Z');

    const b = await resolveBotBundle(root, 'ada');
    expect(b.stamp).toBe('2026-09-01T00-00-00Z');
    expect(b.stateDir).toBe(join(b.dir, 'state'));
  });

  it('falls back to the newest stamp when the link is missing', async () => {
    // A bundle copied with a tool that drops symlinks must still restore —
    // which is why `latest` is a relative link and not the only way in.
    const root = project();
    await makeBundle(root, '2026-09-01T00-00-00Z');
    await makeBundle(root, '2026-09-07T14-03-11Z');

    expect((await resolveBotBundle(root, 'ada')).stamp).toBe('2026-09-07T14-03-11Z');
  });

  it('honours an explicit stamp', async () => {
    const root = project();
    await makeBundle(root, '2026-09-01T00-00-00Z');
    await makeBundle(root, '2026-09-07T14-03-11Z');
    await linkLatest(root, 'ada', '2026-09-07T14-03-11Z');

    expect((await resolveBotBundle(root, 'ada', '2026-09-01T00-00-00Z')).stamp).toBe(
      '2026-09-01T00-00-00Z',
    );
  });

  it('reports no state dir when the backup captured only the workspace', async () => {
    const root = project();
    await makeBundle(root, '2026-09-07T14-03-11Z', { state: false });
    expect((await resolveBotBundle(root, 'ada')).stateDir).toBeUndefined();
  });

  it('names the directory when there is no backup at all', async () => {
    const root = project();
    await expect(resolveBotBundle(root, 'ada')).rejects.toThrow(/no backup of 'ada'/);
  });

  it('refuses a bundle whose workspace half is missing', async () => {
    const root = project();
    const dir = await makeBundle(root, '2026-09-07T14-03-11Z');
    rmSync(join(dir, 'workspace'), { recursive: true });
    await expect(resolveBotBundle(root, 'ada')).rejects.toThrow(/no workspace\//);
  });
});

describe('readBackupManifest', () => {
  it('refuses a manifest version this build does not restore', async () => {
    // Half a bot is worse than a refusal: a newer layout could be half-applied.
    const root = project();
    const dir = botBackupDir(root, 'ada', '2026-09-07T14-03-11Z');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 2, bot: 'ada' }));
    await expect(readBackupManifest(dir)).rejects.toThrow(/version 2 is not one this build/);
  });

  it('refuses an unreadable manifest', async () => {
    const root = project();
    const dir = botBackupDir(root, 'ada', '2026-09-07T14-03-11Z');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), 'not json');
    await expect(readBackupManifest(dir)).rejects.toThrow(/not a readable backup manifest/);
  });
});

describe('listBackups with a restore living beside the backups', () => {
  it('counts only stamp-shaped directories', async () => {
    // A restore writes its live `workspace/` next to the stamps. Counting it as
    // a backup would give it a slot in the prune's ordering — and since
    // `workspace` sorts after every stamp, make it the "newest" one.
    const root = project();
    await makeBundle(root, '2026-09-01T00-00-00Z');
    await makeBundle(root, '2026-09-02T00-00-00Z');
    await makeBundle(root, '2026-09-03T00-00-00Z');
    mkdirSync(join(root, '.agentbox', 'bots', 'ada', 'workspace'), { recursive: true });
    await linkLatest(root, 'ada', '2026-09-03T00-00-00Z');

    expect(await listBackups(root, 'ada')).toEqual([
      '2026-09-03T00-00-00Z',
      '2026-09-02T00-00-00Z',
      '2026-09-01T00-00-00Z',
    ]);

    const removed = await pruneBackups(root, 'ada', 2);
    expect(removed).toEqual(['2026-09-01T00-00-00Z']);
    // The live tree is untouched by a prune, whatever `--keep` says.
    expect(await resolveBotBundle(root, 'ada')).toMatchObject({ stamp: '2026-09-03T00-00-00Z' });
  });
});
