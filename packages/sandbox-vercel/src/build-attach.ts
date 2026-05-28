/**
 * `buildVercelAttach` — the Vercel provider's override of `Provider.buildAttach`.
 *
 * The cloud scaffold's default `buildAttach` builds an `ssh ... -t '<cmd>'`
 * argv, which is unusable on Vercel (no SSH). Instead we return an argv that
 * spawns the bundled `attach-helper.js` under the host PTY wrapper; that helper
 * bridges the local terminal to the box's tmux session over the Vercel SDK (see
 * attach-helper.ts).
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AttachKind, AttachSpec, BoxRecord, BuildAttachOptions } from '@agentbox/core';

const SELF = dirname(fileURLToPath(import.meta.url));

interface AttachHelperSpec {
  sessionName: string;
  command: string;
  kind: AttachKind;
  detached?: boolean;
}

function defaultSessionName(kind: AttachKind): string {
  return kind;
}

function defaultCommand(kind: AttachKind, opts?: BuildAttachOptions): string {
  switch (kind) {
    case 'shell':
    case 'agent':
      return 'bash -l';
    case 'logs': {
      if (!opts?.service) return 'echo "no service specified"';
      const tail = opts.tail !== undefined ? String(opts.tail) : '200';
      const follow = opts.follow !== false ? ' --follow' : '';
      return `/usr/local/bin/agentbox-ctl logs ${opts.service} --tail ${tail}${follow}`;
    }
  }
}

/**
 * Resolve the compiled attach-helper entry. In the monorepo it sits next to
 * this module in `dist/`. (Publishing the standalone CLI needs the helper
 * staged into the CLI runtime tree — tracked in docs/vercel-backlog.md.)
 */
function resolveAttachHelperPath(): string {
  const candidates = [
    resolve(SELF, 'attach-helper.js'),
    resolve(SELF, '..', 'dist', 'attach-helper.js'),
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) {
    throw new Error(
      `vercel attach: could not find attach-helper.js (looked in: ${candidates.join(', ')}). ` +
        `Run \`pnpm --filter @agentbox/sandbox-vercel build\`.`,
    );
  }
  return hit;
}

export function buildVercelAttach(
  box: BoxRecord,
  kind: AttachKind,
  opts?: BuildAttachOptions,
): Promise<AttachSpec> {
  const sandboxId = box.cloud?.sandboxId;
  if (!sandboxId) {
    return Promise.reject(new Error(`vercel box ${box.name} has no sandboxId — record is malformed`));
  }
  const spec: AttachHelperSpec = {
    sessionName: opts?.sessionName ?? defaultSessionName(kind),
    command: opts?.command ?? defaultCommand(kind, opts),
    kind,
    detached: opts?.detached,
  };
  const argv = [
    process.execPath,
    resolveAttachHelperPath(),
    sandboxId,
    Buffer.from(JSON.stringify(spec), 'utf8').toString('base64'),
  ];
  return Promise.resolve({ argv });
}
