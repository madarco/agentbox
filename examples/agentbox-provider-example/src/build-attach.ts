/**
 * `buildExampleAttach` — the example provider's override of `Provider.buildAttach`.
 *
 * Vercel has no SSH, so the cloud scaffold's `ssh ... -t '<cmd>'` argv is unusable.
 * Instead we drive the official Vercel Sandbox CLI (`sbx`/`sandbox`), which has a
 * real interactive PTY (`sbx exec -i`) and streams non-interactive output live.
 *
 * Argv shape:
 *   sbx exec --sudo [-i] --project <p> --scope <team> <name>
 *       -- sudo -u vscode -H bash -lc '<inner>'
 *
 * The access token is passed via the child env (`VERCEL_AUTH_TOKEN`), never in
 * argv, so it can't leak through `ps`. `<inner>` is the SDK's shared
 * `renderInnerCommand` (same tmux ensure + config used by the built-in cloud
 * providers), prefixed with a UTF-8 locale + forwarded TERM.
 */

import {
  type AttachKind,
  type AttachSpec,
  type BoxRecord,
  type BuildAttachOptions,
  hostTermForCloud,
  renderInnerCommand,
} from '@madarco/agentbox-provider-sdk';
import { detectSbx } from './sbx-cli.js';
import { ensureFreshCredentials, resolveCredentials } from './sdk.js';

export async function buildExampleAttach(
  box: BoxRecord,
  kind: AttachKind,
  opts?: BuildAttachOptions,
): Promise<AttachSpec> {
  const sandboxId = box.cloud?.sandboxId;
  if (!sandboxId) {
    throw new Error(`example box ${box.name} has no sandboxId — record is malformed`);
  }

  const det = await detectSbx();
  if (!det.installed || !det.bin) {
    throw new Error(
      'Interactive attach needs the Vercel `sandbox` CLI — run ' +
        '`agentbox vercel login` (it installs it) or `npm install -g sandbox`.',
    );
  }

  await ensureFreshCredentials();
  const { token, teamId, projectId } = resolveCredentials();

  // Interactive (real PTY) only for live shell/agent attaches.
  const interactive = (kind === 'shell' || kind === 'agent') && !opts?.detached;

  // `sbx exec` forwards neither TERM nor the locale, so force a UTF-8 locale and
  // forward a safe host TERM (renderInnerCommand's guard downgrades an unknown
  // one to xterm-256color). hostTermForCloud sanitizes it for the bash prelude.
  const envPrelude = `export LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=${hostTermForCloud()}; `;
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
