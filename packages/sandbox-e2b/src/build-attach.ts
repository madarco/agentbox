/**
 * `buildE2bAttach` — the E2B provider's override of `Provider.buildAttach`.
 *
 * E2B has no SSH and no public PTY CLI like Vercel's `sbx exec -i`. We ship
 * our own attach helper (`attach-helper.cjs`) that connects to the sandbox via
 * the SDK and bridges the host PTY to an in-box `sandbox.pty.create()`.
 *
 * Argv shape:
 *   node <attach-helper.cjs> --sandbox-id <id> --user vscode
 *
 * The inner bash command (`renderInnerCommand` output: tmux ensure + attach)
 * is passed through the environment as `AGENTBOX_E2B_INNER_CMD` so quoting
 * stays sane and it doesn't leak through `ps`. `E2B_API_KEY` is passed through
 * the env for the same reason. `node-pty` (the host PTY wrapper) is what
 * spawns this argv, so stdin/stdout/SIGWINCH all reach the helper unchanged.
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
import { renderInnerCommand } from '@agentbox/sandbox-cloud';
import { resolveApiKey } from './sdk.js';

const SELF = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the absolute path to `attach-helper.cjs`. In the published CLI it
 * lives at `runtime/e2b/attach-helper.cjs` (next to the staged provider
 * runtime tree); in dev it lives next to the package's `dist/`.
 */
export function resolveAttachHelperPath(): string {
  const candidates = [
    // dev: dist/index.js sibling
    resolve(SELF, 'attach-helper.cjs'),
    // dev: src compiled to dist/, while index.ts is in src/
    resolve(SELF, '..', 'dist', 'attach-helper.cjs'),
    // staged CLI: apps/cli/runtime/e2b/attach-helper.cjs
    resolve(SELF, '..', 'runtime', 'e2b', 'attach-helper.cjs'),
    resolve(SELF, '..', '..', 'runtime', 'e2b', 'attach-helper.cjs'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Last-resort: still return the first candidate so the error message points
  // somewhere informative.
  return candidates[0]!;
}

export async function buildE2bAttach(
  box: BoxRecord,
  kind: AttachKind,
  opts?: BuildAttachOptions,
): Promise<AttachSpec> {
  const sandboxId = box.cloud?.sandboxId;
  if (!sandboxId) {
    throw new Error(`e2b box ${box.name} has no sandboxId — record is malformed`);
  }

  const helper = resolveAttachHelperPath();
  if (!existsSync(helper)) {
    throw new Error(
      `e2b attach helper not found at ${helper} — rebuild the CLI (\`pnpm -w build\`) ` +
        'so packages/sandbox-e2b/dist/attach-helper.cjs is generated.',
    );
  }

  const apiKey = resolveApiKey();
  const inner = renderInnerCommand(kind, opts);
  // Forward the host's TERM (the helper has no host env once node-pty spawns
  // it, so pass it explicitly). The helper sets it on the in-box PTY; the
  // renderInnerCommand TERM guard downgrades to xterm-256color when the box's
  // terminfo doesn't carry it (e.g. xterm-ghostty), matching the docker path.
  const hostTerm = process.env['TERM'] ?? 'xterm-256color';

  const argv = [
    process.execPath,
    helper,
    '--sandbox-id',
    sandboxId,
    '--user',
    'vscode',
  ];
  // Detached pre-start (new-tab attach / `-i` queue worker): the inner command
  // only creates the tmux session (no `exec tmux attach`). The helper must run
  // it once and EXIT rather than open a persistent interactive PTY that idles
  // forever — otherwise the host's `runDetached` await never resolves and
  // `agentbox <agent>` hangs after "box ready". See attach-helper.ts header.
  if (opts?.detached) argv.push('--detached');

  return {
    argv,
    env: {
      E2B_API_KEY: apiKey,
      AGENTBOX_E2B_INNER_CMD: inner,
      AGENTBOX_HOST_TERM: hostTerm,
    },
  };
}
