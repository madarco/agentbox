import { spawn } from 'node:child_process';
import { DEFAULT_RELAY_PORT } from '@agentbox/sandbox-docker';
import type { BoxRecord } from '@agentbox/core';
import type { AttachOpenIn } from '@agentbox/config';
import { providerForBox } from '../provider/registry.js';
import { runWrappedAttach } from '../wrapped-pty/index.js';
import { pasteHostClipboardImage } from '../lib/paste-image.js';

const RELAY_HOST_URL = `http://127.0.0.1:${String(DEFAULT_RELAY_PORT)}`;

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
  // **bash -lc body MUST be single-quoted, not double-quoted.** When tmux
  // launches the session command, it goes through `/bin/sh -c <cmd>`. If we
  // double-quote, sh's parser sees `"${A[@]}"` and expands it eagerly —
  // before mapfile ever runs — to the empty string, so claude is invoked as
  // `claude ""` and the wizard's initial prompt is silently dropped. Single
  // quotes are inert in sh's parser: the literal `${A[@]}` reaches bash,
  // which expands it AFTER mapfile populates A. The outer shellSingle wrap
  // in renderInnerCommand re-escapes any internal `'` as `'\''`, so this
  // composes fine.
  return `bash -lc 'mapfile -t A < <(echo ${blob} | base64 -d); exec ${binary} "\${A[@]}"'`;
}

export async function cloudAgentAttach(args: CloudAgentAttachArgs): Promise<void> {
  const provider = await providerForBox(args.box);
  if (!provider.buildAttach) {
    throw new Error(`provider '${provider.name}' does not support interactive attach`);
  }
  const command = buildCloudAttachInnerCommand(args.binary, args.extraArgs);
  // Daytona-only: force inline attach. `spec.cleanup` would otherwise run as
  // soon as the host process returns from the spawn (before the new pane has
  // released the per-call SSH tunnel), breaking the detached attach.
  const safeOpenIn: AttachOpenIn | undefined =
    args.box.provider === 'daytona' ? 'same' : args.openIn;

  // New-terminal attaches (tab/window/split) re-invoke `agentbox <agent> attach`
  // in the fresh pane, and that re-invocation carries NO `extraArgs` — so for a
  // resume/teleport launch (`claude --resume <id>`, etc.) the session would
  // otherwise be created fresh, dropping the resumed session. Pre-create the
  // session detached here with the full command; the re-invoked attach then
  // finds it via `tmux has-session` and just attaches. (Inline attach runs the
  // full command itself, so it doesn't need this.)
  if (safeOpenIn && safeOpenIn !== 'same' && args.extraArgs && args.extraArgs.length > 0) {
    const pre = await provider.buildAttach(args.box, 'agent', {
      sessionName: args.sessionName,
      command,
      detached: true,
    });
    try {
      await runDetached(pre.argv);
    } finally {
      if (pre.cleanup) await pre.cleanup();
    }
  }

  const spec = await provider.buildAttach(args.box, 'agent', {
    sessionName: args.sessionName,
    command,
  });
  try {
    const code = await runWrappedAttach({
      container: args.box.name,
      command: spec.argv[0],
      dockerArgv: spec.argv.slice(1),
      relayBaseUrl: RELAY_HOST_URL,
      boxId: args.box.id,
      boxName: args.box.name,
      projectIndex: args.box.projectIndex,
      mode: args.mode,
      detachable: true,
      openIn: safeOpenIn,
      // claude + macOS only: off darwin clipboard capture can't succeed, so
      // leave Ctrl+V forwarding verbatim instead of a no-op flash.
      onPasteImage:
        args.mode === 'claude' && process.platform === 'darwin'
          ? () => pasteHostClipboardImage(provider, args.box)
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
function runDetached(argv: string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: 'ignore' });
    child.on('error', () => resolve());
    child.on('exit', () => resolve());
  });
}
