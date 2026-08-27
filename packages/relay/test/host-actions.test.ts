import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeCloudAction, resolveHostGitRepo, resolveHostPath } from '../src/host-actions.js';
import { ghRunContext } from '../src/gh.js';
import type { HostAction } from '../src/types.js';

/**
 * Pure routing-level tests for `executeCloudAction`. The cloud backend +
 * sandbox-cloud helpers are loaded via dynamic `import()` keyed by string,
 * which makes them hard to mock from vitest without a full module shim.
 * These tests focus on the routing surface (unknown method, parameter
 * validation, prompt denial) that doesn't actually need the cloud SDK.
 */
describe('executeCloudAction routing', () => {
  function makeDeps(): Parameters<typeof executeCloudAction>[1] {
    return {
      backendName: 'daytona',
      boxId: 'box1',
      boxName: 'b1',
      // Omit prompts/subscribers so askPrompt-gated paths short-circuit on
      // the existence checks (and so we don't accidentally block awaiting a
      // prompt nobody will answer).
      log: () => {},
    };
  }

  function action(method: string, params: unknown = {}): HostAction {
    return {
      id: 'action-1',
      boxId: 'box1',
      method,
      params,
      createdAt: new Date().toISOString(),
    };
  }

  it('resolveHostPath: relative paths resolve against the box workspace, not the relay CWD', () => {
    const ws = '/Users/marco/Projects/AgentBox/agentbox';
    // The reported bug: a relative path must land under the box workspace.
    expect(resolveHostPath(ws, 'agentbox.yaml')).toBe(`${ws}/agentbox.yaml`);
    expect(resolveHostPath(ws, './sub/x.txt')).toBe(`${ws}/sub/x.txt`);
    // Absolute paths pass through untouched.
    expect(resolveHostPath(ws, '/tmp/out.txt')).toBe('/tmp/out.txt');
    // `~`/`~/` expand against the host home (path.resolve doesn't do this).
    expect(resolveHostPath(ws, '~')).toBe(homedir());
    expect(resolveHostPath(ws, '~/notes.md')).toBe(join(homedir(), 'notes.md'));
    // Unknown workspace falls back to CWD-relative (legacy behaviour).
    expect(resolveHostPath(undefined, '/abs/ok')).toBe('/abs/ok');
  });

  it('returns a clear "not supported" error for unknown methods', async () => {
    const result = await executeCloudAction(action('unknown.method'), makeDeps());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("'unknown.method'");
    expect(result.stderr).toContain('not yet supported');
  });

  it('cp.* with missing params returns exit 64 (invalid arguments)', async () => {
    // Only boxPath, no hostPath → legacy fallback can't complete, no sources.
    const r1 = await executeCloudAction(action('cp.toHost', { boxPath: '/x' }), makeDeps());
    expect(r1.exitCode).toBe(64);
    expect(r1.stderr).toContain('requires a non-empty {sources}');
    const r2 = await executeCloudAction(action('cp.fromHost', {}), makeDeps());
    expect(r2.exitCode).toBe(64);
  });

  it('download.* with non-workspace kind returns clear "not supported" error', async () => {
    const result = await executeCloudAction(action('download.env'), makeDeps());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('download.env is not yet supported');
    expect(result.stderr).toContain('only download.workspace');
  });

  it('checkpoint.create without AGENTBOX_CLI_ENTRY returns exit 64', async () => {
    const prevEntry = process.env['AGENTBOX_CLI_ENTRY'];
    delete process.env['AGENTBOX_CLI_ENTRY'];
    try {
      const result = await executeCloudAction(action('checkpoint.create'), makeDeps());
      expect(result.exitCode).toBe(64);
      expect(result.stderr).toContain('AGENTBOX_CLI_ENTRY not set');
    } finally {
      if (prevEntry !== undefined) process.env['AGENTBOX_CLI_ENTRY'] = prevEntry;
    }
  });

  it('browser.open.mirror with bad URL silently succeeds (no host action)', async () => {
    const result = await executeCloudAction(
      action('browser.open.mirror', { url: 'file:///etc/passwd' }),
      makeDeps(),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('browser.open.mirror without prompts/subscribers silently succeeds', async () => {
    const result = await executeCloudAction(
      action('browser.open.mirror', { url: 'https://example.com' }),
      makeDeps(),
    );
    // No prompts/subscribers => can't ask; falls through to exit 0 (the
    // box already opened it in-sandbox, the mirror is purely best-effort).
    expect(result.exitCode).toBe(0);
  });

  // gh.exec parity with docker: the same blocklist / destructive / checkout
  // decisions must apply whichever provider the box runs on.
  it('gh.exec with no args returns exit 64', async () => {
    const result = await executeCloudAction(action('gh.exec', { args: [] }), makeDeps());
    expect(result.exitCode).toBe(64);
  });

  it('gh.exec refuses a blocked call before touching the host', async () => {
    const result = await executeCloudAction(
      action('gh.exec', { args: ['auth', 'token'] }),
      makeDeps(),
    );
    expect(result.exitCode).toBe(65);
    expect(result.stderr).toMatch(/credential/i);
  });

  it('gh.exec pr checkout stays refused by default (env-gated)', async () => {
    const prev = process.env['AGENTBOX_GH_PR_CHECKOUT'];
    delete process.env['AGENTBOX_GH_PR_CHECKOUT'];
    try {
      const result = await executeCloudAction(
        action('gh.exec', { args: ['pr', 'checkout', '1'] }),
        makeDeps(),
      );
      expect(result.exitCode).toBe(13);
      expect(result.stderr).toContain('disabled by default');
    } finally {
      if (prev !== undefined) process.env['AGENTBOX_GH_PR_CHECKOUT'] = prev;
    }
  });

  it('gh.exec refuses gh api --input (stdin cannot traverse the relay)', async () => {
    const result = await executeCloudAction(
      action('gh.exec', { args: ['api', 'repos/o/r/issues', '--input', 'f.json'] }),
      makeDeps(),
    );
    expect(result.exitCode).toBe(65);
    expect(result.stderr).toContain('--input');
  });
});

/**
 * A control box has no working copy of any project: the create worker clones
 * into a temp dir and deletes it in a `finally`, so `BoxRecord.workspacePath`
 * points at a path that no longer exists. Before this, `runGitRpc` ran
 * `git -C <deleted path>` and surfaced a raw ENOENT. It now falls back to a
 * throwaway repo and pushes to the box's REGISTERED origin — never one the box
 * supplied, which could redirect the host's credentials to an attacker.
 */
describe('resolveHostGitRepo', () => {
  const made: string[] = [];
  afterEach(async () => {
    await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  const deps = (originUrl?: string): Parameters<typeof resolveHostGitRepo>[1] => ({
    backendName: 'daytona',
    boxId: 'box1',
    originUrl,
  });

  it('uses the real checkout when one exists, and does not touch the origin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentbox-hgr-real-'));
    made.push(dir);
    const repo = await resolveHostGitRepo(dir, deps('https://github.com/o/r.git'), 'origin');
    expect(repo).toMatchObject({ dir, remote: 'origin', scratch: false });
    // Cleanup is a no-op for a real checkout — it must never delete the user's repo.
    await repo.cleanup();
    expect(existsSync(dir)).toBe(true);
  });

  it('creates a real git repo pointed at the registered origin when the checkout is gone', async () => {
    const gone = join(tmpdir(), 'agentbox-hgr-does-not-exist-xyz');
    const repo = await resolveHostGitRepo(gone, deps('https://github.com/o/r.git'), 'origin');
    made.push(repo.dir);
    expect(repo.scratch).toBe(true);
    // The push target is the URL, not the remote NAME: a scratch repo has no remotes.
    expect(repo.remote).toBe('https://github.com/o/r.git');
    expect(repo.dir).not.toBe(gone);
    const inside = await execa('git', ['-C', repo.dir, 'rev-parse', '--git-dir'], {
      reject: false,
    });
    expect(inside.exitCode).toBe(0);
    await repo.cleanup();
    expect(existsSync(repo.dir)).toBe(false);
  });

  it('rewrites an SSH origin to HTTPS for a scratch push (a control box has no SSH key)', async () => {
    const gone = join(tmpdir(), 'agentbox-hgr-does-not-exist-xyz');
    const repo = await resolveHostGitRepo(gone, deps('git@github.com:o/r.git'), 'origin');
    made.push(repo.dir);
    expect(repo.remote).toBe('https://github.com/o/r.git');
    const url = await resolveHostGitRepo(gone, deps('ssh://git@github.com/o/r.git'), 'origin');
    made.push(url.dir);
    expect(url.remote).toBe('https://github.com/o/r.git');
  });

  it('leaves an unparseable origin alone rather than failing the push early', async () => {
    const gone = join(tmpdir(), 'agentbox-hgr-does-not-exist-xyz');
    const repo = await resolveHostGitRepo(gone, deps('/srv/mirrors/r.git'), 'origin');
    made.push(repo.dir);
    expect(repo.remote).toBe('/srv/mirrors/r.git');
  });

  it('refuses rather than guessing when there is no checkout and no registered origin', async () => {
    const gone = join(tmpdir(), 'agentbox-hgr-does-not-exist-xyz');
    await expect(resolveHostGitRepo(gone, deps(undefined), 'origin')).rejects.toThrow(
      /no registered origin URL/,
    );
    // Whitespace-only is treated as absent, not as a push target.
    await expect(resolveHostGitRepo(gone, deps('   '), 'origin')).rejects.toThrow(
      /no registered origin URL/,
    );
  });
});

describe('ghRunContext', () => {
  it('runs gh in the host checkout untouched when one exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentbox-ghctx-'));
    try {
      expect(ghRunContext(dir, 'git@github.com:o/r.git', ['create'])).toEqual({
        cwd: dir,
        args: ['create'],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to a real cwd and names the repo when the checkout is gone', () => {
    const gone = join(tmpdir(), 'agentbox-ghctx-does-not-exist-xyz');
    // A missing cwd makes the spawn fail as `spawn gh ENOENT` — never pass it through.
    expect(ghRunContext(gone, 'git@github.com:o/r.git', ['create'])).toEqual({
      cwd: tmpdir(),
      args: ['--repo', 'o/r', 'create'],
    });
  });

  it('does not second-guess an explicit --repo / -R, or an unusable origin', () => {
    const gone = join(tmpdir(), 'agentbox-ghctx-does-not-exist-xyz');
    expect(ghRunContext(gone, 'git@github.com:o/r.git', ['--repo', 'x/y', 'view'])).toEqual({
      cwd: tmpdir(),
      args: ['--repo', 'x/y', 'view'],
    });
    expect(ghRunContext(gone, 'git@github.com:o/r.git', ['-R', 'x/y', 'view'])).toEqual({
      cwd: tmpdir(),
      args: ['-R', 'x/y', 'view'],
    });
    expect(ghRunContext(gone, undefined, ['view'])).toEqual({ cwd: tmpdir(), args: ['view'] });
    expect(ghRunContext(gone, '/srv/mirrors/r.git', ['view'])).toEqual({
      cwd: tmpdir(),
      args: ['view'],
    });
  });
});
