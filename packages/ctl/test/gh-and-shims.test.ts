import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { postRpc } from '../src/relay-rpc.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const GH_SHIM = join(REPO_ROOT, 'packages/sandbox-docker/scripts/gh-shim');
const GIT_SHIM = join(REPO_ROOT, 'packages/sandbox-docker/scripts/git-shim');
const NTN_SHIM = join(REPO_ROOT, 'packages/sandbox-docker/scripts/ntn-shim');

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
): { code: number; stdout: string; stderr: string } {
  const res = spawnSync('bash', [shimPath, ...args], {
    cwd: env.tmpDir,
    env: {
      ...process.env,
      AGENTBOX_CTL_PATH: env.ctlPath,
      AGENTBOX_REAL_GIT_PATH: '/usr/bin/git',
    },
    encoding: 'utf8',
  });
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
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

  it('push --tags is rejected (better safe than compatible)', () => {
    const env = makeStubShell();
    try {
      const out = runShim(GIT_SHIM, ['push', '--tags'], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/unsupported flag '--tags'/);
    } finally {
      env.cleanup();
    }
  });

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

describe('ntn-shim subcommand allowlist', () => {
  it('whoami forwards to integration notion whoami', () => {
    const env = makeStubShell();
    try {
      const out = runShim(NTN_SHIM, ['whoami'], env);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('STUB: integration notion whoami --');
    } finally {
      env.cleanup();
    }
  });

  it('api endpoint forwards to integration notion api', () => {
    const env = makeStubShell();
    try {
      const out = runShim(NTN_SHIM, ['api', 'v1/users/me'], env);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('STUB: integration notion api -- v1/users/me');
    } finally {
      env.cleanup();
    }
  });

  it('api forwards write-shaped argv intact (relay enforces GET-only)', () => {
    // The shim does NOT replicate refuseApiNonGet — that's the relay's job.
    // It must hand through -X POST / -f field=value so the relay sees the
    // real argv and can refuse, instead of the agent thinking the call
    // succeeded silently.
    const env = makeStubShell();
    try {
      const out = runShim(
        NTN_SHIM,
        ['api', 'v1/pages', '-X', 'POST', '-f', 'title=hi'],
        env,
      );
      expect(out.code).toBe(0);
      expect(out.stdout).toContain(
        'STUB: integration notion api -- v1/pages -X POST -f title=hi',
      );
    } finally {
      env.cleanup();
    }
  });

  it('api with no endpoint is rejected', () => {
    const env = makeStubShell();
    try {
      const out = runShim(NTN_SHIM, ['api'], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/'api' requires a positional <endpoint>/);
    } finally {
      env.cleanup();
    }
  });

  it('pages create forwards to integration notion page.create', () => {
    const env = makeStubShell();
    try {
      const out = runShim(
        NTN_SHIM,
        ['pages', 'create', '--parent', 'db_id', '--title', 'hi'],
        env,
      );
      expect(out.code).toBe(0);
      expect(out.stdout).toContain(
        'STUB: integration notion page.create -- --parent db_id --title hi',
      );
    } finally {
      env.cleanup();
    }
  });

  it('pages update forwards to integration notion page.update', () => {
    const env = makeStubShell();
    try {
      const out = runShim(NTN_SHIM, ['pages', 'update', 'page_id', '--archive'], env);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain(
        'STUB: integration notion page.update -- page_id --archive',
      );
    } finally {
      env.cleanup();
    }
  });

  it('pages list is rejected', () => {
    const env = makeStubShell();
    try {
      const out = runShim(NTN_SHIM, ['pages', 'list'], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/unsupported 'pages list'/);
    } finally {
      env.cleanup();
    }
  });

  it('pages with no subcommand is rejected', () => {
    const env = makeStubShell();
    try {
      const out = runShim(NTN_SHIM, ['pages'], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/missing subcommand for 'pages'/);
    } finally {
      env.cleanup();
    }
  });

  it('comment add is rejected with the deferred message', () => {
    const env = makeStubShell();
    try {
      const out = runShim(NTN_SHIM, ['comment', 'add', '--page', 'pid'], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/comment ops not supported yet/);
    } finally {
      env.cleanup();
    }
  });

  it.each([['login'], ['logout'], ['datasources'], ['workers'], ['files']])(
    'unsupported subcommand %s is rejected with the allowed list',
    (sub) => {
      const env = makeStubShell();
      try {
        const out = runShim(NTN_SHIM, [sub], env);
        expect(out.code).toBe(2);
        expect(out.stderr).toMatch(/is not proxied/);
        expect(out.stderr).toMatch(
          /whoami, api <endpoint>, pages \{create,update\}/,
        );
      } finally {
        env.cleanup();
      }
    },
  );

  it('--version prints the shim version line', () => {
    const env = makeStubShell();
    try {
      const out = runShim(NTN_SHIM, ['--version'], env);
      expect(out.code).toBe(0);
      expect(out.stdout).toMatch(/^ntn version /);
      expect(out.stdout).toContain('agentbox-shim');
    } finally {
      env.cleanup();
    }
  });

  it('no args fails with the supported-subcommands hint', () => {
    const env = makeStubShell();
    try {
      const out = runShim(NTN_SHIM, [], env);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/no subcommand/);
    } finally {
      env.cleanup();
    }
  });
});
