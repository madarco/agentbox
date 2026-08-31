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
import { intro, log, outro, spinner } from '@agentbox/cli-kit';
import { handleLifecycleError } from '../../commands/_errors.js';
import { imageProgress } from '@agentbox/cli-kit';
import type { AgentCliSpec } from '@agentbox/cli-kit';

export interface LoginOptions {
  interactive?: boolean;
}

export function wireLoginAction(a: AgentCliSpec, cmd: Command): Command {
  const custom = a.runtime.loginCommand?.run;
  if (custom) return cmd.action(async (args: string[], opts) => custom(args, opts));
  return cmd.action(async (args: string[], opts: LoginOptions) => {
    intro(`Signing in to ${a.shortName}...`);
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
      // Ensure the shared volume exists + is vscode-writable before the login
      // container writes its credential into it.
      s.message(`preparing ${a.id} config`);
      await a.runtime.ensureVolume(
        { volume: a.runtime.sharedVolume },
        { syncFromHost: true, image },
      );
      s.stop('image ready');

      const res = await a.runtime.signIn(image, args, { passthrough: opts.interactive === true });
      if (res.cancelled) {
        outro('sign-in cancelled');
        process.exit(1);
      }
      if (!res.ok) {
        log.error(res.error ?? 'login failed');
        process.exit(1);
      }
      outro('signed in — credentials saved for future boxes');
    } catch (err) {
      handleLifecycleError(err);
    }
  });
}
