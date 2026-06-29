/**
 * Shared `cp.toHost` / `cp.fromHost` wire handling for both the docker `/rpc`
 * route (`server.ts`) and the cloud host-action queue (`host-actions.ts`).
 *
 * Both paths converge on the same move: normalize the wire params into
 * sources + destination, then re-shell the installed `agentbox cp` host CLI
 * (which owns the tar pipe, excludes, the size guard, and provider routing).
 * Keeping the argv builder here means the docker and cloud paths can't drift.
 */

import type { CpRpcParams } from './types.js';

export type CpMethod = 'cp.toHost' | 'cp.fromHost';

/**
 * Normalize the wire params into `{ sources, dest }`, tolerating the legacy
 * single-source `{ boxPath, hostPath }` shape sent by an older in-box
 * `agentbox-ctl` baked into a box image before multi-source support. Throws a
 * plain `Error` (message is safe to surface) on a malformed payload.
 */
export function normalizeCpParams(
  method: CpMethod,
  params: CpRpcParams | undefined,
): { sources: string[]; dest: string } {
  if (!params) throw new Error('cp.* requires params');
  let sources = params.sources;
  let dest = params.dest;
  // Legacy fallback: derive sources/dest from boxPath/hostPath by direction.
  if (!Array.isArray(sources) || sources.length === 0 || typeof dest !== 'string') {
    if (typeof params.boxPath === 'string' && typeof params.hostPath === 'string') {
      if (method === 'cp.toHost') {
        sources = [params.boxPath];
        dest = params.hostPath;
      } else {
        sources = [params.hostPath];
        dest = params.boxPath;
      }
    }
  }
  if (!Array.isArray(sources) || sources.length === 0 || sources.some((s) => typeof s !== 'string')) {
    throw new Error('cp.* requires a non-empty {sources} string array (or legacy {boxPath, hostPath})');
  }
  if (typeof dest !== 'string') {
    throw new Error('cp.* requires a {dest} string (or legacy {boxPath, hostPath})');
  }
  return { sources, dest };
}

/** Translate the optional cp flags back into `agentbox cp` argv flags. */
export function cpFlags(params: CpRpcParams): string[] {
  const flags: string[] = [];
  for (const pat of params.exclude ?? []) flags.push('--exclude', pat);
  if (params.defaultExcludes === false) flags.push('--no-default-excludes');
  if (params.yes) flags.push('--yes');
  return flags;
}

/**
 * Build the `agentbox cp <src...> <dst>` argv (leading `cp`, no node/entry) plus
 * a human-facing detail line for the consent prompt. The box side carries the
 * `<boxName>:` prefix; host paths are resolved to absolute via `resolveHost`
 * (against the box workspace) so the prompt shows the real destination and the
 * argv doesn't depend on the re-shelled process's cwd.
 */
export function buildCpArgv(opts: {
  method: CpMethod;
  boxName: string;
  sources: string[];
  dest: string;
  resolveHost: (p: string) => string;
  flags: string[];
}): { argv: string[]; detail: string; contextArgv: string[] } {
  const { method, boxName, sources, dest, resolveHost, flags } = opts;
  if (method === 'cp.toHost') {
    const hostAbs = resolveHost(dest);
    const boxArgs = sources.map((s) => `${boxName}:${s}`);
    return {
      argv: ['cp', ...boxArgs, hostAbs, ...flags],
      detail: `${sources.join(', ')} -> ${hostAbs}`,
      contextArgv: [...sources, hostAbs],
    };
  }
  const hostAbsSrcs = sources.map(resolveHost);
  return {
    argv: ['cp', ...hostAbsSrcs, `${boxName}:${dest}`, ...flags],
    detail: `${hostAbsSrcs.join(', ')} -> ${dest}`,
    contextArgv: [...hostAbsSrcs, dest],
  };
}
