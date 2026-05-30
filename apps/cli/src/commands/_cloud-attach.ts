import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spinner } from '@clack/prompts';
import { DEFAULT_RELAY_PORT } from '@agentbox/sandbox-docker';
import type { BoxRecord } from '@agentbox/core';
import type { AttachOpenIn } from '@agentbox/config';
import { providerForBox } from '../provider/registry.js';
import { runWrappedAttach } from '../wrapped-pty/index.js';
import { pasteHostClipboardImage } from '../lib/paste-image.js';
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
 * When `extraArgs` is non-empty, we base64-encode the argv (one arg per line)
 * and hand the inner shell a small `mapfile`-based launcher that reconstructs
 * the array — see `buildCloudAttachInnerCommand`. Base64 is alphanumeric+`/+=`
 * so it survives every shell-quoting layer (host single-quote, SSH, tmux,
 * bash) untouched, which avoids the 3-layer escaping mess the literal form
 * would otherwise require.
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
   * Extra args the user typed after `--`. Passed through to the in-box agent
   * verbatim via a base64-encoded launcher. Limitation: args containing
   * literal `\n` aren't supported (none of claude/codex/opencode flags do).
   */
  extraArgs?: string[];
  /**
   * Where to open the attached session in the host's terminal (`split`/`window`/
   * `tab`/`same`). Forwarded to `runWrappedAttach`. Daytona attaches are forced
   * to `same` for now because `provider.buildAttach()` may return a `cleanup`
   * that tears down per-call SSH tunnels — running cleanup while a detached
   * new pane still holds the connection would kill the pane. Hetzner's
   * ControlMaster is per-box-lifetime so spawn-and-detach is safe there.
   */
  openIn?: AttachOpenIn;
}

/**
 * Render the inner shell command tmux runs inside the cloud sandbox. Exported
 * so unit tests can exercise the base64 round-trip without spinning up SSH.
 *
 * Empty `extraArgs` keeps the no-args path identical to the pre-args
 * behaviour — `bash -lc 'exec <binary>'` with a backslash-space so the outer
 * shell-quoting layers don't split `exec` from the binary name.
 */
export function buildCloudAttachInnerCommand(binary: string, extraArgs?: string[]): string {
  if (!extraArgs || extraArgs.length === 0) {
    return `bash -lc exec\\ ${binary}`;
  }
  // One arg per line, base64-encoded. The launcher runs `mapfile -t A` against
  // the decoded stream, then `exec <binary> "${A[@]}"` so each arg lands as
  // its own argv element — quotes/spaces inside an arg are preserved exactly
  // because base64 is opaque to every outer shell quoting pass.
  const blob = Buffer.from(extraArgs.join('\n'), 'utf8').toString('base64');
  // The decode feeds `mapfile` via a **here-string**, NOT process substitution
  // (`< <(…)`). Process substitution needs `/dev/fd/N`, and the Vercel Sandbox
  // (Firecracker microVM, AL2023) has no `/dev/fd` — so `mapfile -t A < <(…)`
  // fails with `/dev/fd/63: No such file or directory`, A stays empty, and the
  // agent launches with no args (the wizard's initial setup prompt is silently
  // dropped). A here-string is backed by a temp file, needs no `/dev/fd`, and
  // works on every backend (docker/daytona/hetzner unaffected). `$(…)` strips
  // the trailing newline `<<<` re-adds, so mapfile -t yields one element per
  // arg exactly as the join produced them.
  //
  // **bash -lc body MUST be single-quoted, not double-quoted.** When tmux
  // launches the session command, it goes through `/bin/sh -c <cmd>`. If we
  // double-quote, sh's parser sees `"${A[@]}"` and expands it eagerly —
  // before mapfile ever runs — to the empty string, so claude is invoked as
  // `claude ""` and the wizard's initial prompt is silently dropped. Single
  // quotes are inert in sh's parser: the literal `${A[@]}` (and `$(…)`) reach
  // bash, which runs them AFTER the outer sh layer. The outer shellSingle wrap
  // in renderInnerCommand re-escapes any internal `'` as `'\''`; this body has
  // no single quotes (it uses double quotes around the here-string), so it
  // composes fine.
  return `bash -lc 'mapfile -t A <<< "$(echo ${blob} | base64 -d)"; exec ${binary} "\${A[@]}"'`;
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
  const command = buildCloudAttachInnerCommand(args.binary, args.extraArgs);
  // Daytona-only: force inline attach. `spec.cleanup` would otherwise run as
  // soon as the host process returns from the spawn (before the new pane has
  // released the per-call SSH tunnel), breaking the detached attach.
  const safeOpenIn: AttachOpenIn | undefined =
    box.provider === 'daytona' ? 'same' : args.openIn;

  // New-terminal attaches (tab/window/split) re-invoke `agentbox <agent> attach`
  // in the fresh pane, and that re-invocation carries NO `extraArgs` — so for a
  // resume/teleport launch (`claude --resume <id>`, etc.) the session would
  // otherwise be created fresh, dropping the resumed session. Pre-create the
  // session detached here with the full command; the re-invoked attach then
  // finds it via `tmux has-session` and just attaches. (Inline attach runs the
  // full command itself, so it doesn't need this.)
  if (safeOpenIn && safeOpenIn !== 'same' && args.extraArgs && args.extraArgs.length > 0) {
    const pre = await provider.buildAttach(box, 'agent', {
      sessionName: args.sessionName,
      command,
      detached: true,
    });
    try {
      await runDetached(pre.argv, pre.env);
    } finally {
      if (pre.cleanup) await pre.cleanup();
    }
  }

  let spec = await provider.buildAttach(box, 'agent', {
    sessionName: args.sessionName,
    command,
  });
  // claude only, and only when this host can capture a clipboard image (macOS,
  // or a Linux desktop with xclip/wl-paste). Otherwise Ctrl+V forwards verbatim.
  const canPaste =
    args.mode === 'claude' && (await clipboardCaptureAvailable());

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
  const reconnect = async (
    signal: AbortSignal,
  ): Promise<{ command: string; argv: string[]; env?: Record<string, string> } | null> => {
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
    return { command: spec.argv[0]!, argv: spec.argv.slice(1), env: spec.env };
  };

  try {
    const code = await runWrappedAttach({
      container: box.name,
      command: spec.argv[0],
      dockerArgv: spec.argv.slice(1),
      env: spec.env,
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
      onPasteImage: canPaste
        ? () => pasteHostClipboardImage(provider, box)
        : undefined,
    });
    process.exit(code);
  } finally {
    if (spec.cleanup) await spec.cleanup();
  }
}

/**
 * Run an attach-style argv non-interactively to completion (used for the
 * `detached` session pre-start). stdio is ignored — the remote command only
 * creates + configures the tmux session and exits; there's nothing to show.
 * Resolves on exit regardless of code (a non-zero here shouldn't block the
 * subsequent attach, which surfaces any real failure to the user).
 */
function runDetached(argv: string[], env?: Record<string, string>): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: 'ignore',
      env: env ? { ...process.env, ...env } : process.env,
    });
    child.on('error', () => resolve());
    child.on('exit', () => resolve());
  });
}
