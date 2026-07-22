/**
 * `buildTenkiAttach` — the Tenki provider's override of `Provider.buildAttach`.
 *
 * Tenki has no host-side SSH binary to shell out to, but the SDK exposes
 * `session.ssh()` — a PTY-backed shell channel over the data plane. We ship a
 * small helper (`attach-helper.cjs`) that the host's node-pty spawns; it opens
 * `session.ssh()` and bridges the host PTY's stdin/stdout to that channel.
 *
 * Argv shape:
 *   node <attach-helper.cjs> --session-id <id>
 *
 * The inner bash command (`renderInnerCommand` output: tmux ensure + attach)
 * is passed via the environment as `AGENTBOX_TENKI_INNER_CMD` so quoting stays
 * sane and it doesn't leak through `ps`. The auth token + control-plane
 * overrides are passed the same way.
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
import { resolveAuthToken } from './sdk.js';

const SELF = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the absolute path to `attach-helper.cjs`. In the published CLI it
 * lives at `runtime/tenki/attach-helper.cjs` (next to the staged provider
 * runtime tree); in dev it lives next to the package's `dist/`.
 */
export function resolveAttachHelperPath(): string {
  const candidates = [
    resolve(SELF, 'attach-helper.cjs'),
    resolve(SELF, '..', 'dist', 'attach-helper.cjs'),
    resolve(SELF, '..', 'runtime', 'tenki', 'attach-helper.cjs'),
    resolve(SELF, '..', '..', 'runtime', 'tenki', 'attach-helper.cjs'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0]!;
}

export async function buildTenkiAttach(
  box: BoxRecord,
  kind: AttachKind,
  opts?: BuildAttachOptions,
): Promise<AttachSpec> {
  const sandboxId = box.cloud?.sandboxId;
  if (!sandboxId) {
    throw new Error(`tenki box ${box.name} has no sandboxId — record is malformed`);
  }

  const helper = resolveAttachHelperPath();
  if (!existsSync(helper)) {
    throw new Error(
      `tenki attach helper not found at ${helper} — rebuild the CLI (\`pnpm -w build\`) ` +
        'so packages/sandbox-tenki/dist/attach-helper.cjs is generated.',
    );
  }

  const authToken = resolveAuthToken();
  const inner = renderInnerCommand(kind, opts);
  const hostTerm = hostTermForCloud();

  const argv = [process.execPath, helper, '--session-id', sandboxId];
  // Detached pre-start: the inner command only CREATES the tmux session (no
  // `exec tmux attach`). The helper runs it once over a plain exec and exits,
  // rather than opening an interactive channel that would idle forever and
  // hang the host's `runDetached` await. See attach-helper.ts header.
  if (opts?.detached) argv.push('--detached');

  const env: Record<string, string> = {
    TENKI_AUTH_TOKEN: authToken,
    AGENTBOX_TENKI_INNER_CMD: inner,
    AGENTBOX_HOST_TERM: hostTerm,
  };
  // Forward control-plane overrides so the helper talks to the same backend.
  if (process.env.TENKI_BASE_URL) env.TENKI_BASE_URL = process.env.TENKI_BASE_URL;
  if (process.env.TENKI_GATEWAY_ADDRESS) env.TENKI_GATEWAY_ADDRESS = process.env.TENKI_GATEWAY_ADDRESS;

  return { argv, env };
}
