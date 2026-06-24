import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spinner } from '@clack/prompts';
import { DEFAULT_RELAY_PORT } from '@agentbox/sandbox-docker';
import type { BoxRecord, Provider } from '@agentbox/core';
import type { AttachOpenIn } from '@agentbox/config';
import { agentResumeArgs } from '../agent-sessions.js';
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
   * `tab`/`same`). Forwarded to `runWrappedAttach`. Daytona attaches are forced
   * to `same` for now because `provider.buildAttach()` may return a `cleanup`
   * that tears down per-call SSH tunnels — running cleanup while a detached
   * new pane still holds the connection would kill the pane. Hetzner's
   * ControlMaster is per-box-lifetime so spawn-and-detach is safe there.
   */
  openIn?: AttachOpenIn;
}

/**
 * Printed in the agent's tmux pane the instant the session's command starts,
 * BEFORE the agent binary paints its first frame. On a cold cloud sandbox the
 * agent CLI (node cold-start + a large seed prompt + TUI init) can take several
 * seconds to draw — and a tmux client that attaches during that window sees a
 * featureless blank pane (verified: tmux pushes the frame correctly once the
 * program draws, so the gap is pure program-startup latency, not a redraw bug).
 * Without this line the run looks hung and users Ctrl+C then re-attach. The
 * agent clears the screen on startup, so the line vanishes the moment real
 * output arrives. Shared by every cloud provider; e2b/vercel microVMs are the
 * slowest cold-starters so they benefit most.
 *
 * No escape sequences (plain text) on purpose: this string threads through
 * several shell-quoting layers (single-quoted `bash -lc` body, the outer
 * `shellSingle` wrap in `renderInnerCommand`, then the provider transport), and
 * plain ASCII is the one thing guaranteed to survive all of them intact.
 */
function agentStartBanner(binary: string): string {
  return `printf "  agentbox: starting ${binary} (first paint may take a few seconds)...\\r\\n"; `;
}

/**
 * Render the inner shell command tmux runs inside the cloud sandbox. Exported
 * so unit tests can exercise the base64 round-trip without spinning up SSH.
 *
 * Both paths run `agentStartBanner` first so the freshly-attached pane is never
 * blank during the agent's cold-start. The body is single-quoted (`bash -lc
 * '…'`) in both branches so the outer `shellSingle` wrap composes the same way;
 * `exec <binary>` still replaces the shell so the agent keeps PID 2 (Ctrl-c in
 * the agent tears the session down cleanly).
 */
export function buildCloudAttachInnerCommand(binary: string, extraArgs?: string[]): string {
  if (!extraArgs || extraArgs.length === 0) {
    return `bash -lc '${agentStartBanner(binary)}exec ${binary}'`;
  }
  // Encode EACH arg to its own base64 token, newline-join the tokens, then
  // base64 that whole list once more into a single opaque `blob`. The launcher
  // decodes `blob` back to the newline-separated tokens, reads them one per
  // line, and base64-decodes each into its own argv element before
  // `exec <binary> "${A[@]}"`.
  //
  // Two layers, not one, on purpose: the earlier scheme joined the args with a
  // single `\n` and split with `mapfile -t`, which conflated "argv separator"
  // with "a newline INSIDE an arg". A multi-paragraph seed prompt (the `-i`
  // queue's common case) was shredded into one positional per line, so claude/
  // codex were launched as `claude "line1" "line2" …` — only the first line
  // reached the agent and the surplus positionals could abort the launch, so
  // the detached session died and `verifyDetachedSession` failed the job. Here
  // the inner newlines live INSIDE a token's base64 payload (base64's alphabet
  // is `[A-Za-z0-9+/=]` — no newlines), so they never act as a separator; only
  // the outer per-token newlines split the argv.
  const blob = Buffer.from(
    extraArgs.map((a) => Buffer.from(a, 'utf8').toString('base64')).join('\n'),
    'utf8',
  ).toString('base64');
  // The decode feeds the read loop via a **here-string**, NOT process
  // substitution (`< <(…)`). Process substitution needs `/dev/fd/N`, and the
  // Vercel Sandbox (Firecracker microVM, AL2023) has no `/dev/fd` — so it would
  // fail with `/dev/fd/63: No such file or directory`, A stays empty, and the
  // agent launches with no args (the wizard's initial setup prompt is silently
  // dropped). A here-string is backed by a temp file, needs no `/dev/fd`, and
  // works on every backend (docker/daytona/hetzner unaffected). `$(…)` strips
  // the trailing newline `<<<` re-adds, so the loop yields one element per token
  // exactly as the join produced them.
  //
  // **bash -lc body MUST be single-quoted, not double-quoted.** When tmux
  // launches the session command, it goes through `/bin/sh -c <cmd>`. If we
  // double-quote, sh's parser sees `"${A[@]}"` and expands it eagerly —
  // before the loop ever runs — to the empty string, so claude is invoked as
  // `claude ""` and the wizard's initial prompt is silently dropped. Single
  // quotes are inert in sh's parser: the literal `${A[@]}` (and `$(…)`) reach
  // bash, which runs them AFTER the outer sh layer. The outer shellSingle wrap
  // in renderInnerCommand re-escapes any internal `'` as `'\''`; this body has
  // no single quotes (it uses double quotes around the here-string), so it
  // composes fine.
  return `bash -lc '${agentStartBanner(binary)}A=(); while IFS= read -r t; do A+=("$(printf %s "$t" | base64 -d)"); done <<< "$(echo ${blob} | base64 -d)"; exec ${binary} "\${A[@]}"'`;
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
  // Daytona-only: force inline attach. `spec.cleanup` would otherwise run as
  // soon as the host process returns from the spawn (before the new pane has
  // released the per-call SSH tunnel), breaking the detached attach.
  const safeOpenIn: AttachOpenIn | undefined = box.provider === 'daytona' ? 'same' : args.openIn;

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

  let spec = await provider.buildAttach(box, 'agent', {
    sessionName: args.sessionName,
    command,
  });
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
      onPasteImage: canPaste ? () => pasteHostClipboardImage(provider, box) : undefined,
      onPasteImageFile: canPaste ? (p) => uploadImageFileToBox(provider, box, p) : undefined,
    });
    process.exit(code);
  } finally {
    if (spec.cleanup) await spec.cleanup();
  }
}

/**
 * Create + configure the agent's tmux session running `command` without
 * attaching (the `detached` buildAttach mode). Shared by the new-tab attach
 * pre-start and the background (`-i`) queue worker. Returns the session-create
 * command's exit code + stderr so the queue worker can fail the job when the
 * session was never created; the new-tab pre-start ignores the result (a real
 * launch failure surfaces on the subsequent attach).
 */
async function startDetachedSession(
  provider: Provider,
  box: BoxRecord,
  sessionName: string,
  command: string,
): Promise<{ exitCode: number; stderr: string }> {
  if (!provider.buildAttach) {
    throw new Error(`provider '${provider.name}' does not support detached sessions`);
  }
  const spec = await provider.buildAttach(box, 'agent', {
    sessionName,
    command,
    detached: true,
  });
  try {
    return await runDetached(spec.argv, spec.env);
  } finally {
    if (spec.cleanup) await spec.cleanup();
  }
}

/**
 * Markers an agent prints to its TUI when its in-box credentials are rejected.
 * The seeded cloud login can be stale (it expires independently of the host
 * session — `agentbox <agent> login` refreshes it), in which case the agent
 * launches, draws, then sits on an auth error doing no work. Scraping the pane
 * for these turns that otherwise-silent dead-end into an actionable failure.
 */
const AGENT_AUTH_FAILURE =
  /Please run \/login|Invalid authentication credentials|API Error: 401|Invalid API key|\bUnauthorized\b/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * After a detached pre-start, confirm the agent's tmux session actually came up
 * and stayed up. `tmux new-session -d` creates the session synchronously, so a
 * session that's already gone — or vanishes within the settle window — means the
 * agent process exited immediately at launch (the single-window session dies
 * with it). This is the exact silent failure the `-i` queue path hit on cloud
 * providers: the box was created and the job reported "done", but no session was
 * ever running. We also scrape the pane for credential-rejection markers, the
 * most common cause of a session that's technically alive but doing nothing.
 * Throws an actionable error so the caller surfaces it (queue worker → failed
 * job; restore → logged) instead of masking it.
 */
export async function verifyDetachedSession(
  provider: Provider,
  box: BoxRecord,
  sessionName: string,
  binary: string,
  opts: { windowMs?: number; pollMs?: number } = {},
): Promise<void> {
  const windowMs = opts.windowMs ?? 10_000;
  const pollMs = opts.pollMs ?? 2_000;
  const q = `'${sessionName.replace(/'/g, `'\\''`)}'`;
  // One round-trip per tick: bail (exit 7) if the session is gone, else echo the
  // pane so we can sniff for an auth dead-end.
  const probe = `tmux has-session -t ${q} 2>/dev/null || exit 7; tmux capture-pane -p -t ${q} 2>/dev/null`;
  const deadline = Date.now() + windowMs;
  for (;;) {
    let pane = '';
    try {
      const r = await provider.exec(box, ['bash', '-lc', probe], { user: 'vscode' });
      if (r.exitCode === 7) {
        throw new Error(
          `agent '${binary}' exited immediately after launch in box ${box.name} — the session did not stay up. ` +
            `Attach to inspect: agentbox ${binary} attach ${box.name}`,
        );
      }
      pane = r.stdout;
    } catch (err) {
      // Re-throw our own diagnosis; a transport-level probe error is NOT proof
      // of death (don't false-fail on a flaky exec) — keep polling.
      if (err instanceof Error && err.message.startsWith(`agent '${binary}'`)) throw err;
    }
    if (AGENT_AUTH_FAILURE.test(pane)) {
      throw new Error(
        `box ${binary} credentials were rejected — the agent launched but printed an auth error, so no work will run. ` +
          `Refresh them with \`agentbox ${binary} login\`, then re-run.`,
      );
    }
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }
}

/**
 * Provision-time entry point for background (`-i`) cloud jobs: resolve the
 * provider, ensure the box is running, then pre-start a detached agent tmux
 * session seeded with `extraArgs` (the seed prompt as first positional + the
 * user's post-`--` args). Mirrors the `probeState`/`start` guard in
 * `cloudAgentAttach` so a box that came up paused still gets its session. A
 * later `agentbox <agent> attach` finds the running session via
 * `tmux has-session` and just attaches.
 */
export async function cloudAgentStartDetached(args: {
  box: BoxRecord;
  binary: string;
  sessionName: string;
  extraArgs?: string[];
}): Promise<void> {
  const provider = await providerForBox(args.box);
  let box = args.box;
  const state = await provider.probeState(box);
  if (state === 'missing') {
    throw new Error(`cloud sandbox for ${box.name} is missing; was it destroyed?`);
  }
  if (state !== 'running') {
    box = await provider.start(box);
  }
  const command = buildCloudAttachInnerCommand(args.binary, args.extraArgs);
  const { exitCode, stderr } = await startDetachedSession(
    provider,
    box,
    args.sessionName,
    command,
  );
  if (exitCode !== 0) {
    const detail = stderr.trim().slice(0, 500);
    throw new Error(
      `failed to start the ${args.binary} session in box ${box.name} (exit ${String(exitCode)})` +
        (detail ? `: ${detail}` : ''),
    );
  }
  await verifyDetachedSession(provider, box, args.sessionName, args.binary);
}

/**
 * Run an attach-style argv non-interactively to completion (used for the
 * `detached` session pre-start). The remote command only creates + configures
 * the tmux session and exits, so stdout is dropped — but stderr and the exit
 * code are captured: the E2B helper's `--detached` path runs the session-create
 * command via the SDK and exits with its code, so a non-zero here is the only
 * signal that the session was never created (e.g. a transient SDK connect/exec
 * failure). Callers decide whether to surface it — the queue worker fails the
 * job, the new-tab pre-start ignores it (the subsequent attach re-creates the
 * session anyway). Resolves on exit regardless of code (never rejects).
 */
function runDetached(
  argv: string[],
  env?: Record<string, string>,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    });
    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (err) => resolve({ exitCode: 1, stderr: stderr + String(err.message ?? err) }));
    child.on('exit', (code) => resolve({ exitCode: code ?? 0, stderr }));
  });
}
