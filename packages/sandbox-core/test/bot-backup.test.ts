import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRecordingTransport } from '../src/sync/recording-transport.js';
import {
  backupAgentState,
  backupStamp,
  botBackupDir,
  ensureBackupGitignored,
  linkLatest,
  listBackups,
  pruneBackups,
  writeBackupManifest,
} from '../src/sync/concerns/bot-backup.js';

function project(): string {
  return mkdtempSync(join(tmpdir(), 'agentbox-bot-backup-'));
}

function makeBackups(root: string, bot: string, stamps: string[]): void {
  for (const s of stamps) {
    mkdirSync(join(botBackupDir(root, bot, s), 'workspace'), { recursive: true });
  }
}

describe('backupStamp', () => {
  it('sorts lexicographically in chronological order', () => {
    // Every consumer here (prune, `latest`, "which is newest") sorts the
    // directory names; `readdir` order is not defined.
    const a = backupStamp(new Date('2026-09-06T09:12:40.123Z'));
    const b = backupStamp(new Date('2026-09-07T14:03:11.999Z'));
    expect([b, a].sort()).toEqual([a, b]);
  });

  it('contains no character that is awkward in a path', () => {
    // `:` is not portable in a path (and is a drive separator on Windows).
    expect(backupStamp(new Date('2026-09-07T14:03:11Z'))).toBe('2026-09-07T14-03-11Z');
  });
});

describe('pruneBackups', () => {
  it('keeps the N newest and removes the rest', () => {
    const root = project();
    makeBackups(root, 'ada', [
      '2026-09-01T00-00-00Z',
      '2026-09-02T00-00-00Z',
      '2026-09-03T00-00-00Z',
    ]);
    return pruneBackups(root, 'ada', 2).then((removed) => {
      expect(removed).toEqual(['2026-09-01T00-00-00Z']);
      expect(readdirSync(join(root, '.agentbox', 'bots', 'ada')).sort()).toEqual([
        '2026-09-02T00-00-00Z',
        '2026-09-03T00-00-00Z',
      ]);
    });
  });

  it('never removes what latest points at', async () => {
    // A dangling `latest` is worse than one extra directory: a restore reads
    // `latest`, and the only way the two disagree is a hand-written link.
    const root = project();
    makeBackups(root, 'ada', ['2026-09-01T00-00-00Z', '2026-09-02T00-00-00Z']);
    await linkLatest(root, 'ada', '2026-09-01T00-00-00Z');
    const removed = await pruneBackups(root, 'ada', 1);
    expect(removed).toEqual([]);
  });

  it('does nothing for a bot that has never been backed up', async () => {
    expect(await pruneBackups(project(), 'nobody', 3)).toEqual([]);
    expect(await listBackups(project(), 'nobody')).toEqual([]);
  });

  it('does not count the latest symlink as a backup', async () => {
    const root = project();
    makeBackups(root, 'ada', ['2026-09-01T00-00-00Z']);
    await linkLatest(root, 'ada', '2026-09-01T00-00-00Z');
    expect(await listBackups(root, 'ada')).toEqual(['2026-09-01T00-00-00Z']);
  });
});

describe('linkLatest', () => {
  it('writes a RELATIVE link so a copied bundle still resolves', async () => {
    // An absolute link dangles the moment the project is moved or shared,
    // which is one of the things a backup is for.
    const root = project();
    makeBackups(root, 'ada', ['2026-09-03T00-00-00Z']);
    await linkLatest(root, 'ada', '2026-09-03T00-00-00Z');
    expect(readlinkSync(join(root, '.agentbox', 'bots', 'ada', 'latest'))).toBe(
      '2026-09-03T00-00-00Z',
    );
  });

  it('is idempotent across runs', async () => {
    const root = project();
    makeBackups(root, 'ada', ['a', 'b']);
    await linkLatest(root, 'ada', 'a');
    await linkLatest(root, 'ada', 'b');
    expect(readlinkSync(join(root, '.agentbox', 'bots', 'ada', 'latest'))).toBe('b');
  });
});

describe('ensureBackupGitignored', () => {
  function repo(): string {
    const root = project();
    execFileSync('git', ['init', '-q'], { cwd: root });
    return root;
  }

  it('adds the entry once, and reports that it did', async () => {
    const root = repo();
    expect(await ensureBackupGitignored(root)).toBe(true);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.agentbox/');
  });

  it('does not append a duplicate on the second run', async () => {
    const root = repo();
    await ensureBackupGitignored(root);
    expect(await ensureBackupGitignored(root)).toBe(false);
    const body = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(body.match(/^\.agentbox\/$/gm)).toHaveLength(1);
  });

  it('respects an entry the user spelled differently', async () => {
    // The question is "is it ignored", not "does my line appear" — the rule can
    // come from a global excludes file or a differently-spelled pattern, and
    // appending to someone's .gitignore anyway is rude.
    const root = repo();
    writeFileSync(join(root, '.gitignore'), '/.agentbox\n');
    expect(await ensureBackupGitignored(root)).toBe(false);
  });

  it('keeps an existing file intact and does not glue onto its last line', async () => {
    const root = repo();
    writeFileSync(join(root, '.gitignore'), 'dist');
    await ensureBackupGitignored(root);
    const lines = readFileSync(join(root, '.gitignore'), 'utf8').split('\n');
    expect(lines).toContain('dist');
    expect(lines).toContain('.agentbox/');
  });

  it('is a no-op outside a git repo', async () => {
    // A bot's project need not be a repo, and that path cannot leak a backup
    // into a box anyway — the untracked carry-over only exists for a repo.
    const root = project();
    expect(await ensureBackupGitignored(root)).toBe(false);
  });
});

describe('backupAgentState', () => {
  const OPENCLAW_DIR = '/home/vscode/.openclaw';

  it('keeps the identity the push drops, and drops only what is box-specific', async () => {
    // The whole point: `openclaw.json` IS the bot. A capture that reused
    // `staticPaths[].exclude` would restore a DIFFERENT bot, which is not a
    // restore. `tmp` still goes, because its name carries the box user's uid
    // and that differs per provider.
    const t = makeRecordingTransport();
    await backupAgentState({ agent: 'openclaw', transport: t, destDir: join(project(), 'state') });

    const tree = t.ops.find((o) => o.op === 'pullTree');
    expect(tree?.args.boxSrcDir).toBe(OPENCLAW_DIR);
    const exclude = (tree?.args.opts as { exclude: string[] }).exclude;
    expect(exclude).toContain('tmp');
    expect(exclude).not.toContain('openclaw.json');
    expect(exclude).not.toContain('state');
  });

  it('leaves live databases out of the tree copy', async () => {
    // A byte copy of a live WAL triple is a torn read — measured elsewhere in
    // this repo as a 4 KB .sqlite against a 1.79 MB -wal. They come over in the
    // second pass instead.
    const t = makeRecordingTransport();
    await backupAgentState({ agent: 'openclaw', transport: t, destDir: join(project(), 'state') });
    const exclude = (t.ops.find((o) => o.op === 'pullTree')?.args.opts as { exclude: string[] })
      .exclude;
    expect(exclude).toEqual(expect.arrayContaining(['*.sqlite*', '*.db', '*.db-*']));
  });

  it('captures each database through the SQLite backup API, not the tree copy', async () => {
    const t = makeRecordingTransport({
      execResult: (cmd) =>
        cmd.join(' ').includes('find .')
          ? { exitCode: 0, stdout: './state/gateway.sqlite\n', stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' },
    });
    const dest = join(project(), 'state');
    const r = await backupAgentState({ agent: 'openclaw', transport: t, destDir: dest });

    expect(r.databases).toEqual(['state/gateway.sqlite']);
    // `pullSqliteSnapshot` checkpoints into a temp file, pulls THAT, then
    // removes it — a plain pullFile of the live path would be the torn read.
    const pulled = t.ops.find((o) => o.op === 'pullFile');
    expect(pulled?.args.boxSrcPath).toBe(`${OPENCLAW_DIR}/state/gateway.sqlite.agentbox-snapshot`);
    expect(pulled?.args.hostDestPath).toBe(join(dest, 'state/gateway.sqlite'));
  });

  it('does not search the dirs the agent asked to leave behind', async () => {
    // `tmp` holds uid-keyed lock sqlites. Snapshotting those would both waste
    // time and put a box-specific file in the bundle.
    const t = makeRecordingTransport();
    await backupAgentState({ agent: 'openclaw', transport: t, destDir: join(project(), 'state') });
    const find = t.ops.find(
      (o) => o.op === 'exec' && (o.args.cmd as string[]).join(' ').includes('find .'),
    );
    expect((find?.args.cmd as string[]).join(' ')).toContain("-path './tmp' -prune");
  });

  it('reports no databases when the box has none', async () => {
    const t = makeRecordingTransport();
    const r = await backupAgentState({
      agent: 'openclaw',
      transport: t,
      destDir: join(project(), 'state'),
    });
    expect(r.databases).toEqual([]);
    expect(t.ops.some((o) => o.op === 'pullFile')).toBe(false);
  });
});

describe('writeBackupManifest', () => {
  it('records what a restore needs to know before it starts', async () => {
    const dir = join(project(), 'b');
    await writeBackupManifest(dir, {
      version: 1,
      stamp: '2026-09-07T14-03-11Z',
      bot: 'ada',
      boxId: 'abc',
      boxName: 'ada',
      provider: 'docker',
      agent: 'openclaw',
      state: true,
      databases: ['state/gateway.sqlite'],
    });
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(m.provider).toBe('docker');
    expect(m.state).toBe(true);
    expect(m.agent).toBe('openclaw');
  });
});
