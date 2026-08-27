import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseToolNames } from '../src/tool-links-watcher.js';
import { listToolLinks, syncToolLinks } from '../src/tool-links.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const TOOL_SHIM = join(REPO_ROOT, 'packages/sandbox-docker/scripts/agentbox-tool-shim');

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'agentbox-tool-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A stub `agentbox-ctl` that echoes its argv, so we can see what the shim forwards. */
function stubCtl(dir: string): string {
  const p = join(dir, 'ctl-stub');
  writeFileSync(p, `#!/usr/bin/env bash\nprintf 'STUB: %s\\n' "$*"\nexit 0\n`, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

describe('agentbox-tool-shim', () => {
  // The whole design rests on this: one baked file, and the tool name comes
  // from argv[0]. If basename resolution broke, every tool would forward
  // under the wrong name.
  it('resolves its tool name from the symlink it was invoked as', () => {
    const dir = scratch();
    const ctl = stubCtl(dir);
    symlinkSync(TOOL_SHIM, join(dir, 'terraform'));
    const out = spawnSync(join(dir, 'terraform'), ['plan', '-out', 'x'], {
      encoding: 'utf8',
      env: { ...process.env, AGENTBOX_CTL_PATH: ctl },
    });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('STUB: tool run terraform -- plan -out x');
  });

  it('forwards a different symlink under its own name', () => {
    const dir = scratch();
    const ctl = stubCtl(dir);
    symlinkSync(TOOL_SHIM, join(dir, 'aws'));
    const out = spawnSync(join(dir, 'aws'), ['s3', 'ls'], {
      encoding: 'utf8',
      env: { ...process.env, AGENTBOX_CTL_PATH: ctl },
    });
    expect(out.stdout).toContain('STUB: tool run aws -- s3 ls');
  });

  // Flags must reach the host verbatim — the shim does no argv filtering by
  // design (the relay is the boundary), so nothing may be swallowed here.
  it('forwards flags verbatim, including ones that look like its own', () => {
    const dir = scratch();
    const ctl = stubCtl(dir);
    symlinkSync(TOOL_SHIM, join(dir, 'kubectl'));
    const out = spawnSync(join(dir, 'kubectl'), ['get', 'pods', '--all-namespaces', '-o', 'json'], {
      encoding: 'utf8',
      env: { ...process.env, AGENTBOX_CTL_PATH: ctl },
    });
    expect(out.stdout).toContain('STUB: tool run kubectl -- get pods --all-namespaces -o json');
  });

  it('forwards a bare invocation with no args', () => {
    const dir = scratch();
    const ctl = stubCtl(dir);
    symlinkSync(TOOL_SHIM, join(dir, 'terraform'));
    const out = spawnSync(join(dir, 'terraform'), [], {
      encoding: 'utf8',
      env: { ...process.env, AGENTBOX_CTL_PATH: ctl },
    });
    expect(out.stdout).toContain('STUB: tool run terraform --');
  });
});

describe('syncToolLinks', () => {
  const shim = '/usr/local/bin/agentbox-tool-shim';

  it('creates one link per granted tool', async () => {
    const dir = scratch();
    const r = await syncToolLinks(['terraform', 'aws'], { dir, shim });
    expect(r.added.sort()).toEqual(['aws', 'terraform']);
    expect(r.conflicts).toEqual([]);
  });

  it('is idempotent — a second sync adds nothing', async () => {
    const dir = scratch();
    await syncToolLinks(['terraform'], { dir, shim });
    const r = await syncToolLinks(['terraform'], { dir, shim });
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  // A revoked grant must make the command stop resolving, not linger.
  it('removes links for tools no longer granted', async () => {
    const dir = scratch();
    await syncToolLinks(['terraform', 'aws'], { dir, shim });
    const r = await syncToolLinks(['terraform'], { dir, shim });
    expect(r.removed).toEqual(['aws']);
  });

  // Clobbering a user's real binary would lose their install; shadowing it
  // silently with a host proxy would be a nasty surprise. Neither: report it.
  it('refuses to clobber a real file and reports the conflict', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'terraform'), '#!/bin/sh\necho real\n', { mode: 0o755 });
    const r = await syncToolLinks(['terraform'], { dir, shim });
    expect(r.added).toEqual([]);
    expect(r.conflicts).toEqual(['terraform']);
  });

  it('leaves unrelated files in the dir alone', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    const r = await syncToolLinks(['terraform'], { dir, shim });
    expect(r.removed).toEqual([]);
  });

  // Reported by review: the daemon reconciler and an approved `tool request`
  // both sync these links. A reconciler holding a list fetched before the
  // grant landed would delete the link the request just created — killing the
  // immediate-use guarantee. Pruning is confined to a pre-fetch snapshot.
  it('a stale reconcile does not delete a link created after its snapshot', async () => {
    const dir = scratch();
    await syncToolLinks(['terraform'], { dir, shim });
    const snapshot = await listToolLinks({ dir, shim });
    expect(snapshot).toEqual(['terraform']);

    // The request path adds `say` while the reconciler's list is in flight.
    await syncToolLinks(['terraform', 'say'], { dir, shim, prunable: [] });

    // The reconciler now applies its stale list (no `say`) — but may only
    // prune what it saw before it asked.
    const stale = await syncToolLinks(['terraform'], { dir, shim, prunable: snapshot });
    expect(stale.removed).toEqual([]);
    const after = await listToolLinks({ dir, shim });
    expect(after.sort()).toEqual(['say', 'terraform']);
  });

  it('the additive path never prunes, even when the list shrinks', async () => {
    const dir = scratch();
    await syncToolLinks(['terraform', 'aws'], { dir, shim });
    const r = await syncToolLinks(['terraform'], { dir, shim, prunable: [] });
    expect(r.removed).toEqual([]);
    expect((await listToolLinks({ dir, shim })).sort()).toEqual(['aws', 'terraform']);
  });

  // The next tick, with a fresh snapshot, still converges.
  it('a fresh reconcile prunes a revoked link', async () => {
    const dir = scratch();
    await syncToolLinks(['terraform', 'aws'], { dir, shim });
    const snapshot = await listToolLinks({ dir, shim });
    const r = await syncToolLinks(['terraform'], { dir, shim, prunable: snapshot });
    expect(r.removed).toEqual(['aws']);
  });

  it('ignores names that could escape the link dir', async () => {
    const dir = scratch();
    const r = await syncToolLinks(['../../evil', 'ok'], { dir, shim });
    expect(r.added).toEqual(['ok']);
  });
});

describe('parseToolNames', () => {
  it('reads the json tool.list payload', () => {
    expect(parseToolNames('{"tools":[{"name":"aws","bin":"aws"}]}')).toEqual(['aws']);
  });

  // A payload we can't read must leave the links alone, not tear them down.
  it('returns null on unparseable output so the watcher makes no changes', () => {
    expect(parseToolNames('not json')).toBeNull();
    expect(parseToolNames('{"unexpected":1}')).toBeNull();
  });
});
