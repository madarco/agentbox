/**
 * The default `agentbox <agent> login` body: run the agent's own sign-in in a
 * throwaway container against its shared config volume, so the result seeds
 * every later box.
 *
 * An agent whose login is a protocol of its own — claude's headless
 * print-URL/`--code` pair — replaces this wholesale via
 * `runtime.loginCommand.run`. That lives on the runtime rather than in the
 * create body's hook set because it is the agent's own auth implementation,
 * next to `signIn` and the two first-run offers, not an escape hatch in shared
 * control flow.
 */
import { loadEffectiveConfig } from '@agentbox/config';
import { ensureImage } from '@agentbox/sandbox-docker';
import type { Command } from 'commander';
import { handleLifecycleError } from '../../commands/_errors.js';
import { syncAgentCredentialsIfChanged } from '../../commands/control-plane.js';
import { intro, log, outro, spinner } from '@agentbox/cli-kit';
import { imageProgress } from '@agentbox/cli-kit';
import { accountConfigVolume, findAccount } from '@agentbox/core';
import { readAccounts } from '@agentbox/sandbox-core';
import { captureAccountLogin } from '../../lib/account-login.js';
import { fanOutDefaultLoginIfSignedIn, readDefaultVolumeLogin } from '../../lib/login-fanout.js';
import type { AgentCliSpec } from '@agentbox/cli-kit';

export interface LoginOptions {
  interactive?: boolean;
}

/** A named login account to sign in instead of the default one. */
export interface LoginAccountTarget {
  id: string;
  label?: string;
}

/** Every agent's CLI descriptor, registered as its `login` is wired. */
const LOGIN_SPECS = new Map<string, AgentCliSpec>();

/** The CLI descriptor of an agent with a `login` (for `credentials add/renew`). */
export function agentLoginSpec(id: string): AgentCliSpec | undefined {
  return LOGIN_SPECS.get(id);
}

/**
 * Refuse `login --account`: commander hands the flag to the parent create
 * command, so without this the default login would be signed in silently.
 */
function refuseNamedAccount(a: AgentCliSpec, cmd: Command): void {
  const name = namedAccountFlag(cmd);
  if (name === undefined) return;
  log.error(
    `\`${a.id} login\` signs in the default account; add a named one with \`agentbox credentials add ${a.id}/${name} --login\``,
  );
  process.exit(1);
}

/** The `--account` typed with `login`, wherever commander put it; undefined when none. */
export function namedAccountFlag(cmd: Command): string | undefined {
  const raw = (cmd.optsWithGlobals() as { account?: string | string[] }).account;
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Sign an agent in: its default login, or a named login account (captured into
 * the account store). An agent with its own login protocol (claude's headless
 * print-URL / `--code` pair) runs it with `extra` (its own flags) passed through.
 */
export async function runAgentLogin(
  a: AgentCliSpec,
  args: string[],
  opts: LoginOptions & { account?: LoginAccountTarget; extra?: Record<string, unknown> },
): Promise<void> {
  const account = opts.account;
  if (account) {
    // Fail closed: a runtime that does not honour `ensureVolume({account})` and
    // `signIn({volume})` would sign into the SHARED volume and seed the host's
    // login into the named one — capturing the owner's login under a new name.
    if (a.runtime.supportsAccountLogin !== true) {
      log.error(`${a.shortName} cannot sign in a named login account yet`);
      process.exit(1);
    }
    // Before the whole OAuth flow, not after it.
    const existing = findAccount(await readAccounts(), a.id, account.id);
    if (existing && existing.kind !== 'login') {
      log.error(
        `account '${account.id}' is a ${existing.kind} account; remove it first (\`agentbox credentials rm ${a.id}/${account.id}\`)`,
      );
      process.exit(1);
    }
  }
  const custom = a.runtime.loginCommand?.run;
  if (custom) {
    // The app-level calls a custom login needs, injected rather than imported:
    // an agent package cannot reach `commands/control-plane.ts`,
    // `commands/_errors.ts` or the account-login helpers.
    await custom(
      args,
      {
        ...opts.extra,
        ...(opts.interactive ? { interactive: true } : {}),
        ...(account ? { loginAccount: account } : {}),
      },
      {
        syncCredentialsIfChanged: syncAgentCredentialsIfChanged,
        fail: handleLifecycleError,
        captureAccountLogin: (o) => captureAccountLogin(a, o),
      },
    );
    return;
  }
  intro(
    account
      ? `Signing in to ${a.shortName} as account '${account.id}'...`
      : `Signing in to ${a.shortName}...`,
  );
  // Two shapes: an agent whose guided flow needs no keystroke (codex's device
  // code) only needs a terminal for the passthrough; one whose flow always
  // prompts needs one either way.
  const ttyRequired = a.runtime.loginNeedsTty === 'always' || opts.interactive === true;
  if (!process.stdin.isTTY && ttyRequired) {
    log.error(
      `\`agentbox ${a.id} login${opts.interactive === true ? ' --interactive' : ''}\` needs an interactive terminal.`,
    );
    process.exit(1);
  }
  const cfg = await loadEffectiveConfig(process.cwd());
  const baseImage = cfg.effective.box.image;

  const s = spinner();
  s.start('preparing sandbox image');
  // The login container RUNS the agent; the base image is agentless.
  const { ref: image } = await ensureImage(baseImage, {
    agents: [a.id],
    onProgress: imageProgress(s),
  });
  // Ensure the volume exists + is vscode-writable before the login
  // container writes its credential into it. A named account gets its own
  // volume, seeded with the host's config but not the host's login.
  const volume = account
    ? accountConfigVolume(a.runtime.sharedVolume, account.id)
    : a.runtime.sharedVolume;
  s.message(`preparing ${a.id} config`);
  await a.runtime.ensureVolume(
    { volume },
    { syncFromHost: true, image, ...(account ? { account: account.id } : {}) },
  );
  s.stop('image ready');

  const res = await a.runtime.signIn(image, args, {
    passthrough: opts.interactive === true,
    ...(account ? { volume } : {}),
  });
  if (res.cancelled) {
    outro('sign-in cancelled');
    process.exit(1);
  }
  if (!res.ok) {
    log.error(res.error ?? 'login failed');
    process.exit(1);
  }
  if (account) {
    await captureAccountLogin(a, {
      account: { id: account.id, ...(account.label ? { label: account.label } : {}) },
      volume,
      image,
    });
    return;
  }
  outro('signed in — credentials saved for future boxes');
}

/** A local image to read a volume with, or null when none can be had. */
async function helperImage(agent: string): Promise<string | null> {
  try {
    const cfg = await loadEffectiveConfig(process.cwd());
    // The login's own image, so its ensure is the cache hit after this one.
    return (await ensureImage(cfg.effective.box.image, { agents: [agent] })).ref;
  } catch {
    return null;
  }
}

export function wireLoginAction(a: AgentCliSpec, cmd: Command): Command {
  LOGIN_SPECS.set(a.id, a);
  return cmd.action(async function (
    this: Command,
    args: string[],
    rawOpts: LoginOptions & Record<string, unknown>,
  ) {
    refuseNamedAccount(a, this);
    try {
      const { interactive, ...extra } = rawOpts;
      // The default login, as its volume holds it before and after: a change
      // means a sign-in completed, and the boxes on `default` get it.
      const image = await helperImage(a.id);
      const before = image ? await readDefaultVolumeLogin(a.id, image) : null;
      await runAgentLogin(a, args, { ...(interactive ? { interactive } : {}), extra });
      if (image) {
        // The sign-in itself succeeded; a box that missed the push is fixed by
        // `agentbox credentials renew <agent>/default --skip-sign-in`.
        await fanOutDefaultLoginIfSignedIn(a.id, image, before).catch((err: unknown) => {
          log.warn(
            `signed in, but the push to boxes failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });
}
