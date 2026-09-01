/**
 * Regressions for the three defects Bugbot found on PR #355 (commit c0d09b31).
 *
 * Pinned as tests rather than fixed silently: Bugbot reviews a PR ONCE and does
 * not re-review after a later push, so the fixes themselves get no second pass.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { BOX_WORKSPACE } from '@agentbox/cli-kit';
import { piAuthFileHasProviders } from '../src/auth-shape.js';
import { stagePiCredentialsForUpload } from '../src/host-stage.js';
import { resolvePiTeleport } from '../src/cli/teleport.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pi-bugbot-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("Pi's first-run `{}` is not a login", () => {
  it('rejects an empty object, accepts one with a provider', async () => {
    const p = join(home, 'auth.json');
    await writeFile(p, '{}');
    expect(await piAuthFileHasProviders(p)).toBe(false);
    await writeFile(p, '  {  }  ');
    expect(await piAuthFileHasProviders(p)).toBe(false);
    await writeFile(p, 'not json');
    expect(await piAuthFileHasProviders(p)).toBe(false);
    expect(await piAuthFileHasProviders(join(home, 'nope.json'))).toBe(false);
    await writeFile(p, JSON.stringify({ anthropic: { type: 'oauth', refresh: 'r' } }));
    expect(await piAuthFileHasProviders(p)).toBe(true);
  });

  it('stages nothing for an empty auth.json, rather than an empty credential', async () => {
    // The real failure: `{}` staged into a cloud box looks present and
    // authenticates nothing, and the sign-in offer is skipped on top.
    await mkdir(join(home, '.pi', 'agent'), { recursive: true });
    await writeFile(join(home, '.pi', 'agent', 'auth.json'), '{}');
    const empty = await stagePiCredentialsForUpload({ hostHome: home });
    expect(empty.tarballPath).toBeNull();
    await empty.cleanup();

    await writeFile(
      join(home, '.pi', 'agent', 'auth.json'),
      JSON.stringify({ anthropic: { type: 'oauth' } }),
    );
    const real = await stagePiCredentialsForUpload({ hostHome: home });
    expect(real.tarballPath).not.toBeNull();
    await real.cleanup();
  });
});

describe('the docker launch carries the registry launchFlags', () => {
  it('declares -a, and the starter prepends whatever is declared', async () => {
    // `-a` is Pi's project-TRUST flag. Without it an interactive docker launch
    // into a repo carrying a `.pi/` dir blocks on a prompt the host cannot
    // answer. There is no shared docker launch path that applies these (the
    // generic one, in sandbox-cloud, is cloud-only), so the agent's own starter
    // must -- which is what this had wrong.
    expect(resolveAgentSpec('pi').launchFlags).toContain('-a');
    const src = await readFile(new URL('../src/docker-sync.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/const flags = PI_SPEC\.launchFlags \?\? \[\];/);
    expect(src).toMatch(/\[PI_SPEC\.binary, \.\.\.flags, \.\.\.opts\.piArgs\]/);
  });
});

describe('teleport rewrites the session cwd unconditionally', () => {
  it('repoints a session recorded in ANOTHER directory at /workspace', async () => {
    const recordedAt = '/Users/someone/elsewhere';
    const dir = join(home, '.pi', 'agent', 'sessions', '--slug--');
    await mkdir(dir, { recursive: true });
    const uuid = '01a05d65-d505-79ac-a4e8-ac555aac9386';
    const file = join(dir, `2026-01-01T00-00-00-000Z_${uuid}.jsonl`);
    const transcript = JSON.stringify({
      type: 'message',
      message: { role: 'user', content: 'hi' },
    });
    await writeFile(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: uuid, cwd: recordedAt }),
        transcript,
        '',
      ].join('\n'),
    );

    // `--resume <id>` deliberately allows a session from another directory: the
    // resolver warns and continues. A hostCwd-anchored rewrite did nothing for
    // exactly that case.
    const r = await resolvePiTeleport({
      hostCwd: '/Users/someone/a-different-project',
      mode: { kind: 'resume', id: uuid },
      hostHome: home,
    });
    const lines = (await readFile(r.hostFile, 'utf8')).split('\n');
    expect((JSON.parse(lines[0]!) as { cwd: string }).cwd).toBe(BOX_WORKSPACE);
    expect(lines[1]).toBe(transcript); // transcript untouched
    expect(r.forwardArgs[0]).toBe('--session');
  });
});
