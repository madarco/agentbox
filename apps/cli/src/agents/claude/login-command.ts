/**
 * `agentbox claude login` — the one agent login that is a protocol rather than a
 * call.
 *
 * Three modes, picked by `selectLoginMode`:
 *  - guided (a terminal): drive the login container under a pty, print the auth
 *    URL, prompt for the code with our own clack prompt.
 *  - headless (no TTY, or `--headless`): spawn a detached worker that HOLDS the
 *    live `claude auth login`, print the URL, and return. A second invocation
 *    with `--code <CODE>` finishes it. This is what makes login work from CI and
 *    from an orchestrating agent.
 *  - interactive: hand claude's own TUI the terminal (legacy passthrough).
 *
 * The other agents need none of this, which is why the factory's default login
 * body stays small and this replaces it wholesale via `runtime.loginCommand`.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadEffectiveConfig } from '@agentbox/config';
import { ensureImage } from '@agentbox/sandbox-docker';
import type { Command } from 'commander';
import { intro, log, outro, spinner } from '@agentbox/cli-kit';
import { handleLifecycleError } from '../../commands/_errors.js';
import { syncAgentCredentialsIfChanged } from '../../commands/control-plane.js';
import {
  cleanupStaleSessions,
  findLiveSession,
  findPendingSession,
  readLoginState,
  selectLoginMode,
  writeLoginCode,
  writeLoginRequest,
  writeLoginState,
  type LoginState,
} from '../../lib/claude-login-session.js';
import { imageProgress } from '@agentbox/cli-kit';
import { loadPtyBackend } from '@agentbox/cli-kit';
import { signInToClaude } from './runtime.js';

function printAwaitingCode(st: LoginState): void {
  const url = st.url ?? '';
  log.info('To finish signing in, open this URL in a browser and approve access:');
  process.stdout.write(`\n  ${url}\n\n`);
  log.info('Then run:  agentbox claude login --code <CODE>');
  // Stable, greppable marker so an orchestrating agent can grab the URL
  // deterministically regardless of how the prose above is worded.
  process.stdout.write(`AGENTBOX_LOGIN_URL=${url}\n`);
}

/**
 * Headless login (non-TTY / `--headless`): spawn the detached worker that holds
 * the live `claude auth login`, wait for it to publish the auth URL, print it +
 * the `--code` follow-up, and return while the worker keeps waiting. A second
 * `agentbox claude login --code <CODE>` ({@link deliverLoginCode}) finishes it.
 */
async function startHeadlessLogin(args: string[]): Promise<void> {
  // node-pty drives the login; without the prebuild there is no headless path.
  if (!(await loadPtyBackend())) {
    log.error(
      'Headless login needs the node-pty prebuild, which is not installed. Run `agentbox claude login` from an interactive terminal instead.',
    );
    process.exit(1);
  }
  cleanupStaleSessions();
  // Only one live session at a time. Match ANY non-terminal live session (incl.
  // a worker still in `starting`, before its URL is published) so a second
  // `--headless` can't slip through and spawn a duplicate worker.
  const existing = findLiveSession();
  if (existing) {
    if (existing.state.phase === 'awaiting-code' && existing.state.url) {
      log.info('A login is already pending; finish it (or wait for it to expire):');
      printAwaitingCode(existing.state);
    } else {
      log.info(
        'A login is already in progress; wait for it to print its URL, then finish with `agentbox claude login --code <CODE>`.',
      );
    }
    return;
  }

  const cfg = await loadEffectiveConfig(process.cwd());
  const baseImage = cfg.effective.box.image;
  const s = spinner();
  s.start('preparing sandbox image');
  // The detached login worker RUNS claude, so record the claude-layer ref in
  // the request — the base image is agentless.
  const { ref: image } = await ensureImage(baseImage, {
    agents: ['claude'],
    onProgress: imageProgress(s),
  });
  s.stop('image ready');

  const id = randomUUID().slice(0, 8);
  writeLoginRequest(id, {
    image,
    extraArgs: args,
    cwd: process.cwd(),
    createdAt: new Date().toISOString(),
  });

  // This foreground process IS the CLI entry, so argv[1] is the right script to
  // re-exec for the worker; AGENTBOX_CLI_ENTRY wins if a wrapper set it.
  const entry = process.env.AGENTBOX_CLI_ENTRY ?? process.argv[1];
  if (!entry || !existsSync(entry)) {
    log.error('could not resolve the agentbox CLI entry to spawn the login worker');
    process.exit(1);
  }
  const child = spawn(process.execPath, [entry, '_claude-login-worker', id], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  // Publish a `starting` state with the worker pid immediately, so a concurrent
  // `--headless` sees a live session and won't spawn a second worker during the
  // window before the worker itself writes any state.
  if (typeof child.pid === 'number') {
    writeLoginState(id, { phase: 'starting', pid: child.pid, createdAt: new Date().toISOString() });
  }

  // Wait past the worker's own no-URL deadline (60s) so we observe its verdict
  // (awaiting-code or a published error) instead of giving up while it's still
  // working and missing the URL it later prints.
  const deadline = Date.now() + 65_000;
  for (;;) {
    const st = readLoginState(id);
    if (st?.phase === 'awaiting-code' && st.url) {
      printAwaitingCode(st);
      return;
    }
    if (st?.phase === 'error') {
      log.error(`login could not start: ${st.error ?? 'unknown error'}`);
      process.exit(1);
    }
    if (Date.now() > deadline) {
      log.error(
        `timed out waiting for the login URL — see ~/.agentbox/logs/claude-login-${id}.log`,
      );
      process.exit(1);
    }
    await sleep(400);
  }
}

/** Deliver an OAuth code to the pending headless login session and report the outcome. */
async function deliverLoginCode(code: string): Promise<void> {
  cleanupStaleSessions();
  const pending = findPendingSession();
  if (!pending) {
    log.error(
      'No pending login is waiting for a code. Start one first with `agentbox claude login` (or --headless).',
    );
    process.exit(1);
  }
  const { id } = pending;
  const submittedAt = Date.now();
  writeLoginCode(id, code);

  const s = spinner();
  s.start('completing sign-in');
  const deadline = Date.now() + 120_000;
  for (;;) {
    const st = readLoginState(id);
    if (st?.phase === 'done') {
      s.stop(st.warmed ? 'credentials ready' : 'signed in (credential check incomplete)');
      outro('signed in — credentials saved for future boxes');
      return;
    }
    if (st?.phase === 'error') {
      s.stop('sign-in failed');
      log.error(st.error ?? 'login failed');
      process.exit(1);
    }
    // Worker reverted to awaiting-code after our submit → the code was rejected;
    // the session stays valid so a corrected `--code` can retry it.
    if (st?.phase === 'awaiting-code' && st.lastError && Date.parse(st.updatedAt) >= submittedAt) {
      s.stop('code rejected');
      log.error(
        `${st.lastError}. Run \`agentbox claude login --code <CODE>\` again with a fresh code.`,
      );
      process.exit(1);
    }
    if (Date.now() > deadline) {
      s.stop('sign-in timed out');
      log.error('timed out completing sign-in — see the login worker log under ~/.agentbox/logs/');
      process.exit(1);
    }
    await sleep(500);
  }
}

/** Declared BEFORE the factory's `--interactive`, which is the order help prints. */
export function addClaudeLoginOptions(cmd: Command): void {
  cmd
    .option(
      '--headless',
      'drive login without a terminal: print the auth URL, then finish with `--code` (auto-selected when stdin is not a TTY)',
    )
    .option('--code <code>', 'deliver the OAuth code to a pending headless login session');
}

export async function runClaudeLoginCommand(
  args: string[],
  rawOpts: Record<string, unknown>,
): Promise<void> {
  const opts = rawOpts as { headless?: boolean; code?: string; interactive?: boolean };
  const mode = selectLoginMode({
    isTTY: !!process.stdin.isTTY,
    headless: !!opts.headless,
    code: typeof opts.code === 'string',
    interactive: !!opts.interactive,
    ptyAvailable: !!(await loadPtyBackend()),
  });
  try {
    if (mode === 'code') {
      await deliverLoginCode(opts.code as string);
      return;
    }
    if (mode === 'headless') {
      await startHeadlessLogin(args);
      return;
    }
    intro('Signing in to Claude...');
    const cfg = await loadEffectiveConfig(process.cwd());
    const baseImage = cfg.effective.box.image;

    const s = spinner();
    s.start('preparing sandbox image');
    // The throwaway login container RUNS claude; the base image is agentless.
    const { ref: image } = await ensureImage(baseImage, {
      agents: ['claude'],
      onProgress: imageProgress(s),
    });
    s.stop('image ready');

    // Throwaway `docker run` against the shared volume — the written credentials
    // persist there and `syncClaudeCredentials` mirrors them to the host backup,
    // so every later box (shared or isolate) is seeded.
    const res = await signInToClaude(image, args, { passthrough: mode === 'interactive' });
    if (res.cancelled) {
      outro('sign-in cancelled');
      process.exit(1);
    }
    if (!res.ok) {
      log.error(res.error ?? 'login failed');
      // A login method whose output we can't recognize (an exotic `-- --sso`
      // shape) never reaches a prompt; the passthrough still drives it.
      if (res.error?.includes('never printed an auth URL')) {
        log.info("Try `agentbox claude login --interactive` to use claude's own login TUI.");
      }
      process.exit(1);
    }
    outro('signed in — credentials saved for future boxes');
    // A fresh login is exactly when the control box's copy goes stale — push the
    // refreshed backup to custody (best-effort, silent, no-op without a control
    // box or when the hash is unchanged).
    await syncAgentCredentialsIfChanged();
  } catch (err) {
    handleLifecycleError(err);
  }
}
