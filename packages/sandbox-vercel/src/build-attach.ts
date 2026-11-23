/**
 * `buildVercelAttach` — the Vercel provider's override of `Provider.buildAttach`.
 *
 * Vercel has no SSH, so the cloud scaffold's `ssh … -t '<cmd>'` argv is unusable.
 * Two transports:
 *   - Interactive shell/agent attaches drive the official Vercel Sandbox CLI
 *     (`sbx`/`sandbox`), which has a real interactive PTY (`sbx exec -i`).
 *   - The detached pre-start and `logs` run through our own `exec-helper.cjs`
 *     on the in-process `@vercel/sandbox` SDK, so the agent start does not
 *     depend on the host CLI's version (sbx 3.x fails under Node 26).
 *
 * Interactive argv shape:
 *   sbx exec --sudo -i --project <p> --scope <team> <name>
 *       -- sudo -u vscode -H bash -lc '<inner>'
 *
 * Notes:
 *   - The sandbox's default exec user is `vercel-sandbox`; we pass `--sudo` (runs
 *     as root) and then `sudo -u vscode -H` so tmux/agents run as the box user in
 *     /workspace. Passing `sudo -u vscode …` directly as sbx's argv (not wrapped
 *     in an outer `bash -lc`) avoids a double-`bash -lc` re-parse.
 *   - The access token is passed via the child env (`VERCEL_AUTH_TOKEN`), never in
 *     argv, so it can't leak through `ps`. project/scope are not secret → flags.
 *   - `<inner>` is the shared cloud `renderInnerCommand` (same tmux ensure +
 *     footer-aware config + `exec tmux attach` used by hetzner/daytona).
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AttachKind,
  type AttachSpec,
  type BoxRecord,
  type BuildAttachOptions,
} from '@agentbox/core';
import { hostTermForCloud, renderInnerCommand } from '@agentbox/sandbox-cloud';
import {
  BROKEN_NODE_MAJOR,
  detectSbx,
  installSbxHint,
  MIN_SBX_MAJOR,
  updateSbxHint,
} from './sbx-cli.js';
import { ensureFreshCredentials, resolveCredentials } from './sdk.js';

const SELF = dirname(fileURLToPath(import.meta.url));

let warnedOutdated = false;

/**
 * Resolve `exec-helper.cjs`. The published CLI stages it at
 * `runtime/vercel/exec-helper.cjs`, the hub standalone next to its server
 * bundle, and a dev build leaves it in this package's `dist/`.
 */
export function resolveExecHelperPath(): string {
  const candidates = [
    resolve(SELF, 'exec-helper.cjs'),
    resolve(SELF, 'vercel-exec-helper.cjs'),
    resolve(SELF, '..', 'dist', 'exec-helper.cjs'),
    resolve(SELF, '..', 'runtime', 'vercel', 'exec-helper.cjs'),
    resolve(SELF, '..', '..', 'runtime', 'vercel', 'exec-helper.cjs'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

export async function buildVercelAttach(
  box: BoxRecord,
  kind: AttachKind,
  opts?: BuildAttachOptions,
): Promise<AttachSpec> {
  const sandboxId = box.cloud?.sandboxId;
  if (!sandboxId) {
    throw new Error(`vercel box ${box.name} has no sandboxId — record is malformed`);
  }

  // Interactive (real PTY) only for live shell/agent attaches. Detached
  // pre-start and logs run on the SDK helper.
  const interactive = (kind === 'shell' || kind === 'agent') && !opts?.detached;

  // `sbx exec` (unlike `ssh -t`) forwards neither TERM nor the locale, so the
  // box session lands in TERM=unknown + an ASCII (POSIX) locale — tmux then
  // collapses Claude Code's Unicode glyphs (logo, spinner, box-drawing) to `_`.
  // Force a UTF-8 locale and forward the host's TERM (matching the docker
  // provider) so a box that carries that terminfo renders at full fidelity;
  // renderInnerCommand's TERM guard downgrades to xterm-256color when it
  // doesn't, so an exotic host TERM (e.g. xterm-ghostty) never breaks attach.
  // hostTermForCloud sanitizes to a safe terminfo name — required because this
  // value is interpolated into the bash -lc prelude below. The SDK helper path
  // gets the same prelude: the detached session it creates is the one the
  // later interactive attach joins.
  const envPrelude = `export LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=${hostTermForCloud()}; `;
  const inner = envPrelude + renderInnerCommand(kind, opts);

  if (!interactive) {
    const helper = resolveExecHelperPath();
    if (!existsSync(helper)) {
      throw new Error(
        `vercel exec helper not found at ${helper} — rebuild the CLI (\`pnpm -w build\`) ` +
          'so packages/sandbox-vercel/dist/exec-helper.cjs is generated.',
      );
    }
    await ensureFreshCredentials();
    const { token, teamId, projectId } = resolveCredentials();
    return {
      argv: [process.execPath, helper, '--sandbox-id', sandboxId, '--user', 'vscode'],
      env: {
        VERCEL_AUTH_TOKEN: token,
        AGENTBOX_VERCEL_TEAM_ID: teamId,
        AGENTBOX_VERCEL_PROJECT_ID: projectId,
        AGENTBOX_VERCEL_INNER_CMD: inner,
      },
    };
  }

  const det = await detectSbx();
  if (!det.installed || !det.bin) {
    throw new Error(
      'Vercel interactive attach needs the Vercel `sandbox` CLI — run ' +
        `\`agentbox vercel login\` (it installs it) or \`${installSbxHint()}\`.`,
    );
  }
  // An outdated sbx fails only under Node >= 26 (its bundled undici); on older
  // Node it still works, so refuse only the broken pairing and warn otherwise.
  if (det.broken) {
    throw new Error(
      `The Vercel \`sandbox\` CLI on this machine is ${det.version ?? 'too old'} running on Node ` +
        `${det.nodeMajor}; that pairing fails with "Sandbox API request failed … 200 OK". ` +
        `Interactive attach needs ${MIN_SBX_MAJOR}.x or newer — update it with ${updateSbxHint(det)} ` +
        'or `agentbox vercel login`.',
    );
  }
  if (det.outdated && !warnedOutdated) {
    // Once per process: the dashboard builds an attach per pane.
    warnedOutdated = true;
    process.stderr.write(
      `warning: the Vercel \`sandbox\` CLI ${det.version ?? ''} is older than ${MIN_SBX_MAJOR}.x and ` +
        `stops working on Node ${BROKEN_NODE_MAJOR}+; update it with ${updateSbxHint(det)}.\n`,
    );
  }

  await ensureFreshCredentials();
  const { token, teamId, projectId } = resolveCredentials();

  const argv = [
    det.bin,
    'exec',
    '--sudo',
    '-i',
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
