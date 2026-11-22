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
import {
  readAccounts,
  resolveAgentSpec,
  resolveLoginAccount,
  type LoginAccountRequest,
} from '@agentbox/sandbox-core';
import { captureAccountLogin, runPastedAccountLogin } from '../../lib/account-login.js';
import type { AgentCliSpec } from '@agentbox/cli-kit';

export interface LoginOptions {
  interactive?: boolean;
  account?: string;
  label?: string;
  apiKey?: boolean;
  setupToken?: boolean;
}

/**
 * Resolve the account flags, and run a pasted-kind login to completion.
 * Returns the named `login` account to sign in, null for the default login,
 * or 'done' when a pasted kind was handled.
 */
async function routeAccountLogin(
  a: AgentCliSpec,
  opts: LoginOptions,
): Promise<LoginAccountRequest | null | 'done'> {
  let req: LoginAccountRequest | null;
  try {
    req = resolveLoginAccount(resolveAgentSpec(a.id), opts);
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }
  if (req && req.kind !== 'login') {
    intro(`Saving a ${a.shortName} account...`);
    await runPastedAccountLogin(a, { ...req, kind: req.kind });
    return 'done';
  }
  if (req) {
    // Fail closed: a runtime that does not honour `ensureVolume({account})` and
    // `signIn({volume})` would sign into the SHARED volume and seed the host's
    // login into the named one — capturing the owner's login under a new name.
    if (a.runtime.supportsAccountLogin !== true) {
      log.error(`${a.shortName} cannot sign in a named login account yet`);
      process.exit(1);
    }
    // Before the whole OAuth flow, not after it.
    const existing = findAccount(await readAccounts(), a.id, req.id);
    if (existing && existing.kind !== 'login') {
      log.error(
        `account '${req.id}' is a ${existing.kind} account; remove it first (\`agentbox accounts rm ${a.id}/${req.id}\`)`,
      );
      process.exit(1);
    }
  }
  return req;
}

/**
 * `--account` exactly as typed after `login`. The parent `agentbox <agent>`
 * command declares `--account` too (the create flag), and commander gives a
 * flag both declare to the PARENT — so read the merged view and take its
 * single value.
 */
export function loginOptions(cmd: Command, own: LoginOptions): LoginOptions {
  const merged = cmd.optsWithGlobals() as LoginOptions & { account?: string | string[] };
  const raw = own.account ?? merged.account;
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  if (values.length > 1) {
    log.error('login takes one --account');
    process.exit(1);
  }
  return { ...own, ...(values[0] !== undefined ? { account: values[0] } : {}) };
}

export function wireLoginAction(a: AgentCliSpec, cmd: Command): Command {
  const custom = a.runtime.loginCommand?.run;
  if (custom) {
    // The app-level calls a custom login needs, injected rather than imported:
    // an agent package cannot reach `commands/control-plane.ts`,
    // `commands/_errors.ts` or the account-login helpers.
    return cmd.action(async function (
      this: Command,
      args: string[],
      rawOpts: LoginOptions & Record<string, unknown>,
    ) {
      const opts = { ...rawOpts, ...loginOptions(this, rawOpts) };
      try {
        const routed = await routeAccountLogin(a, opts);
        if (routed === 'done') return;
        const loginAccount = routed
          ? { id: routed.id, ...(routed.label ? { label: routed.label } : {}) }
          : undefined;
        await custom(
          args,
          { ...opts, ...(loginAccount ? { loginAccount } : {}) },
          {
            syncCredentialsIfChanged: syncAgentCredentialsIfChanged,
            fail: handleLifecycleError,
            captureAccountLogin: (o) => captureAccountLogin(a, o),
          },
        );
      } catch (err) {
        handleLifecycleError(err);
      }
    });
  }
  return cmd.action(async function (this: Command, args: string[], rawOpts: LoginOptions) {
    const opts = loginOptions(this, rawOpts);
    let account: LoginAccountRequest | null;
    try {
      const routed = await routeAccountLogin(a, opts);
      if (routed === 'done') return;
      account = routed;
    } catch (err) {
      handleLifecycleError(err);
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
    try {
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
    } catch (err) {
      handleLifecycleError(err);
    }
  });
}
