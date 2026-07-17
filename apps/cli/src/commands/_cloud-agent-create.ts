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

import { toQueueKind, type BoxRecord, type CreateBoxRequest, type Provider } from '@agentbox/core';
import type { AttachOpenIn } from '@agentbox/config';
import { log } from '@clack/prompts';
import { makeProgressReporter } from '../lib/progress.js';
import { printLaunchRecap } from '../lib/launch-recap.js';
import { buildPromptArgs } from '../lib/queue/build-prompt-args.js';
import { buildResyncWarning } from '../lib/resync-warning.js';
import { recordLastAgent } from '@agentbox/sandbox-docker';
import { cloudAgentAttach, cloudAgentStartDetached } from './_cloud-attach.js';

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
  /** When `false`, create the cloud box and start the agent in a detached tmux
   *  session (background mode) but don't attach the host terminal — mirrors the
   *  docker path, where the session is always created and only the terminal
   *  attach is skipped. A later `agentbox <agent> attach <box>` finds the
   *  running session and attaches to it. Defaults to `true`. */
  attach?: boolean;
  /**
   * Hook fired AFTER the box is provisioned and BEFORE the agent attach starts
   * the in-box tmux session. Used by the session-teleport path to upload a
   * host session file into the new sandbox before the agent CLI launches. May
   * mutate `extraArgs` indirectly via the returned `agentArgsPrefix`.
   */
  beforeStart?: (box: BoxRecord) => Promise<{ agentArgsPrefix?: string[] } | void>;
  /**
   * Whether the caller already set a seed prompt in `extraArgs` (plan / launch-
   * with-prompt / resume). On a checkpoint-restore conflict the warning is
   * injected as the agent's opening turn only when there's no seed; otherwise it
   * goes to stderr so it doesn't fight an existing first turn — mirrors the
   * docker create path.
   */
  hasSeedPrompt?: boolean;
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
      // The agent this box exists for. Mirrors the `recordLastAgent` below into
      // the control-plane registration, so a PC adopting a hub-created box
      // knows which agent to relaunch.
      agent: args.mode,
      onLog: (line) => s.message(line),
    });
    const nSuffix =
      typeof result.record.projectIndex === 'number'
        ? `  ·  n ${String(result.record.projectIndex)}`
        : '';
    s.stop(`box ready${nSuffix}`);
    // Record which agent this box was launched with so `agentbox recover` can
    // relaunch/attach the right one later. Best-effort — never block the launch.
    await recordLastAgent(result.record.id, args.mode).catch(() => {});
    let extraArgs = args.extraArgs;
    if (args.beforeStart) {
      const hook = await args.beforeStart(result.record);
      if (hook && hook.agentArgsPrefix && hook.agentArgsPrefix.length > 0) {
        extraArgs = [...hook.agentArgsPrefix, ...(extraArgs ?? [])];
      }
    }
    // On-create resync conflicts (checkpoint-restore path): inject the
    // "host changes SKIPPED … agentbox-ctl reload" warning as the agent's
    // opening turn, or surface on stderr when a seed prompt already owns it —
    // same behavior as the docker create path.
    const resyncWarning = result.resync ? buildResyncWarning(result.resync) : null;
    if (resyncWarning) {
      if (args.hasSeedPrompt) log.warn(resyncWarning);
      else extraArgs = buildPromptArgs(toQueueKind(args.mode), resyncWarning, extraArgs ?? []);
    }
    await printLaunchRecap({
      record: result.record,
      mode: args.mode,
      reattach:
        typeof result.record.projectIndex === 'number'
          ? String(result.record.projectIndex)
          : result.record.name,
      workspacePath: args.request.workspacePath,
      fromBranch: args.request.fromBranch,
      useBranch: args.request.useBranch,
      checkpointRef: args.request.checkpointRef,
      attaching: args.attach !== false,
    });
    if (args.attach === false) {
      // Background mode: start the agent in a detached tmux session (and verify
      // it stayed up) without attaching the host terminal — matches docker,
      // where the session is always created and only the attach is skipped.
      await cloudAgentStartDetached({
        box: result.record,
        binary: args.binary,
        sessionName: args.sessionName,
        extraArgs,
      });
      return;
    }
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
