/**
 * `buildVercelAttach` — the Vercel provider's override of `Provider.buildAttach`.
 *
 * Vercel has no SSH, so the cloud scaffold's `ssh … -t '<cmd>'` argv is unusable.
 * Instead we drive the official Vercel Sandbox CLI (`sbx`/`sandbox`), which has a
 * real interactive PTY (`sbx exec -i`) and streams non-interactive output live —
 * giving a proper terminal with none of the old send-keys/capture-pane polling.
 *
 * Argv shape (validated against sbx 3.0.1):
 *   sbx exec --sudo [-i] --project <p> --scope <team> <name>
 *       -- sudo -u vscode -H bash -lc '<inner>'
 *
 * Notes:
 *   - The sandbox's default exec user is `vercel-sandbox`; we pass `--sudo` (runs
 *     as root) and then `sudo -u vscode -H` so tmux/agents run as the box user in
 *     /workspace. Passing `sudo -u vscode …` directly as sbx's argv (not wrapped
 *     in an outer `bash -lc`) avoids a double-`bash -lc` re-parse.
 *   - `-i` only for interactive shell/agent attaches; detached pre-start and logs
 *     run non-interactively (live stdout stream).
 *   - The access token is passed via the child env (`VERCEL_AUTH_TOKEN`), never in
 *     argv, so it can't leak through `ps`. project/scope are not secret → flags.
 *   - `<inner>` is the shared cloud `renderInnerCommand` (same tmux ensure +
 *     footer-aware config + `exec tmux attach` used by hetzner/daytona).
 */

import {
  type AttachKind,
  type AttachSpec,
  type BoxRecord,
  type BuildAttachOptions,
} from '@agentbox/core';
import { renderInnerCommand } from '@agentbox/sandbox-cloud';
import { detectSbx } from './sbx-cli.js';
import { ensureFreshCredentials, resolveCredentials } from './sdk.js';

export async function buildVercelAttach(
  box: BoxRecord,
  kind: AttachKind,
  opts?: BuildAttachOptions,
): Promise<AttachSpec> {
  const sandboxId = box.cloud?.sandboxId;
  if (!sandboxId) {
    throw new Error(`vercel box ${box.name} has no sandboxId — record is malformed`);
  }

  const det = await detectSbx();
  if (!det.installed || !det.bin) {
    throw new Error(
      'Vercel interactive attach needs the Vercel `sandbox` CLI — run ' +
        '`agentbox vercel login` (it installs it) or `npm install -g sandbox`.',
    );
  }

  await ensureFreshCredentials();
  const { token, teamId, projectId } = resolveCredentials();

  // Interactive (real PTY) only for live shell/agent attaches. Detached
  // pre-start and logs stream non-interactively.
  const interactive = (kind === 'shell' || kind === 'agent') && !opts?.detached;

  // `sbx exec` (unlike `ssh -t`) forwards neither TERM nor the locale, so the
  // box session lands in TERM=unknown + an ASCII (POSIX) locale — tmux then
  // collapses Claude Code's Unicode glyphs (logo, spinner, box-drawing) to `_`.
  // Force a UTF-8 locale and forward the host's TERM (matching the docker
  // provider) so a box that carries that terminfo renders at full fidelity;
  // renderInnerCommand's TERM guard downgrades to xterm-256color when it
  // doesn't, so an exotic host TERM (e.g. xterm-ghostty) never breaks attach.
  const hostTerm = process.env['TERM'] ?? 'xterm-256color';
  const envPrelude = `export LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=${hostTerm}; `;
  const inner = envPrelude + renderInnerCommand(kind, opts);

  const argv = [
    det.bin,
    'exec',
    '--sudo',
    ...(interactive ? ['-i'] : []),
    '--project',
    projectId,
    '--scope',
    teamId,
    sandboxId,
    '--',
    'sudo',
    '-u',
    'vscode',
    '-H',
    'bash',
    '-lc',
    inner,
  ];

  return { argv, env: { VERCEL_AUTH_TOKEN: token } };
}
