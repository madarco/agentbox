/**
 * Per-create overlay of the in-box `~/.claude/_claude.json` from the host's
 * current `~/.claude.json` state.
 *
 * Runs on every cloud create across e2b/vercel/hetzner/daytona. The other
 * cloud providers also bake a `_claude.json` into their snapshot at prepare
 * time, but that baked file becomes stale if the host completes Claude's
 * onboarding (or changes theme) after `agentbox prepare`. E2B doesn't bake
 * `_claude.json` at all — only the symlink `~/.claude.json` ->
 * `~/.claude/_claude.json` — so without this overlay a fresh E2B box has no
 * `_claude.json` and Claude shows the theme picker on first run.
 *
 * The payload is one tiny JSON file; transport is `backend.uploadFile` +
 * `backend.exec`, the same primitive used for credentials/dynamic-sync. The
 * extract runs as `vscode`, so no chown is needed.
 *
 * Best-effort: a failure logs and never sinks `agentbox create`. The in-box
 * Claude will fall back to its baked / first-run behavior.
 */

import { stageClaudeJsonOnlyForUpload } from '@agentbox/sandbox-core';
import type { CloudBackend, CloudHandle } from '@agentbox/core';

export interface SeedClaudeJsonOptions {
  /** Host-absolute workspace path being mounted at `/workspace` in the box. */
  hostWorkspace?: string;
  onLog?: (line: string) => void;
}

const REMOTE_TAR = '/tmp/agentbox-claude-json.tar.gz';
const BOX_CLAUDE_DIR = '/home/vscode/.claude';

/**
 * Stage `_claude.json` from the host, upload it to the box, and extract into
 * `~/.claude/`. Overwrites any baked `_claude.json` — this is intentional, the
 * baked one is a prepare-time snapshot and we want the latest host state.
 */
export async function seedClaudeJsonAtCreate(
  backend: CloudBackend,
  handle: CloudHandle,
  opts: SeedClaudeJsonOptions = {},
): Promise<void> {
  const log = opts.onLog ?? (() => {});
  let staged: Awaited<ReturnType<typeof stageClaudeJsonOnlyForUpload>> | null = null;
  try {
    staged = await stageClaudeJsonOnlyForUpload({ hostWorkspace: opts.hostWorkspace });
    if (staged.tarballPath === null) {
      log('claude: no _claude.json overlay (host has no claude config)');
      return;
    }
    await backend.uploadFile(handle, staged.tarballPath, REMOTE_TAR);
    const extract = await backend.exec(
      handle,
      `set -e; mkdir -p ${BOX_CLAUDE_DIR}; ` +
        `tar -xzf ${REMOTE_TAR} -C ${BOX_CLAUDE_DIR}; ` +
        `rm -f ${REMOTE_TAR}`,
    );
    if (extract.exitCode !== 0) {
      log(
        `claude: _claude.json overlay extract failed (exit ${String(extract.exitCode)}); ` +
          `stderr: ${extract.stderr.slice(-200)}`,
      );
      return;
    }
    log('claude: _claude.json overlay seeded');
  } catch (err) {
    log(
      `claude: _claude.json overlay failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (staged) await staged.cleanup();
  }
}
