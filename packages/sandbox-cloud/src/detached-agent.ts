/**
 * Start an agent's tmux session inside a cloud sandbox WITHOUT attaching — the
 * "detached" provider `buildAttach` mode — then verify it stayed up. Shared by:
 *   - the CLI's background `-i` queue worker + new-tab pre-start
 *     (`apps/cli/.../_cloud-attach.ts` `cloudAgentStartDetached`), and
 *   - the deployed control box's create worker (`apps/hub/lib/hub-worker.ts`),
 *     which runs an `-i` job entirely on the VPS.
 *
 * It stands only on the `Provider` interface (`buildAttach({detached:true})` +
 * `exec`) so it lives here in `@agentbox/sandbox-cloud` — importable by the hub,
 * which cannot import `apps/cli`. The apps/cli entry point keeps a thin wrapper
 * that resolves the provider from the box + handles the resume-fallback.
 */
import { spawn } from 'node:child_process';
import type { BoxRecord, Provider } from '@agentbox/core';

/** Printed in the pane the instant the session command starts, so a freshly
 * attached pane is never blank during the agent's cold-start (node cold-start +
 * a large seed prompt + TUI init can take seconds). Plain ASCII on purpose — it
 * threads through several shell-quoting layers. */
function agentStartBanner(binary: string): string {
  return `printf "  agentbox: starting ${binary} (first paint may take a few seconds)...\\r\\n"; `;
}

/**
 * Render the inner shell command tmux runs inside the cloud sandbox. Exported so
 * unit tests can exercise the base64 round-trip without spinning up SSH, and so
 * the interactive attach path shares the exact launcher.
 *
 * Both paths run `agentStartBanner` first. The body is single-quoted (`bash -lc
 * '…'`); `exec <binary>` replaces the shell so the agent keeps PID 2 (Ctrl-c in
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
  // Two layers, not one, on purpose: joining args with a single `\n` and
  // splitting with `mapfile -t` conflates "argv separator" with "a newline
  // INSIDE an arg". A multi-paragraph seed prompt (the `-i` common case) was
  // shredded into one positional per line. Here the inner newlines live INSIDE a
  // token's base64 payload (alphabet `[A-Za-z0-9+/=]` — no newlines), so they
  // never act as a separator; only the outer per-token newlines split the argv.
  const blob = Buffer.from(
    extraArgs.map((a) => Buffer.from(a, 'utf8').toString('base64')).join('\n'),
    'utf8',
  ).toString('base64');
  // The decode feeds the read loop via a **here-string**, NOT process
  // substitution (`< <(…)`): the Vercel Sandbox (AL2023) has no `/dev/fd`. And
  // the `bash -lc` body MUST be single-quoted — a double-quoted `"${A[@]}"`
  // expands eagerly under the outer `/bin/sh -c` before the loop runs, dropping
  // the seed prompt. Single quotes are inert to sh; bash runs `${A[@]}`/`$(…)`.
  return `bash -lc '${agentStartBanner(binary)}A=(); while IFS= read -r t; do A+=("$(printf %s "$t" | base64 -d)"); done <<< "$(echo ${blob} | base64 -d)"; exec ${binary} "\${A[@]}"'`;
}

/**
 * Create + configure the agent's tmux session running `command` without
 * attaching (the `detached` buildAttach mode). Returns the session-create
 * command's exit code + stderr so callers can fail when the session was never
 * created.
 */
export async function startDetachedSession(
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
 * The seeded cloud login can be stale (it expires independently — `agentbox
 * <agent> login` refreshes it), in which case the agent launches, draws, then
 * sits on an auth error doing no work. Scraping the pane turns that otherwise
 * silent dead-end into an actionable failure.
 */
const AGENT_AUTH_FAILURE =
  /Please run \/login|Invalid authentication credentials|API Error: 401|Invalid API key|\bUnauthorized\b/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * After a detached pre-start, confirm the agent's tmux session came up and
 * stayed up. `tmux new-session -d` creates the session synchronously, so a
 * session that's already gone — or vanishes within the settle window — means the
 * agent process exited immediately at launch. We also scrape the pane for
 * credential-rejection markers (the most common cause of an alive-but-idle
 * session). Throws an actionable error so the caller surfaces it (queue worker /
 * hub worker → failed job) instead of masking it.
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
 * Run an attach-style argv non-interactively to completion (the `detached`
 * session pre-start). The remote command only creates + configures the tmux
 * session and exits; stdout is dropped, stderr + exit code captured. Resolves on
 * exit regardless of code (never rejects).
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

export interface StartDetachedCloudAgentArgs {
  /** The box's provider (already resolved — the hub worker holds it directly). */
  provider: Provider;
  box: BoxRecord;
  /** In-sandbox binary (`claude`/`codex`/`opencode`). */
  binary: string;
  /** tmux session name (usually the binary name). */
  sessionName: string;
  /** Seed prompt (already shaped into args) + any post-`--` user args. */
  extraArgs?: string[];
  /**
   * With NO `extraArgs`, resolve the args to resume the box's recorded session
   * instead of launching fresh. Runs AFTER the box is confirmed running (it
   * execs in the box), so the caller doesn't have to start the box first. The
   * background `-i` path never passes this — it always seeds a prompt.
   */
  resolveResumeArgs?: (box: BoxRecord) => Promise<string[] | null>;
  /** Settle-window tuning for the post-start session verification (test hook). */
  verify?: { windowMs?: number; pollMs?: number };
}

/**
 * Provision-time detached start: ensure the box is running, pre-start the agent
 * tmux session seeded with `extraArgs`, and verify it stayed up (+ isn't sitting
 * on an auth error). Provider-parameterized so the hub worker can call it against
 * the `Provider` it already holds. Returns the possibly-started box record.
 */
export async function startDetachedCloudAgent(args: StartDetachedCloudAgentArgs): Promise<BoxRecord> {
  const { provider, binary, sessionName } = args;
  let box = args.box;
  const state = await provider.probeState(box);
  if (state === 'missing') {
    throw new Error(`cloud sandbox for ${box.name} is missing; was it destroyed?`);
  }
  if (state !== 'running') {
    box = await provider.start(box);
  }
  let extraArgs = args.extraArgs;
  if ((!extraArgs || extraArgs.length === 0) && args.resolveResumeArgs) {
    const resume = await args.resolveResumeArgs(box);
    if (resume) extraArgs = resume;
  }
  const command = buildCloudAttachInnerCommand(binary, extraArgs);
  const { exitCode, stderr } = await startDetachedSession(provider, box, sessionName, command);
  if (exitCode !== 0) {
    const detail = stderr.trim().slice(0, 500);
    throw new Error(
      `failed to start the ${binary} session in box ${box.name} (exit ${String(exitCode)})` +
        (detail ? `: ${detail}` : ''),
    );
  }
  await verifyDetachedSession(provider, box, sessionName, binary, args.verify);
  return box;
}
