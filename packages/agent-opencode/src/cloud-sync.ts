/**
 * OpenCode's cloud-side behavior: seed the host's selected model into a freshly
 * created cloud box.
 *
 * It lived in `sandbox-cloud/src/sync/agent-credentials.ts` and was called by
 * name from `cloud-sync.ts` — one of the three per-agent steps that made adding
 * an agent mean editing the shared cloud layer.
 */

import type { CloudBackend, CloudHandle } from '@agentbox/core';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { stageOpencodeStateForUpload } from './host-stage.js';

/**
 * Box-side OpenCode state dir. Derived from the agent's declared `XDG_STATE_HOME`
 * (OpenCode appends `opencode/` to it), falling back to the XDG default for an
 * agent that declares none — so the seed always lands where the in-box agent
 * will actually look.
 */
const OPENCODE_STATE_DIR = ((): string => {
  const stateHome = resolveAgentSpec('opencode').boxRunEnv['XDG_STATE_HOME'];
  return stateHome ? `${stateHome}/opencode` : '/home/vscode/.local/state/opencode';
})();

/**
 * Seed the host's selected OpenCode model (`~/.local/state/opencode/model.json`)
 * into the box's state dir, host-authoritative, on **every** create. The
 * destination follows the agent's declared `XDG_STATE_HOME`, so it stays the dir
 * the in-box opencode actually reads.
 *
 * Unlike credentials (a seed-once volume), the cloud box's state dir is ephemeral
 * — there is no persistent per-box store on either cloud (Daytona's only shared
 * volume holds credentials; Hetzner has none), so the host is authoritative each
 * create and there is no marker to gate on. Without this, OpenCode boots a cloud
 * box with its built-in default model instead of the one the user picked on the
 * host. Provider-agnostic: runs on any `CloudBackend` (`exec` + `uploadFile`).
 *
 * Best-effort: a failure logs and leaves the box on OpenCode's default — it must
 * never fail box creation.
 */
export async function seedOpencodeModelState(
  backend: CloudBackend,
  handle: CloudHandle,
  opts: { onLog?: (line: string) => void } = {},
): Promise<void> {
  const log = opts.onLog ?? (() => {});
  const staged = await stageOpencodeStateForUpload();
  if (staged.tarballPath === null) {
    log('opencode: no host model selection to seed');
    return;
  }
  try {
    const remoteTar = '/tmp/agentbox-opencode-state.tar.gz';
    await backend.uploadFile(handle, staged.tarballPath, remoteTar);
    const res = await backend.exec(
      handle,
      `set -e; mkdir -p ${OPENCODE_STATE_DIR}; ` +
        `tar -xzf ${remoteTar} -C ${OPENCODE_STATE_DIR}; ` +
        `chown -R vscode:vscode ${OPENCODE_STATE_DIR} 2>/dev/null || true; ` +
        `rm -f ${remoteTar}`,
    );
    if (res.exitCode !== 0) {
      log(
        `opencode: model-state seed failed (exit ${String(res.exitCode)}); ` +
          `box falls back to OpenCode's default model. stderr: ${res.stderr.slice(-200)}`,
      );
      return;
    }
    log('opencode: model selection seeded ✓');
  } finally {
    await staged.cleanup();
  }
}
