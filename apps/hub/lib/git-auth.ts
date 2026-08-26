import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { secretsEnvPath } from '@agentbox/sandbox-core';

const execFileAsync = promisify(execFile);

/**
 * The hub's own GitHub credential (`hub.gitAuth=gh`).
 *
 * In this mode the hub does the git work itself — it clones for the create
 * worker and runs the real `git push` at the end of the relay's bundle path, so
 * a box asks the hub to push and never receives a credential of its own. That
 * needs exactly one thing: a token on PATH-visible git and `gh`.
 *
 * `GH_TOKEN` is the native spelling for both. `gh` authenticates from it
 * directly (which is why `assertGhReady` in @agentbox/relay short-circuits on
 * it), and `gh auth setup-git` points git's credential helper at the same
 * value — so clone, push, and the `gh.pr.*` host actions all authenticate from
 * one place with no per-consumer wiring.
 *
 * The value lives in the data-volume `~/.agentbox/secrets.env`, alongside the
 * provider credentials, rather than in the compose `environment:` block — the
 * deploy already avoids that for secrets because it is readable from
 * `docker inspect` and the compose logs.
 */
const TOKEN_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;

/** Parse `KEY=value` lines, tolerating `export ` and surrounding quotes. */
function parseEnvFile(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice('export '.length) : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) out[key] = value;
  }
  return out;
}

/**
 * Import the stored GitHub token into `process.env` so git and `gh` see it.
 * Mirrors each provider's `ensure*EnvLoaded()`: an already-set `process.env`
 * value always wins, so an operator can override per-deploy without editing the
 * file. Returns the token when one is now available.
 */
export function loadHubGitToken(): string | undefined {
  for (const key of TOKEN_KEYS) {
    const fromEnv = process.env[key];
    if (fromEnv !== undefined && fromEnv.length > 0) {
      // Normalize onto GH_TOKEN so a GITHUB_TOKEN-only setup still drives `gh`.
      process.env['GH_TOKEN'] ??= fromEnv;
      return fromEnv;
    }
  }
  const path = secretsEnvPath();
  if (!existsSync(path)) return undefined;
  let parsed: Record<string, string>;
  try {
    parsed = parseEnvFile(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  for (const key of TOKEN_KEYS) {
    const value = parsed[key];
    if (typeof value === 'string' && value.length > 0) {
      process.env[key] = value;
      process.env['GH_TOKEN'] ??= value;
      return value;
    }
  }
  return undefined;
}

/**
 * Point git's credential helper at `gh` so a bare `git clone`/`git push`
 * authenticates with the token above. Idempotent (it rewrites the same global
 * config entries) and best-effort: a hub with no token, or an image without
 * `gh`, must still boot — the failure then surfaces on the first git operation
 * with a real message rather than as a dead container.
 */
export async function configureHubGitCredentials(
  log: (line: string) => void,
): Promise<'configured' | 'no-token' | 'failed'> {
  const token = loadHubGitToken();
  if (!token) return 'no-token';
  try {
    await execFileAsync('gh', ['auth', 'setup-git'], { timeout: 30_000 });
    log('git credentials configured from the stored GitHub token (gh auth setup-git)');
    return 'configured';
  } catch (err) {
    log(
      `git credential setup failed (${err instanceof Error ? err.message : String(err)}) — ` +
        'clone/push will fall back to whatever git can authenticate with',
    );
    return 'failed';
  }
}
