import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { postRpc } from '../src/relay-rpc.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const GH_SHIM = join(REPO_ROOT, 'packages/sandbox-docker/scripts/gh-shim');
const GIT_SHIM = join(REPO_ROOT, 'packages/sandbox-docker/scripts/git-shim');

interface StubShellEnv {
  tmpDir: string;
  ctlPath: string;
  cleanup: () => void;
}

/**
 * Set up a tmpdir with a stub `agentbox-ctl` that prints `STUB: <argv>` and
 * exits 0. Returns the path to the stub so a shim test can point
 * AGENTBOX_CTL_PATH at it. Also git-inits the tmpdir on
 * `agentbox/test-branch` so the shim's `git rev-parse --abbrev-ref HEAD`
 * returns a predictable branch for the auto-injection tests.
 */
function makeStubShell(): StubShellEnv {
  const tmpDir = mkdtempSync(join(tmpdir(), 'agentbox-shim-test-'));
  const ctlPath = join(tmpDir, 'agentbox-ctl-stub');
  writeFileSync(
    ctlPath,
    `#!/usr/bin/env bash\nprintf 'STUB: %s\\n' "$*"\nexit 0\n`,
    { mode: 0o755 },
  );
  chmodSync(ctlPath, 0o755);
  // Real git init + commit so `git rev-parse --abbrev-ref HEAD` returns the
  // branch name rather than "HEAD" (which is what an unborn branch yields).
  // Author env is set explicitly so the test never depends on a global git
  // user.email/user.name being configured — under turbo's parallel run this
  // failed intermittently with "Please tell me who you are" → exit 128.
  // GIT_CONFIG_GLOBAL=/dev/null bypasses ~/.gitconfig entirely so a user's
  // commit.gpgsign (which would prompt for a passphrase on the GPG key and
  // fail in CI / pnpm test) doesn't apply to the test commit.
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'agentbox-test',
    GIT_AUTHOR_EMAIL: 'agentbox-test@example.invalid',
    GIT_COMMITTER_NAME: 'agentbox-test',
    GIT_COMMITTER_EMAIL: 'agentbox-test@example.invalid',
  };
  const init = spawnSync('git', ['init', '-q', '-b', 'agentbox/test-branch', tmpDir], {
    env,
    stdio: 'pipe',
  });
  if (init.status !== 0) {
    throw new Error(`git init failed: ${init.stderr.toString()}`);
  }
  const commit = spawnSync('git', ['-C', tmpDir, 'commit', '--allow-empty', '-qm', 'init'], {
    env,
    stdio: 'pipe',
  });
  if (commit.status !== 0) {
    throw new Error(`git commit failed: ${commit.stderr.toString()}`);
  }
  return {
    tmpDir,
    ctlPath,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function runShim(
  shimPath: string,
  args: string[],
  env: StubShellEnv,
  extraEnv: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const res = spawnSync('bash', [shimPath, ...args], {
    cwd: env.tmpDir,
    env: {
      ...process.env,
      AGENTBOX_CTL_PATH: env.ctlPath,
      AGENTBOX_REAL_GIT_PATH: '/usr/bin/git',
      ...extraEnv,
    },
    encoding: 'utf8',
  });
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

/**
 * Stub `git` that prints `REAL_GIT: <argv>` — lets a test prove the shim fell
 * through to the real binary instead of relaying to `agentbox-ctl`.
 */
function makeRealGitStub(env: StubShellEnv): string {
  const p = join(env.tmpDir, 'real-git-stub');
  writeFileSync(p, `#!/usr/bin/env bash\nprintf 'REAL_GIT: %s\\n' "$*"\nexit 0\n`, {
    mode: 0o755,
  });
  chmodSync(p, 0o755);
  return p;
}

describe('agentbox-ctl gh pr * wire shape', () => {
  it('postRpc body is { method: "gh.pr.view", params: { path, args } }', async () => {
    const { createServer } = await import('node:http');
    let received = '';
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        received = body;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ exitCode: 0, stdout: '', stderr: '' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const prevUrl = process.env.AGENTBOX_RELAY_URL;
    const prevTok = process.env.AGENTBOX_RELAY_TOKEN;
    process.env.AGENTBOX_RELAY_URL = `http://127.0.0.1:${String(port)}`;
    process.env.AGENTBOX_RELAY_TOKEN = 'stub';
    try {
      await postRpc('gh.pr.view', {
        path: '/workspace',
        args: ['--json', 'number,url,reviewDecision'],
      });
      const parsed = JSON.parse(received) as { method: string; params: unknown };
      expect(parsed.method).toBe('gh.pr.view');
      expect(parsed.params).toEqual({
        path: '/workspace',
        args: ['--json', 'number,url,reviewDecision'],
      });
    } finally {
      if (prevUrl === undefined) delete process.env.AGENTBOX_RELAY_URL;
      else process.env.AGENTBOX_RELAY_URL = prevUrl;
      if (prevTok === undefined) delete process.env.AGENTBOX_RELAY_TOKEN;
      else process.env.AGENTBOX_RELAY_TOKEN = prevTok;
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    }
  });

  it('postRpc body is { method: "gh.repo.clone", params: { path, repo, targetPath, args } }', async () => {
    const { createServer } = await import('node:http');
    let received = '';
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        received = body;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ exitCode: 0, stdout: '', stderr: '' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const prevUrl = process.env.AGENTBOX_RELAY_URL;
    const prevTok = process.env.AGENTBOX_RELAY_TOKEN;
    process.env.AGENTBOX_RELAY_URL = `http://127.0.0.1:${String(port)}`;
    process.env.AGENTBOX_RELAY_TOKEN = 'stub';
    try {
      await postRpc('gh.repo.clone', {
        path: '/workspace',
        repo: 'foo/bar',
        targetPath: 'mydir',
        args: ['--branch', 'main', '--depth', '1'],
      });
      const parsed = JSON.parse(received) as { method: string; params: unknown };
      expect(parsed.method).toBe('gh.repo.clone');
      expect(parsed.params).toEqual({
        path: '/workspace',
        repo: 'foo/bar',
        targetPath: 'mydir',
        args: ['--branch', 'main', '--depth', '1'],
      });
    } finally {
      if (prevUrl === undefined) delete process.env.AGENTBOX_RELAY_URL;
      else process.env.AGENTBOX_RELAY_URL = prevUrl;
      if (prevTok === undefined) delete process.env.AGENTBOX_RELAY_TOKEN;
      else process.env.AGENTBOX_RELAY_TOKEN = prevTok;
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    }
  });
});

describe('gh-shim arg whitelist + branch injection', () => {
  it('--version emits a sniffable "gh version" line', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['--version'], env);
      expect(out.code).toBe(0);
      expect(out.stdout).toMatch(/^gh version /);
    } finally {
      env.cleanup();
    }
  });

  it('auth status returns success without round-tripping the relay', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['auth', 'status'], env);
      expect(out.code).toBe(0);
      expect(out.stderr).toMatch(/logged in to github\.com/i);
    } finally {
      env.cleanup();
    }
  });

  it('pr view with no positional injects the current branch', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['pr', 'view'], env);
      expect(out.code).toBe(0);
      expect(out.stdout.trim()).toBe('STUB: gh pr view -- agentbox/test-branch');
    } finally {
      env.cleanup();
    }
  });

  it('pr view with explicit positional leaves it alone', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['pr', 'view', '42'], env);
      expect(out.code).toBe(0);
      expect(out.stdout.trim()).toBe('STUB: gh pr view -- 42');
    } finally {
      env.cleanup();
    }
  });

  it('pr view --json passes through the JSON field list AND still injects branch', () => {
    // Regression: a naive `first_positional` treated `number,url` as the
    // positional ref because it didn't know `--json` takes a value, so it
    // skipped branch injection and the host resolved against `main`. The
    // PR badge then went dark even though the box was on a branch with a PR.
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['pr', 'view', '--json', 'number,url'], env);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('STUB: gh pr view -- agentbox/test-branch --json number,url');
    } finally {
      env.cleanup();
    }
  });

  it('pr comment --body still injects branch as positional ref', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['pr', 'comment', '--body', 'looks good'], env);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('STUB: gh pr comment -- agentbox/test-branch --body looks good');
    } finally {
      env.cleanup();
    }
  });

  it('pr list auto-injects --head <branch>', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['pr', 'list'], env);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('--head agentbox/test-branch');
    } finally {
      env.cleanup();
    }
  });

  it('pr create injects --head <branch> when missing', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['pr', 'create', '--fill', '--draft'], env);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('--head agentbox/test-branch');
      expect(out.stdout).toContain('--fill');
      expect(out.stdout).toContain('--draft');
    } finally {
      env.cleanup();
    }
  });

  it('pr diff with no positional injects the current branch', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['pr', 'diff'], env);
      expect(out.code).toBe(0);
      expect(out.stdout.trim()).toBe('STUB: gh pr diff -- agentbox/test-branch');
    } finally {
      env.cleanup();
    }
  });

  it('pr checks --json injects branch and passes the field list', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['pr', 'checks', '--json', 'name,state'], env);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('STUB: gh pr checks -- agentbox/test-branch --json name,state');
    } finally {
      env.cleanup();
    }
  });

  it('run list forwards to ctl', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['run', 'list', '--limit', '5'], env);
      expect(out.code).toBe(0);
      expect(out.stdout.trim()).toBe('STUB: gh run list -- --limit 5');
    } finally {
      env.cleanup();
    }
  });

  it('run view forwards a run-id', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['run', 'view', '12345', '--log-failed'], env);
      expect(out.code).toBe(0);
      expect(out.stdout.trim()).toBe('STUB: gh run view -- 12345 --log-failed');
    } finally {
      env.cleanup();
    }
  });

  it('run view requires a run-id or --job', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['run', 'view'], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/requires a positional <run-id>/);
    } finally {
      env.cleanup();
    }
  });

  it('run rerun forwards a run-id', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['run', 'rerun', '12345'], env);
      expect(out.code).toBe(0);
      expect(out.stdout.trim()).toBe('STUB: gh run rerun -- 12345');
    } finally {
      env.cleanup();
    }
  });

  it('run watch is rejected with a pointer to run view', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['run', 'watch', '12345'], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/not proxied/);
      expect(out.stderr).toMatch(/gh run view/);
    } finally {
      env.cleanup();
    }
  });

  it('api forwards an allowed endpoint to ctl', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['api', 'repos/o/r/pulls/5/comments'], env);
      expect(out.code).toBe(0);
      expect(out.stdout.trim()).toBe('STUB: gh api repos/o/r/pulls/5/comments --');
    } finally {
      env.cleanup();
    }
  });

  it('api requires a positional endpoint', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['api', '--paginate'], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/requires a positional <endpoint>/);
    } finally {
      env.cleanup();
    }
  });

  it('api forwards POST method + field flags to ctl (relay enforces the policy)', () => {
    const env = makeStubShell();
    try {
      const out = runShim(
        GH_SHIM,
        ['api', 'repos/o/r/pulls/5/comments', '-X', 'POST', '-f', 'body=hi'],
        env,
      );
      expect(out.code).toBe(0);
      expect(out.stdout.trim()).toBe(
        'STUB: gh api repos/o/r/pulls/5/comments -- -X POST -f body=hi',
      );
    } finally {
      env.cleanup();
    }
  });

  it('api forwards field flags (field-implied POST) to ctl', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['api', 'repos/o/r/pulls/5/comments', '-f', 'body=hi'], env);
      expect(out.code).toBe(0);
      expect(out.stdout.trim()).toBe('STUB: gh api repos/o/r/pulls/5/comments -- -f body=hi');
    } finally {
      env.cleanup();
    }
  });

  it('api rejects --input at the shim (stdin/file body cannot cross the relay)', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['api', 'repos/o/r/pulls/5/comments', '--input', '-'], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/--input/);
    } finally {
      env.cleanup();
    }
  });

  it('rejects unknown top-level subcommands (gh issue)', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['issue', 'list'], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/not proxied/);
    } finally {
      env.cleanup();
    }
  });

  it('rejects un-whitelisted gh pr view flags (e.g. --comments)', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['pr', 'view', '--comments'], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/unsupported flag '--comments'/);
    } finally {
      env.cleanup();
    }
  });

  it('repo clone requires a positional repo', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['repo', 'clone'], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/requires a positional/);
    } finally {
      env.cleanup();
    }
  });

  it('repo clone accepts repo + --branch + --depth, with no `--` separator', () => {
    // Regression: the prior implementation passed `gh repo clone -- <repo>
    // --branch X` to the ctl. Commander treats `--` as end-of-options and
    // every flag after it as a positional, so the ctl's `--branch <name>`
    // option never saw the value — the clone went to the wrong branch and
    // the host's `gh` ran with stale defaults. Now we split positionals
    // from flags and emit them in commander-friendly order (positionals
    // first), no `--` in the middle.
    const env = makeStubShell();
    try {
      const out = runShim(
        GH_SHIM,
        ['repo', 'clone', 'foo/bar', 'mydir', '--branch', 'main', '--depth', '1'],
        env,
      );
      expect(out.code).toBe(0);
      expect(out.stdout.trim()).toBe(
        'STUB: gh repo clone foo/bar mydir --branch main --depth 1',
      );
      // Critically: NO `--` separator anywhere in the ctl invocation.
      expect(out.stdout).not.toContain(' -- ');
    } finally {
      env.cleanup();
    }
  });

  it('repo clone with just a repo (no dir) emits clean ctl invocation', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['repo', 'clone', 'foo/bar'], env);
      expect(out.code).toBe(0);
      expect(out.stdout.trim()).toBe('STUB: gh repo clone foo/bar');
    } finally {
      env.cleanup();
    }
  });

  it('repo clone rejects extra positionals', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GH_SHIM, ['repo', 'clone', 'foo/bar', 'mydir', 'extra'], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/too many positionals/);
    } finally {
      env.cleanup();
    }
  });
});

describe('git-shim arg whitelist + passthrough', () => {
  it('push with no args forwards to ctl', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GIT_SHIM, ['push'], env);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('STUB: git push --');
    } finally {
      env.cleanup();
    }
  });

  it('push --force-with-lease is allowed', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GIT_SHIM, ['push', '--force-with-lease'], env);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('--force-with-lease');
    } finally {
      env.cleanup();
    }
  });

  it('push --quiet --dry-run is allowed', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GIT_SHIM, ['push', '--quiet', '--dry-run'], env);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('STUB: git push -- --quiet --dry-run');
    } finally {
      env.cleanup();
    }
  });

  it.each([['--mirror'], ['--delete'], ['--prune'], ['--force']])(
    'push %s is rejected (destructive on the remote)',
    (flag) => {
      const env = makeStubShell();
      try {
        const out = runShim(GIT_SHIM, ['push', flag], env);
        expect(out.code).toBe(2);
        expect(out.stderr).toMatch(new RegExp(`unsupported flag '${flag}'`));
      } finally {
        env.cleanup();
      }
    },
  );

  it('push origin main is rejected (positional refspec)', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GIT_SHIM, ['push', 'origin', 'main'], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/positional 'origin' not allowed/);
    } finally {
      env.cleanup();
    }
  });

  // Regression: `git fetch --quiet` used to exit 2, killing user scripts under
  // `set -e`. --prune was the only flag fetch accepted.
  it('fetch --quiet is allowed', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GIT_SHIM, ['fetch', '--quiet'], env);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('STUB: git fetch -- --quiet');
    } finally {
      env.cleanup();
    }
  });

  it('fetch --prune --quiet forwards both flags', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GIT_SHIM, ['fetch', '--prune', '--quiet'], env);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('STUB: git fetch -- --prune --quiet');
    } finally {
      env.cleanup();
    }
  });

  it('pull --ff-only is allowed', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GIT_SHIM, ['pull', '--ff-only'], env);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('STUB: git pull -- --ff-only');
    } finally {
      env.cleanup();
    }
  });

  it('fetch --all is rejected (the relay always passes a remote+branch)', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GIT_SHIM, ['fetch', '--all'], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/unsupported flag '--all'/);
    } finally {
      env.cleanup();
    }
  });

  // The two halves of the value-less invariant: a flag that takes a value can't
  // be smuggled in glued (regex is exact-match) or split (the value reads as a
  // positional). This is what keeps --upload-pack= and friends out for free.
  it('fetch --upload-pack=/bin/sh is rejected (glued value)', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GIT_SHIM, ['fetch', '--upload-pack=/bin/sh'], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/unsupported flag '--upload-pack=\/bin\/sh'/);
    } finally {
      env.cleanup();
    }
  });

  it('fetch --depth 1 is rejected (off-list flag)', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GIT_SHIM, ['fetch', '--depth', '1'], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/unsupported flag '--depth'/);
    } finally {
      env.cleanup();
    }
  });

  it('a value after an allowed fetch flag is rejected as a positional', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GIT_SHIM, ['fetch', '--prune', '1'], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/positional '1' not allowed/);
    } finally {
      env.cleanup();
    }
  });

  it('clone --recurse-submodules is rejected', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GIT_SHIM, ['clone', '--recurse-submodules', 'https://x/y.git'], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/unsupported flag '--recurse-submodules'/);
    } finally {
      env.cleanup();
    }
  });

  // A local clone touches no credentials, so it must bypass the relay entirely
  // — flag gate included. This is the exact call agentbox's own cloud workspace
  // seeding makes, which is what lets `create --provider <cloud>` run in a box.
  it('clone from file:// falls through to real git with --no-checkout intact', () => {
    const env = makeStubShell();
    try {
      const realGit = makeRealGitStub(env);
      const out = runShim(
        GIT_SHIM,
        ['clone', '--no-checkout', '--quiet', '--depth=200', 'file:///workspace', '/tmp/clone'],
        env,
        { AGENTBOX_REAL_GIT_PATH: realGit },
      );
      expect(out.code).toBe(0);
      expect(out.stdout).toContain(
        'REAL_GIT: clone --no-checkout --quiet --depth=200 file:///workspace /tmp/clone',
      );
      expect(out.stdout).not.toContain('STUB:');
    } finally {
      env.cleanup();
    }
  });

  it('clone from an absolute path falls through to real git', () => {
    const env = makeStubShell();
    try {
      const realGit = makeRealGitStub(env);
      const out = runShim(GIT_SHIM, ['clone', '/srv/repo.git'], env, {
        AGENTBOX_REAL_GIT_PATH: realGit,
      });
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('REAL_GIT: clone /srv/repo.git');
    } finally {
      env.cleanup();
    }
  });

  // `--branch <val>` consumes its value, so the source scan must not mistake a
  // branch name for the clone source and wrongly fall through.
  it('clone --branch <name> from a remote still relays to ctl', () => {
    const env = makeStubShell();
    try {
      const realGit = makeRealGitStub(env);
      const out = runShim(GIT_SHIM, ['clone', '--branch', 'main', 'https://x/y.git'], env, {
        AGENTBOX_REAL_GIT_PATH: realGit,
      });
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('STUB: git clone https://x/y.git --branch main');
      expect(out.stdout).not.toContain('REAL_GIT:');
    } finally {
      env.cleanup();
    }
  });

  // The fall-through must not become a hole: a real remote keeps the flag gate.
  it('clone --no-checkout from a remote url is still rejected', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GIT_SHIM, ['clone', '--no-checkout', 'https://x/y.git'], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/unsupported flag '--no-checkout'/);
    } finally {
      env.cleanup();
    }
  });

  // Options we don't model also take a value. If the scan guessed flag arity,
  // that value would read as the clone source and hand real git a REMOTE clone,
  // slipping the relay and the whitelist. Classify every token instead.
  it.each([
    ['--reference', '/tmp/ref'],
    ['--separate-git-dir', '/tmp/gitdir'],
    ['--upload-pack', '/usr/bin/git-upload-pack'],
    ['--reference-if-able', '/tmp/ref'],
  ])('clone %s <path> before a remote url does not bypass the gate', (flag, value) => {
    const env = makeStubShell();
    try {
      const realGit = makeRealGitStub(env);
      const out = runShim(GIT_SHIM, ['clone', flag, value, 'https://github.com/x/y.git'], env, {
        AGENTBOX_REAL_GIT_PATH: realGit,
      });
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/unsupported flag/);
      expect(out.stdout).not.toContain('REAL_GIT:');
      expect(out.stdout).not.toContain('STUB:');
    } finally {
      env.cleanup();
    }
  });

  // scp-style and ssh:// remotes must not be mistaken for local paths either.
  it.each([['git@github.com:owner/name.git'], ['ssh://git@host/owner/name.git']])(
    'clone %s is treated as remote, not local',
    (url) => {
      const env = makeStubShell();
      try {
        const realGit = makeRealGitStub(env);
        const out = runShim(GIT_SHIM, ['clone', url, '/tmp/dest'], env, {
          AGENTBOX_REAL_GIT_PATH: realGit,
        });
        expect(out.stdout).not.toContain('REAL_GIT:');
      } finally {
        env.cleanup();
      }
    },
  );

  // Ambiguous/unrecognized source (no local token at all) ⇒ gate, not real git.
  it('clone of a bare remote name falls to the gate, not real git', () => {
    const env = makeStubShell();
    try {
      const realGit = makeRealGitStub(env);
      const out = runShim(GIT_SHIM, ['clone', 'myremote'], env, {
        AGENTBOX_REAL_GIT_PATH: realGit,
      });
      expect(out.stdout).not.toContain('REAL_GIT:');
      expect(out.stdout).toContain('STUB: git clone myremote');
    } finally {
      env.cleanup();
    }
  });

  it('clone of owner/name shorthand still relays to ctl', () => {
    const env = makeStubShell();
    try {
      const realGit = makeRealGitStub(env);
      const out = runShim(GIT_SHIM, ['clone', 'owner/name', '/abs/dest'], env, {
        AGENTBOX_REAL_GIT_PATH: realGit,
      });
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('STUB: git clone owner/name /abs/dest');
      expect(out.stdout).not.toContain('REAL_GIT:');
    } finally {
      env.cleanup();
    }
  });

  it('clone with no url is rejected', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GIT_SHIM, ['clone'], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/requires a positional <url>/);
    } finally {
      env.cleanup();
    }
  });

  it('clone url + dir + --branch + --depth lands in ctl call shape', () => {
    const env = makeStubShell();
    try {
      const out = runShim(
        GIT_SHIM,
        ['clone', '--branch', 'main', '--depth', '1', 'https://github.com/x/y.git', 'mytarget'],
        env,
      );
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('git clone https://github.com/x/y.git mytarget --branch main --depth 1');
    } finally {
      env.cleanup();
    }
  });

  it('status falls through to real /usr/bin/git', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GIT_SHIM, ['status'], env);
      expect(out.code).toBe(0);
      expect(out.stdout).toMatch(/On branch agentbox\/test-branch/);
    } finally {
      env.cleanup();
    }
  });
});
