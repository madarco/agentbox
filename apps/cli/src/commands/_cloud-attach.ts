import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log, spinner } from '@clack/prompts';
import { DEFAULT_RELAY_PORT } from '@agentbox/sandbox-docker';
import {
  buildCloudAttachInnerCommand,
  startDetachedCloudAgent,
  startDetachedSession,
  verifyDetachedSession,
} from '@agentbox/sandbox-cloud';
import type { BoxRecord, Provider } from '@agentbox/core';
import type { AttachOpenIn } from '@agentbox/config';
import { agentResumeArgs } from '../agent-sessions.js';

// Re-exported so existing importers (dashboard, unit tests) keep their paths; the
// implementations now live in @agentbox/sandbox-cloud so the hub worker can share
// them without importing apps/cli.
export { buildCloudAttachInnerCommand, verifyDetachedSession };
import { withFirewallRepair } from '../lib/firewall-repair.js';
import { providerForBox } from '../provider/registry.js';
import { runWrappedAttach } from '../wrapped-pty/index.js';
import { pasteHostClipboardImage, uploadImageFileToBox } from '../lib/paste-image.js';
import { clipboardCaptureAvailable } from '../lib/host-clipboard.js';

const RELAY_HOST_URL = `http://127.0.0.1:${String(DEFAULT_RELAY_PORT)}`;
/** Give up reconnecting a dropped attach after this long (box likely gone). */
const RECONNECT_TIMEOUT_MS = 5 * 60_000;

/** setTimeout that also resolves early if the signal aborts (no rejection). */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Attach to (or create) a tmux session inside a cloud sandbox over SSH and
 * run an agent CLI inside it. Shared between `agentbox claude`/`codex`/
 * `opencode` so the SSH + tmux mechanics live in one place.
 *
 * The inner command tmux runs is `bash -lc 'exec <binary>'`:
 *   - login shell so `/home/vscode/.local/bin` is on PATH and `/etc/profile.d/
 *     agentbox.sh` exports `AGENTBOX_BOX_*` env;
 *   - `exec` so the agent gets PID 2 (Ctrl-c in the agent kills the session
 *     cleanly rather than dropping to bash).
 *
 * When `extraArgs` is non-empty, we base64-encode each arg individually,
 * newline-join the tokens, base64 that once more, and hand the inner shell a
 * small read-loop launcher that reconstructs the array — see
 * `buildCloudAttachInnerCommand`. Base64 is alphanumeric+`/+=` so it survives
 * every shell-quoting layer (host single-quote, SSH, tmux, bash) untouched, and
 * per-arg encoding keeps a newline inside an arg (a multi-line seed prompt) from
 * being mistaken for an argv separator.
 */
export interface CloudAgentAttachArgs {
  box: BoxRecord;
  /** In-sandbox binary path or name (`claude`, `codex`, `opencode`). */
  binary: string;
  /** Tmux session name (e.g. `claude`). */
  sessionName: string;
  /** Mode label for the wrapper's footer. */
  mode: 'claude' | 'codex' | 'opencode';
  /**
   * Extra args the user typed after `--`, plus any seed prompt slotted ahead of
   * them. Passed through to the in-box agent verbatim via a base64-encoded
   * launcher that preserves each arg's bytes exactly — including embedded
   * newlines, which a multi-paragraph seed prompt routinely carries.
   */
  extraArgs?: string[];
  /**
   * Where to open the attached session in the host's terminal (`split`/`window`/
   * `tab`/`same`). Forwarded to `runWrappedAttach`. Honoured by every provider:
   * a new pane re-invokes `agentbox <agent> attach`, which builds its own spec —
   * so `spec.cleanup` tearing down THIS call's per-attach resources (daytona's
   * SSH token) can't affect it.
   */
  openIn?: AttachOpenIn;
}

export async function cloudAgentAttach(args: CloudAgentAttachArgs): Promise<void> {
  const provider = await providerForBox(args.box);
  if (!provider.buildAttach) {
    throw new Error(`provider '${provider.name}' does not support interactive attach`);
  }
  // Captured for the reconnect closure (TS won't preserve the narrowing above
  // inside a later-invoked callback).
  const buildAttach = provider.buildAttach.bind(provider);
  // Ensure the box is running before we attach. A cloud box can be stopped
  // out from under an attach — most notably `checkpoint --set-default`, which
  // snapshots and stops the sandbox. Without this, buildAttach runs against a
  // dead sandbox and the relay poller 502s ("not listening on the requested
  // port") forever while the user stares at "Waiting for connection...".
  // `provider.start` auto-resumes from snapshot and returns the record with
  // refreshed preview URLs / relay tokens, which we must use downstream.
  // Mirrors the docker attach path (unpause/start) and `checkpoint create`.
  let box = args.box;
  const state = await provider.probeState(box);
  if (state === 'missing') {
    throw new Error(`cloud sandbox for ${box.name} is missing; was it destroyed?`);
  }
  if (state !== 'running') {
    const s = spinner();
    s.start(state === 'paused' ? 'resuming box' : 'starting box');
    box = await provider.start(box);
    s.stop('box running');
  }
  // Hetzner only: open the SSH tunnel UP FRONT, self-healing a stale firewall (a
  // host egress-IP change locks the per-box firewall) BEFORE any of the later
  // establish touches — the resume probe, the detached pre-start, buildAttach.
  // Whichever of those connected first would otherwise be an unguarded
  // establish: a firewall block there aborts the attach (or silently drops the
  // resumed session, since the resume probe swallows exec errors). Doing it once
  // here covers them all. Repairs ONLY on an actual connect failure; otherwise a
  // `true` over the already-open master is a cheap no-op. This is an ESTABLISH
  // path — distinct from the mid-session `reconnect` closure below, which must
  // NOT touch the firewall (a checkpoint/pause drop isn't an IP change).
  if (box.provider === 'hetzner') {
    await withFirewallRepair(
      provider,
      box,
      { enabled: true, onLog: (line) => log.success(line) },
      () => provider.exec(box, ['true']),
    );
  }
  // Attaching to a box that just came back up (a stop / cloud idle-timeout
  // resume): if the user passed no args of their own and the box has a resumable
  // claude/codex session, launch resuming it (claude --resume <id> / codex resume
  // --last) so the attach reopens the conversation instead of starting fresh. The
  // box is running now (provider.start above), so the probe can reach it. Opencode
  // has no resume support — skipped.
  let extraArgs = args.extraArgs;
  if ((!extraArgs || extraArgs.length === 0) && (args.mode === 'claude' || args.mode === 'codex')) {
    const resume = await agentResumeArgs(provider, box, args.mode);
    if (resume) extraArgs = resume;
  }
  const command = buildCloudAttachInnerCommand(args.binary, extraArgs);
  // Every cloud provider honours `attach.openIn`.
  //
  // Daytona used to be pinned to inline here, on the theory that `spec.cleanup`
  // — which revokes the per-attach SSH token — would fire as soon as this
  // process returned from spawning the new pane and cut the pane's connection
  // out from under it. It can't: the new pane re-invokes `agentbox <agent>
  // attach`, which builds its own spec and mints its OWN token, and Daytona's
  // revoke is token-scoped (verified against the live API: minting A and B, then
  // revoking A, leaves B working). The token this process minted is simply never
  // used on the new-pane path.
  const safeOpenIn: AttachOpenIn | undefined = args.openIn;

  // New-terminal attaches (tab/window/split) re-invoke `agentbox <agent> attach`
  // in the fresh pane, and that re-invocation carries NO `extraArgs` — so for a
  // resume/teleport launch (`claude --resume <id>`, etc.) the session would
  // otherwise be created fresh, dropping the resumed session. Pre-create the
  // session detached here with the full command; the re-invoked attach then
  // finds it via `tmux has-session` and just attaches. (Inline attach runs the
  // full command itself, so it doesn't need this.)
  if (safeOpenIn && safeOpenIn !== 'same' && extraArgs && extraArgs.length > 0) {
    await startDetachedSession(provider, box, args.sessionName, command);
  }

  // The tunnel is already established (and firewall-healed) by the up-front warm
  // -up above, so this reuses the live master.
  let spec = await buildAttach(box, 'agent', { sessionName: args.sessionName, command });
  // claude only, and only when this host can capture a clipboard image (macOS,
  // or a Linux desktop with xclip/wl-paste). Otherwise Ctrl+V forwards verbatim.
  const canPaste = args.mode === 'claude' && (await clipboardCaptureAvailable());

  // Re-establish the attach after the wrapper decides the box dropped (a vercel
  // checkpoint reboot, or a connection blip). Keep trying `provider.start` —
  // which resumes a stopped box and no-ops a running one — until it succeeds or
  // the deadline lapses. We deliberately DON'T bail on consecutive failures: a
  // box mid-snapshot rejects `start` for the whole (multi-minute) capture, and
  // that's indistinguishable from a destroyed box by error alone — so we lean on
  // the time budget (and the user's Ctrl+C, which aborts the signal) instead. On
  // a reboot this lands in a freshly-created tmux session (the snapshot is
  // filesystem-only); a blip on a still-running box re-attaches the same live
  // session. Returns null to give up (cancelled or timed out).
  //
  // NOTE: deliberately NO firewall repair here. This is a MID-SESSION drop — a
  // checkpoint stops the box (the PTY drops) and we wait for it to come back;
  // the host IP didn't change, so re-syncing the firewall would be wrong.
  // Firewall self-heal belongs only to establish paths (the up-front warm-up
  // above, and `agentbox recover`).
  const reconnect = async (
    signal: AbortSignal,
  ): Promise<{
    command: string;
    argv: string[];
    env?: Record<string, string>;
    initialInput?: string;
  } | null> => {
    const deadline = Date.now() + RECONNECT_TIMEOUT_MS;
    let backoff = 500;
    for (;;) {
      if (signal.aborted || Date.now() > deadline) return null;
      try {
        box = await provider.start(box);
        break;
      } catch {
        await abortableSleep(backoff, signal);
        backoff = Math.min(backoff * 2, 5000);
      }
    }
    if (signal.aborted) return null;
    // Mint the fresh attach FIRST, then release the previous one's per-call
    // resources (SSH tunnel / token). Order matters: if buildAttach throws,
    // `spec` still points at the old spec (uncleaned), so the outer `finally`
    // cleans it exactly once — building-then-cleaning avoids the double-cleanup
    // that the reverse order would cause on a buildAttach failure.
    const prev = spec;
    spec = await buildAttach(box, 'agent', { sessionName: args.sessionName, command });
    if (prev.cleanup) {
      try {
        await prev.cleanup();
      } catch {
        // best-effort
      }
    }
    return {
      command: spec.argv[0]!,
      argv: spec.argv.slice(1),
      env: spec.env,
      initialInput: spec.initialInput,
    };
  };

  try {
    const code = await runWrappedAttach({
      container: box.name,
      command: spec.argv[0],
      dockerArgv: spec.argv.slice(1),
      env: spec.env,
      initialInput: spec.initialInput,
      relayBaseUrl: RELAY_HOST_URL,
      boxId: box.id,
      boxName: box.name,
      projectIndex: box.projectIndex,
      mode: args.mode,
      detachable: true,
      openIn: safeOpenIn,
      reconnect,
      onError: (msg) => {
        // Non-fatal wrapper diagnostics (reconnect failures, give-ups, etc.) —
        // logged to a file because writing to stderr would corrupt the PTY.
        try {
          appendFileSync(
            join(homedir(), '.agentbox', 'logs', 'attach.log'),
            `${new Date().toISOString()} [${box.name}] ${msg}\n`,
          );
        } catch {
          // best-effort
        }
      },
      onPasteImage: canPaste ? () => pasteHostClipboardImage(provider, box) : undefined,
      onPasteImageFile: canPaste ? (p) => uploadImageFileToBox(provider, box, p) : undefined,
    });
    process.exit(code);
  } finally {
    if (spec.cleanup) await spec.cleanup();
  }
}

/**
 * Provision-time entry point for background (`-i`) cloud jobs: resolve the box's
 * provider, then pre-start a detached agent tmux session seeded with `extraArgs`
 * (the seed prompt + the user's post-`--` args), delegating the run + verify to
 * the shared `startDetachedCloudAgent` (which the hub worker also uses). With no
 * user args it resumes the box's recorded session instead of launching fresh —
 * the `-i` queue path always seeds a prompt, so that no-ops.
 */
export async function cloudAgentStartDetached(args: {
  box: BoxRecord;
  binary: string;
  sessionName: string;
  extraArgs?: string[];
}): Promise<void> {
  const provider = await providerForBox(args.box);
  await startDetachedCloudAgent({
    provider,
    box: args.box,
    binary: args.binary,
    sessionName: args.sessionName,
    extraArgs: args.extraArgs,
    resolveResumeArgs:
      args.binary === 'claude' || args.binary === 'codex'
        ? (box) => agentResumeArgs(provider, box, args.binary as 'claude' | 'codex')
        : undefined,
  });
}
