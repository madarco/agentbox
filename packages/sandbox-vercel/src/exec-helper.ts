/**
 * Non-interactive exec bridge for Vercel boxes: the detached agent pre-start
 * (`-i` queue worker, hub worker, new-tab attach) and `logs`. The interactive
 * PTY attach still drives the external `sbx exec -i` (see build-attach.ts).
 *
 * Why not `sbx exec` here too: the host's `sbx` is whatever the user installed,
 * and sbx 3.x (undici 7.26) fails every compressed response under Node 26 with
 * "Sandbox API request failed … 200 OK". This helper runs the in-process
 * `@vercel/sandbox` SDK that AgentBox itself pins, so the agent start no longer
 * depends on the host CLI's version or the Node it runs on.
 *
 * It is a standalone process (not an in-process call) because `buildAttach`
 * returns an argv that the CLI and the hub worker spawn; keeping that contract
 * means no change to the shared `Provider` interface.
 *
 * Argv: `node exec-helper.cjs --sandbox-id <name> [--user <name>]`.
 * Env (never argv, so nothing leaks through `ps`):
 *   VERCEL_AUTH_TOKEN             access token
 *   AGENTBOX_VERCEL_TEAM_ID       team id
 *   AGENTBOX_VERCEL_PROJECT_ID    project id
 *   AGENTBOX_VERCEL_INNER_CMD     the bash command to run (renderInnerCommand)
 *
 * stdout/stderr stream live; the exit code mirrors the command's (1 when it has
 * none). An SDK error exits 1 with the message on stderr.
 */

import { Sandbox } from '@vercel/sandbox';

function parseArgs(argv: string[]): { sandboxId: string; user: string } {
  let sandboxId: string | undefined;
  let user = 'vscode';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sandbox-id') sandboxId = argv[++i];
    else if (a === '--user') user = argv[++i] ?? user;
  }
  if (!sandboxId) {
    process.stderr.write('exec-helper: --sandbox-id is required\n');
    process.exit(2);
  }
  if (!/^[a-z_][a-z0-9_-]*$/i.test(user)) {
    process.stderr.write(`exec-helper: invalid --user ${JSON.stringify(user)}\n`);
    process.exit(2);
  }
  return { sandboxId, user };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`exec-helper: ${name} env is required\n`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const { sandboxId, user } = parseArgs(process.argv.slice(2));
  const token = requireEnv('VERCEL_AUTH_TOKEN');
  const teamId = requireEnv('AGENTBOX_VERCEL_TEAM_ID');
  const projectId = requireEnv('AGENTBOX_VERCEL_PROJECT_ID');
  const inner = requireEnv('AGENTBOX_VERCEL_INNER_CMD');

  // A Ctrl-C on a followed `logs` stops the stream instead of leaving the
  // helper waiting on a command that never ends.
  const abort = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => abort.abort());
  }

  try {
    const sb = await Sandbox.get({ name: sandboxId, resume: false, token, teamId, projectId });
    // Same shape as the sbx path and the backend's exec: start as root, then
    // drop to the box user with a login shell so HOME/PATH are the user's.
    const r = await sb.runCommand({
      cmd: 'sudo',
      args: ['-u', user, '-H', 'bash', '-lc', inner],
      sudo: true,
      stdout: process.stdout,
      stderr: process.stderr,
      signal: abort.signal,
    });
    // exitCode, not exit(): piped stdio is async on macOS and exit() can drop
    // the tail of the output. A missing code (killed by a signal) is a failure.
    process.exitCode = typeof r.exitCode === 'number' ? r.exitCode : 1;
  } catch (err) {
    if (abort.signal.aborted) {
      process.exitCode = 130;
      return;
    }
    process.stderr.write(
      `exec-helper: vercel exec failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}

void main();
