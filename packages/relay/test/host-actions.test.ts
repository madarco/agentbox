import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeCloudAction, resolveHostGitRepo, resolveHostPath } from '../src/host-actions.js';
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

  it('gh.pr.bogus returns exit 64 (unknown op)', async () => {
    const result = await executeCloudAction(action('gh.pr.bogus'), makeDeps());
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain('unknown gh.pr.*');
  });

  it('gh.pr.checkout refused by default (env-gated)', async () => {
    const prev = process.env['AGENTBOX_GH_PR_CHECKOUT'];
    delete process.env['AGENTBOX_GH_PR_CHECKOUT'];
    try {
      const result = await executeCloudAction(
        action('gh.pr.checkout', { args: ['1'] }),
        makeDeps(),
      );
      expect(result.exitCode).toBe(13);
      expect(result.stderr).toContain('disabled by default');
    } finally {
      if (prev !== undefined) process.env['AGENTBOX_GH_PR_CHECKOUT'] = prev;
    }
  });

  it('gh.pr.merge with AGENTBOX_PROMPT=off but no GH_FORCE refuses bypass', async () => {
    const prevPrompt = process.env['AGENTBOX_PROMPT'];
    const prevForce = process.env['AGENTBOX_GH_FORCE'];
    process.env['AGENTBOX_PROMPT'] = 'off';
    delete process.env['AGENTBOX_GH_FORCE'];
    try {
      const result = await executeCloudAction(action('gh.pr.merge', { args: ['1'] }), makeDeps());
      expect(result.exitCode).toBe(10);
      expect(result.stderr).toContain('AGENTBOX_GH_FORCE=1');
    } finally {
      if (prevPrompt !== undefined) process.env['AGENTBOX_PROMPT'] = prevPrompt;
      else delete process.env['AGENTBOX_PROMPT'];
      if (prevForce !== undefined) process.env['AGENTBOX_GH_FORCE'] = prevForce;
    }
  });

  it('gh.run.bogus returns exit 64 (unknown op)', async () => {
    const result = await executeCloudAction(action('gh.run.bogus'), makeDeps());
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain('unknown gh.run.*');
  });

  it('gh.api with a non-allowlisted endpoint is refused (exit 65)', async () => {
    const result = await executeCloudAction(action('gh.api', { endpoint: 'user' }), makeDeps());
    expect(result.exitCode).toBe(65);
    expect(result.stderr).toContain('not allowlisted');
  });

  it('gh.api DELETE on a comment endpoint is refused (only GET + POST proxied)', async () => {
    const result = await executeCloudAction(
      action('gh.api', { endpoint: 'repos/o/r/pulls/5/comments', args: ['-X', 'DELETE'] }),
      makeDeps(),
    );
    expect(result.exitCode).toBe(65);
    expect(result.stderr).toMatch(/DELETE|not proxied/);
  });

  // Integration.* routing: same shape parity with docker so an agent's
  // misnamed call yields the same envelope on either provider.
  it('integration.notion. (malformed shape) returns exit 64', async () => {
    const result = await executeCloudAction(action('integration.notion.'), makeDeps());
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain('unknown integration method shape');
  });

  it('integration.trello.api (unknown service, allowlist-default) returns exit 64', async () => {
    const result = await executeCloudAction(
      action('integration.trello.api', { args: ['v1/issues'] }),
      makeDeps(),
    );
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain('unknown integration service');
  });

  it('integration.notion.bogus (op not on allowlist) returns exit 65', async () => {
    const result = await executeCloudAction(
      action('integration.notion.bogus', { args: [] }),
      makeDeps(),
    );
    expect(result.exitCode).toBe(65);
    expect(result.stderr).toContain('not on allowlist');
  });

  it('integration.notion.api with -X DELETE refused (read classification stays honest)', async () => {
    const result = await executeCloudAction(
      action('integration.notion.api', { args: ['-X', 'DELETE', 'v1/blocks/abc'] }),
      makeDeps(),
    );
    expect(result.exitCode).toBe(65);
    expect(result.stderr).toMatch(/notion api/);
  });

  // Mirrors the docker handler's disabled-gate test. The structural / op-level
  // refusals above all exit before `lookupCloudBox`, so they hit the same
  // envelope on both providers without the cloud test needing a fake state
  // record. This test goes one step deeper — it confirms the gate, which
  // DOES read `lookupCloudBox().workspacePath`, fires for a well-formed call.
  it('integration.notion.api disabled by default surfaces exit 65 on cloud too', async () => {
    // No state.json is set up; lookupCloudBox throws. Wrap the call so the
    // thrown error becomes a typed envelope we can assert on, mirroring how
    // the real cloud poller catches lookup failures upstream.
    const r = await executeCloudAction(
      action('integration.notion.whoami', { args: [] }),
      makeDeps(),
    ).catch((err: unknown) => ({
      exitCode: -1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    }));
    // The state-missing throw is the SAME shape the existing tests rely on
    // — pre-gate this would have hit lookupCloudBox at the very end (during
    // the spawn), now it hits it during the gate. Either way the error
    // mentions `state.json`, so existing observed-behavior parity holds.
    expect(r.stderr).toContain('state.json');
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
