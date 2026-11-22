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
import { accountConfigVolume } from '@agentbox/core';
import {
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
  return req;
}

export function wireLoginAction(a: AgentCliSpec, cmd: Command): Command {
  const custom = a.runtime.loginCommand?.run;
  if (custom) {
    // The app-level calls a custom login needs, injected rather than imported:
    // an agent package cannot reach `commands/control-plane.ts`,
    // `commands/_errors.ts` or the account-login helpers.
    return cmd.action(async (args: string[], opts: LoginOptions & Record<string, unknown>) => {
      try {
        const routed = await routeAccountLogin(a, opts);
        if (routed === 'done') return;
        const loginAccount = routed ? { id: routed.id, ...(routed.label ? { label: routed.label } : {}) } : undefined;
        await custom(args, { ...opts, ...(loginAccount ? { loginAccount } : {}) }, {
          syncCredentialsIfChanged: syncAgentCredentialsIfChanged,
          fail: handleLifecycleError,
          captureAccountLogin: (o) => captureAccountLogin(a, o),
        });
      } catch (err) {
        handleLifecycleError(err);
      }
    });
  }
  return cmd.action(async (args: string[], opts: LoginOptions) => {
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
