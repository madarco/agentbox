import type { CloudBackend, CloudHandle } from '@agentbox/core';
import {
  buildCodexAgentsOverrideScript,
  CODEX_OVERRIDE_WROTE_MARKER,
} from '@agentbox/sandbox-docker';

/** CODEX_HOME is `/home/vscode/.codex` on every provider (the box user is `vscode`). */
const BOX_CODEX_HOME = '/home/vscode/.codex';

/**
 * Cloud counterpart of the docker `seedCodexAgentsOverride`: regenerate
 * `~/.codex/AGENTS.override.md` in-box so the Codex agent reads the box "system
 * prompt" (`/etc/claude-code/CLAUDE.md`, installed on every provider). Runs the
 * SAME shared script as docker, in-box via `backend.exec`. The exec user varies
 * (vscode on vercel/e2b, root-then-sudo on hetzner), so target the fixed
 * `/home/vscode/.codex` path and normalize ownership to vscode afterwards rather
 * than relying on `$HOME`. Best-effort: a failure must never fail box creation.
 *
 * Call after the codex config/home is in place (post `ensureAgentHomeDirsOwned`)
 * so a synced user `AGENTS.md` is folded in beneath the facts.
 */
export async function ensureCodexAgentsOverride(
  backend: CloudBackend,
  handle: CloudHandle,
  opts: { onLog?: (line: string) => void } = {},
): Promise<void> {
  const log = opts.onLog ?? (() => {});
  const script =
    buildCodexAgentsOverrideScript(BOX_CODEX_HOME) +
    `\nchown vscode:vscode "$OVR" 2>/dev/null || true` +
    `\nchmod 0644 "$OVR" 2>/dev/null || true`;
  try {
    // Cloud backends signal script failure via a non-zero exitCode rather than
    // throwing, so a `set -e` abort (perms, missing paths) must be read off the
    // result — otherwise we'd log success while the box booted without facts.
    // The script also exits 0 in the no-op case (box-facts file absent) without
    // writing, so gate the "seeded" log on the wrote-marker, not just exit 0.
    const res = await backend.exec(handle, script);
    if (res.exitCode !== 0)
      log(
        `codex AGENTS.override seed failed (continuing): exit ${res.exitCode}${
          res.stderr.trim() ? `: ${res.stderr.trim()}` : ''
        }`,
      );
    else if (res.stdout.includes(CODEX_OVERRIDE_WROTE_MARKER))
      log('seeded Codex AGENTS.override.md');
    else log('codex AGENTS.override skipped: box-facts file absent');
  } catch (err) {
    log(
      `codex AGENTS.override seed failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
