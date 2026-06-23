import { mkdir, mkdtemp, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findUnsyncableSymlinks } from '../src/claude.js';

// findUnsyncableSymlinks pre-scans the host trees for symlinks the in-container
// rsync (run with --copy-unsafe-links) can't dereference, so they can be
// --exclude'd before the sync aborts with exit 23 ("symlink has no referent").
describe('findUnsyncableSymlinks', () => {
  let dir: string;
  let claudeRoot: string;
  let agentsRoot: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'unsyncable-'));
    claudeRoot = join(dir, '.claude');
    agentsRoot = join(dir, '.agents');
    await mkdir(claudeRoot, { recursive: true });
    await mkdir(agentsRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('flags a symlink whose target is outside every reachable root', async () => {
    await mkdir(join(claudeRoot, 'skills', 'foo'), { recursive: true });
    await writeFile(join(dir, 'outside.md'), 'x');
    await symlink(join(dir, 'outside.md'), join(claudeRoot, 'skills', 'foo', 'SKILL.md'));

    const out = await findUnsyncableSymlinks(claudeRoot, [claudeRoot, agentsRoot]);
    expect(out).toEqual(['skills/foo/SKILL.md']);
  });

  it('flags a symlink broken on the host', async () => {
    await mkdir(join(claudeRoot, 'debug'), { recursive: true });
    await symlink(join(claudeRoot, 'debug', 'gone.log'), join(claudeRoot, 'debug', 'latest'));

    const out = await findUnsyncableSymlinks(claudeRoot, [claudeRoot, agentsRoot]);
    expect(out).toEqual(['debug/latest']);
  });

  it('keeps a symlink whose target is inside a reachable root', async () => {
    await mkdir(join(agentsRoot, 'skills', 'ok'), { recursive: true });
    await writeFile(join(agentsRoot, 'skills', 'ok', 'SKILL.md'), 'x');
    await mkdir(join(claudeRoot, 'skills'), { recursive: true });
    // ~/.claude/skills/ok -> ~/.agents/skills/ok (a reachable tree)
    await symlink(join(agentsRoot, 'skills', 'ok'), join(claudeRoot, 'skills', 'ok'));

    const out = await findUnsyncableSymlinks(claudeRoot, [claudeRoot, agentsRoot]);
    expect(out).toEqual([]);
  });

  // The regression: a reachable symlinked dir hides an unsyncable link one level
  // down. rsync dereferences the reachable dir link and descends, then aborts on
  // the nested absolute link — so the pre-scan must recurse and report it under
  // the symlink's transfer path (skills/agentbox/SKILL.md), not the resolved
  // ~/.agents path.
  it('flags a nested unsyncable link reached through a reachable symlinked dir', async () => {
    await mkdir(join(agentsRoot, 'skills', 'agentbox'), { recursive: true });
    await writeFile(join(dir, 'repo-skill.md'), 'x');
    await symlink(
      join(dir, 'repo-skill.md'),
      join(agentsRoot, 'skills', 'agentbox', 'SKILL.md'),
    );
    await mkdir(join(claudeRoot, 'skills'), { recursive: true });
    await symlink(join(agentsRoot, 'skills', 'agentbox'), join(claudeRoot, 'skills', 'agentbox'));

    const out = await findUnsyncableSymlinks(claudeRoot, [claudeRoot, agentsRoot]);
    expect(out).toEqual(['skills/agentbox/SKILL.md']);
  });
});
