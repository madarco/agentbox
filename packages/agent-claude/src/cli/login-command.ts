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
import { accountConfigVolume } from '@agentbox/core';
import {
  ensureClaudeVolume,
  resetVolumeAccountState,
  SHARED_CLAUDE_VOLUME,
} from '../docker-sync.js';
import { ensureImage } from '@agentbox/sandbox-docker';
import type { Command } from 'commander';
import type { AgentLoginHost } from '@agentbox/cli-kit';
import { intro, log, outro, spinner } from '@agentbox/cli-kit';
import {
  cleanupStaleSessions,
  findLiveSession,
  findPendingSession,
  describeSessionAccount,
  finishLoginCommand,
  readLoginRequest,
  readLoginState,
  sessionAccountMismatch,
  selectLoginMode,
  writeLoginCode,
  writeLoginRequest,
  writeLoginState,
  type LoginState,
} from './login-session.js';
import { imageProgress } from '@agentbox/cli-kit';
import { loadPtyBackend } from '@agentbox/cli-kit';
import { signInToClaude } from './runtime.js';

/**
 * How the caller finishes a headless login, when it is not the plain command:
 * `credentials renew` finishes with its own `--code` so the login is pushed to
 * the account's boxes too. Set per run by {@link runClaudeLoginCommand}.
 */
let finishOverride: string | undefined;

function finishCommand(account: LoginAccount | undefined): string {
  return finishOverride ?? finishLoginCommand(account);
}

function printAwaitingCode(st: LoginState, account: LoginAccount | undefined): void {
  const url = st.url ?? '';
  log.info(
    `To finish signing in ${describeSessionAccount(account)}, open this URL in a browser and approve access:`,
  );
  process.stdout.write(`\n  ${url}\n\n`);
  log.info(`Then run:  ${finishCommand(account)}`);
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
async function startHeadlessLogin(args: string[], account?: LoginAccount): Promise<void> {
  // node-pty drives the login; without the prebuild there is no headless path.
  if (!(await loadPtyBackend())) {
    throw new Error(
      'Headless login needs the node-pty prebuild, which is not installed. Run `agentbox claude login` from an interactive terminal instead.',
    );
  }
  cleanupStaleSessions();
  // Only one live session at a time. Match ANY non-terminal live session (incl.
  // a worker still in `starting`, before its URL is published) so a second
  // `--headless` can't slip through and spawn a duplicate worker.
  const existing = findLiveSession();
  if (existing) {
    // Never hand out another account's session: its URL signs in whatever the
    // browser approves, and its worker stores it as THAT session's account.
    const pendingAccount = readLoginRequest(existing.id)?.account;
    const mismatch = sessionAccountMismatch(pendingAccount, account);
    if (mismatch) {
      throw new Error(mismatch);
    }
    if (existing.state.phase === 'awaiting-code' && existing.state.url) {
      log.info('A login is already pending; finish it (or wait for it to expire):');
      printAwaitingCode(existing.state, pendingAccount);
    } else {
      log.info(
        `A login is already in progress; wait for it to print its URL, then finish with \`${finishCommand(pendingAccount)}\`.`,
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
  if (account) {
    s.message(`preparing the '${account.id}' account's config`);
    await prepareAccountVolume(account, image);
  }
  s.stop('image ready');

  const id = randomUUID().slice(0, 8);
  writeLoginRequest(id, {
    image,
    extraArgs: args,
    cwd: process.cwd(),
    createdAt: new Date().toISOString(),
    ...(account ? { account } : {}),
  });

  // This foreground process IS the CLI entry, so argv[1] is the right script to
  // re-exec for the worker; AGENTBOX_CLI_ENTRY wins if a wrapper set it.
  const entry = process.env.AGENTBOX_CLI_ENTRY ?? process.argv[1];
  if (!entry || !existsSync(entry)) {
    throw new Error('could not resolve the agentbox CLI entry to spawn the login worker');
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
      printAwaitingCode(st, account);
      return;
    }
    if (st?.phase === 'error') {
      throw new Error(`login could not start: ${st.error ?? 'unknown error'}`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for the login URL — see ~/.agentbox/logs/claude-login-${id}.log`,
      );
    }
    await sleep(400);
  }
}

/** Deliver an OAuth code to the pending headless login session and report the outcome. */
async function deliverLoginCode(code: string, account: LoginAccount | undefined): Promise<void> {
  cleanupStaleSessions();
  const pending = findPendingSession();
  if (!pending) {
    throw new Error(
      'No pending login is waiting for a code. Start one first with `agentbox claude login` (or --headless).',
    );
  }
  const { id } = pending;
  const mismatch = sessionAccountMismatch(readLoginRequest(id)?.account, account);
  if (mismatch) {
    throw new Error(mismatch);
  }
  const submittedAt = Date.now();
  writeLoginCode(id, code);

  const s = spinner();
  s.start('completing sign-in');
  const deadline = Date.now() + 120_000;
  for (;;) {
    const st = readLoginState(id);
    if (st?.phase === 'done') {
      s.stop(st.warmed ? 'credentials ready' : 'signed in (credential check incomplete)');
      const account = readLoginRequest(id)?.account;
      outro(
        account
          ? `signed in as account '${account.id}' — saved for boxes that select it`
          : 'signed in — credentials saved for future boxes',
      );
      return;
    }
    if (st?.phase === 'error') {
      s.stop('sign-in failed');
      throw new Error(st.error ?? 'login failed');
    }
    // Worker reverted to awaiting-code after our submit → the code was rejected;
    // the session stays valid so a corrected `--code` can retry it.
    if (st?.phase === 'awaiting-code' && st.lastError && Date.parse(st.updatedAt) >= submittedAt) {
      s.stop('code rejected');
      throw new Error(
        `${st.lastError}. Run \`${finishCommand(account)}\` again with a fresh code.`,
      );
    }
    if (Date.now() > deadline) {
      s.stop('sign-in timed out');
      throw new Error(
        'timed out completing sign-in — see the login worker log under ~/.agentbox/logs/',
      );
    }
    await sleep(500);
  }
}

/** A named LLM account to sign in, resolved by the shared login wiring. */
export interface LoginAccount {
  id: string;
  label?: string;
}

/** A named account's own config volume (llm-accounts Phase 0: one per account). */
export function claudeAccountVolume(account: LoginAccount): string {
  return accountConfigVolume(SHARED_CLAUDE_VOLUME, account.id);
}

/**
 * Seed a named account's volume from the host's config, minus the host's
 * identity (its login file and cached profile) — see `ensureClaudeVolume`.
 */
async function prepareAccountVolume(account: LoginAccount, image: string): Promise<void> {
  const volume = claudeAccountVolume(account);
  await ensureClaudeVolume({ volume }, { syncFromHost: true, image, account: account.id });
  // A re-login of this account must not inherit the previous login's profile.
  // A corrupt `_claude.json` was removed instead: seed a fresh one (the seed
  // is write-once, so it only fills the gap).
  if ((await resetVolumeAccountState(volume, image)) === 'removed') {
    await ensureClaudeVolume({ volume }, { syncFromHost: true, image, account: account.id });
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
  host: AgentLoginHost,
): Promise<void> {
  const opts = rawOpts as {
    headless?: boolean;
    code?: string;
    interactive?: boolean;
    loginAccount?: LoginAccount;
    finishCommand?: string;
  };
  const account = opts.loginAccount;
  finishOverride = opts.finishCommand;
  const mode = selectLoginMode({
    isTTY: !!process.stdin.isTTY,
    headless: !!opts.headless,
    code: typeof opts.code === 'string',
    interactive: !!opts.interactive,
    ptyAvailable: !!(await loadPtyBackend()),
  });
  try {
    if (mode === 'code') {
      await deliverLoginCode(opts.code as string, account);
      return;
    }
    if (mode === 'headless') {
      await startHeadlessLogin(args, account);
      return;
    }
    intro(
      account ? `Signing in to Claude as account '${account.id}'...` : 'Signing in to Claude...',
    );
    const cfg = await loadEffectiveConfig(process.cwd());
    const baseImage = cfg.effective.box.image;

    const s = spinner();
    s.start('preparing sandbox image');
    // The throwaway login container RUNS claude; the base image is agentless.
    const { ref: image } = await ensureImage(baseImage, {
      agents: ['claude'],
      onProgress: imageProgress(s),
    });
    if (account) {
      s.message(`preparing the '${account.id}' account's config`);
      await prepareAccountVolume(account, image);
    }
    s.stop('image ready');

    // Throwaway `docker run` against the shared volume — the written credentials
    // persist there and `syncClaudeCredentials` mirrors them to the host backup,
    // so every later box (shared or isolate) is seeded. A named account signs
    // in against its own volume instead and is captured into the account store.
    const volume = account ? claudeAccountVolume(account) : undefined;
    // A first login that does not complete must not leave its volume behind.
    const dropOrphan = async (): Promise<void> => {
      if (account && volume) await host.dropOrphanAccountVolume?.({ account, volume });
    };
    const res = await signInToClaude(image, args, {
      passthrough: mode === 'interactive',
      ...(volume ? { volume } : {}),
    });
    if (res.cancelled) {
      await dropOrphan();
      throw new Error('sign-in cancelled');
    }
    if (!res.ok) {
      await dropOrphan();
      // A login method whose output we can't recognize (an exotic `-- --sso`
      // shape) never reaches a prompt; the passthrough still drives it.
      if (res.error?.includes('never printed an auth URL')) {
        log.info("Try `agentbox claude login --interactive` to use claude's own login TUI.");
      }
      throw new Error(res.error ?? 'login failed');
    }
    if (account && volume) {
      try {
        await host.captureAccountLogin({ account, volume, image });
      } catch (err) {
        await dropOrphan();
        throw err;
      }
      return;
    }
    outro('signed in — credentials saved for future boxes');
    // A fresh login is exactly when the control box's copy goes stale — push the
    // refreshed backup to custody (best-effort, silent, no-op without a control
    // box or when the hash is unchanged).
    await host.syncCredentialsIfChanged();
  } catch (err) {
    host.fail(err);
  }
}
