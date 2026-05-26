/**
 * Shared "cloud create + agent attach" path for `agentbox claude`,
 * `agentbox codex`, `agentbox opencode` when `--provider` resolves to a
 * non-docker backend (today only `daytona`). Without it those default actions
 * silently fall through to docker — `agentbox claude --provider daytona` would
 * make a docker box, ignoring the flag.
 *
 * What this does:
 *   1. Calls `provider.create(req)` (provider-neutral — credential volumes,
 *      env-files, workspace seed, ctl daemon all happen inside).
 *   2. Hands the resulting `BoxRecord` to `cloudAgentAttach` which SSH+tmux-
 *      attaches the agent CLI. Extra `<agent>-args` are threaded through via
 *      the base64-encoded launcher (see `buildCloudAttachInnerCommand`).
 *
 * The Docker fast path in each agent command stays untouched: this helper
 * only runs when the caller pre-resolved a non-docker provider.
 */

import { log, outro } from '@clack/prompts';
import type { BoxRecord, CreateBoxRequest, Provider } from '@agentbox/core';
import type { AttachOpenIn } from '@agentbox/config';
import { makeProgressReporter } from '../lib/progress.js';
import { cloudAgentAttach } from './_cloud-attach.js';

export interface CloudAgentCreateArgs {
  /** Pre-resolved provider (from `providerForCreate`). */
  provider: Provider;
  /** Box create request; `onLog` is overwritten by this helper. */
  request: Omit<CreateBoxRequest, 'onLog'>;
  /** Agent binary inside the sandbox (`claude`, `codex`, `opencode`). */
  binary: string;
  /** Tmux session name (e.g. `claude`). */
  sessionName: string;
  /** Mode label for the wrapper's footer. */
  mode: 'claude' | 'codex' | 'opencode';
  /** Args passed to the agent after `--`. Threaded through to the attached CLI. */
  extraArgs?: string[];
  /** Bypass the spinner and stream raw provider output to stderr. */
  verbose?: boolean;
  /** Where to open the attached session; forwarded to `cloudAgentAttach`. */
  openIn?: AttachOpenIn;
  /** When `false`, create the cloud box and skip the agent attach (background
   *  mode). Defaults to `true`. On cloud providers the agent's tmux session is
   *  created lazily by `cloudAgentAttach`; with `attach: false` the session
   *  isn't started yet — a later `agentbox <agent> attach <box>` starts it on
   *  first attach. */
  attach?: boolean;
  /**
   * Hook fired AFTER the box is provisioned and BEFORE the agent attach starts
   * the in-box tmux session. Used by the session-teleport path to upload a
   * host session file into the new sandbox before the agent CLI launches. May
   * mutate `extraArgs` indirectly via the returned `agentArgsPrefix`.
   */
  beforeStart?: (box: BoxRecord) => Promise<{ agentArgsPrefix?: string[] } | void>;
}

/**
 * Provision a cloud box and attach the requested agent. Calls process.exit
 * via `cloudAgentAttach` → `runWrappedAttach`; this function does not return
 * on the happy path.
 */
export async function cloudAgentCreate(args: CloudAgentCreateArgs): Promise<void> {
  const s = makeProgressReporter(args.verbose === true);
  s.start('creating cloud box');
  try {
    const result = await args.provider.create({
      ...args.request,
      onLog: (line) => s.message(line),
    });
    const nSuffix =
      typeof result.record.projectIndex === 'number'
        ? `  ·  n ${String(result.record.projectIndex)}`
        : '';
    s.stop(`box ${result.record.name} ready${nSuffix}`);
    log.info(`id:        ${result.record.id}`);
    log.info(`provider:  ${result.record.provider}`);
    if (result.record.cloud?.sandboxId) {
      log.info(`sandboxId: ${result.record.cloud.sandboxId}`);
    }
    let extraArgs = args.extraArgs;
    if (args.beforeStart) {
      const hook = await args.beforeStart(result.record);
      if (hook && hook.agentArgsPrefix && hook.agentArgsPrefix.length > 0) {
        extraArgs = [...hook.agentArgsPrefix, ...(extraArgs ?? [])];
      }
    }
    if (args.attach === false) {
      outro(
        `session not started — attach with: agentbox ${args.mode} attach ${result.record.name}`,
      );
      return;
    }
    outro(`attaching ${args.mode} — Control+a d to detach, leaves the agent running`);
    await cloudAgentAttach({
      box: result.record,
      binary: args.binary,
      sessionName: args.sessionName,
      mode: args.mode,
      extraArgs,
      openIn: args.openIn,
    });
  } catch (err) {
    s.stop('cloud box create failed');
    throw err;
  }
}
