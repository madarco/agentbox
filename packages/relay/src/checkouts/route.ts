/**
 * Where a box's host-reach request may go (multi-PC Phase 4): the PCs allowed
 * to serve it, in order, from `hostCandidatesFor`. Pure; the queue applies who
 * is online at delivery time, so presence is NOT decided here.
 */
import { normalizeCpParams, type CpMethod } from '../cp-rpc.js';
import type { HostReachCandidate, HostReachRoute } from '../host-reach.js';
import type { BoxRegistration } from '../types.js';
import type { CpRpcParams } from '../types.js';
import { candidateBoxFromRegistration, hostCandidatesFor } from './resolve.js';
import type { CheckoutRecord } from './types.js';

export type HostReachRouteResult =
  | { kind: 'routed'; route: HostReachRoute }
  /** Nothing to route by (a box from before origin machines and checkouts): any PC. */
  | { kind: 'unrouted' }
  /** The request names nothing any one PC could serve; the box gets this message. */
  | { kind: 'refused'; error: string };

/**
 * The paths a request is about: the host sources of `cp.fromHost`, the host
 * destination of `cp.toHost`. Host tools name no path.
 */
function requestPaths(method: string, params: unknown): string[] | undefined {
  if (method !== 'cp.fromHost' && method !== 'cp.toHost') return undefined;
  try {
    const norm = normalizeCpParams(method as CpMethod, params as CpRpcParams | undefined);
    return method === 'cp.fromHost' ? norm.sources : [norm.dest];
  } catch {
    return undefined;
  }
}

export function hostReachRouteFor(
  reg: Pick<
    BoxRegistration,
    | 'boxId'
    | 'repoKey'
    | 'originUrl'
    | 'projectSlug'
    | 'originMachineId'
    | 'originMachineLabel'
    | 'originFolder'
    | 'worktrees'
  >,
  method: string,
  params: unknown,
  checkouts: readonly CheckoutRecord[],
): HostReachRouteResult {
  const box = candidateBoxFromRegistration(reg);
  const labelOf = (deviceId: string): string | undefined =>
    deviceId === reg.originMachineId
      ? (reg.originMachineLabel ?? checkouts.find((c) => c.machineId === deviceId)?.label)
      : checkouts.find((c) => c.machineId === deviceId)?.label;

  const key = box.repos[0]?.repoKey;
  const originOnly = (): HostReachRouteResult => {
    if (!reg.originMachineId) return { kind: 'unrouted' };
    const label = labelOf(reg.originMachineId);
    const originFolder = box.repos[0]?.originFolder;
    return {
      kind: 'routed',
      route: {
        candidates: [
          {
            deviceId: reg.originMachineId,
            role: 'origin',
            ...(label ? { label } : {}),
            ...(originFolder ? { folder: originFolder } : {}),
          },
        ],
        ...(key ? { repoKey: key } : {}),
      },
    };
  };

  // Host tools: grants and binaries live with the machine that made them, so
  // only the origin PC may run one (any other PC is a different program).
  // Downloads too: a download WRITES the box into the project it was created
  // from, and on another PC's clone that would overwrite its working tree.
  const paths = requestPaths(method, params);
  if (paths === undefined) return originOnly();

  // A host-absolute path (`/Users/me/x`, `~/x`, also `/workspace/x`, which the
  // host resolves literally) names a spot on ONE machine's disk: only the
  // origin's. A repo-relative path can be served by any PC with the repo.
  const hostAbsolute = (p: string): boolean => p.startsWith('/') || p.startsWith('~');
  const absolute = paths.filter(hostAbsolute);
  if (absolute.length === paths.length) return originOnly();
  if (absolute.length > 0) {
    return {
      kind: 'refused',
      error:
        'no single machine can serve all of these paths (some are in the repo, some only on the ' +
        'machine that created the box); copy them separately',
    };
  }

  // Every path is repo-relative: keep the candidates common to all of them, in
  // the first path's order.
  let ordered: HostReachCandidate[] | undefined;
  let repoKey: string | undefined;
  for (const path of paths) {
    const r = hostCandidatesFor(box, path, checkouts, () => true);
    if (!r.ok) return { kind: 'refused', error: r.error };
    repoKey ??= r.repo?.repoKey;
    const here = r.candidates.map((c): HostReachCandidate => {
      const label = labelOf(c.machineId);
      return {
        deviceId: c.machineId,
        role: c.reason,
        ...(label ? { label } : {}),
        ...(c.folder ? { folder: c.folder } : {}),
      };
    });
    ordered =
      ordered === undefined
        ? here
        : ordered.filter((c) => here.some((h) => h.deviceId === c.deviceId));
  }
  if (!ordered || ordered.length === 0) {
    // Nothing says which PC holds the files: no origin machine (a box
    // registered before #424, or built on the hub) and no PC has reported a
    // checkout of its repo. Any PC that knows the box serves it, as before
    // routing existed, rather than nobody.
    return { kind: 'unrouted' };
  }
  return { kind: 'routed', route: { candidates: ordered, ...(repoKey ? { repoKey } : {}) } };
}
