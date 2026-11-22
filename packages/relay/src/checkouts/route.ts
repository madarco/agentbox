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
  /** The request names nothing any PC could serve; the box gets this message. */
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

  // Host tools: grants and binaries live with the machine that made them, so
  // only the origin PC may run one (any other PC is a different program).
  const paths = requestPaths(method, params);
  if (paths === undefined) {
    if (!reg.originMachineId) return { kind: 'unrouted' };
    const label = labelOf(reg.originMachineId);
    return {
      kind: 'routed',
      route: {
        candidates: [{ deviceId: reg.originMachineId, ...(label ? { label } : {}) }],
        ...(box.repos[0]?.repoKey ? { repoKey: box.repos[0].repoKey } : {}),
      },
    };
  }

  // Every path must be servable by a machine: keep the candidates common to
  // all of them, in the first path's order (a copy that mixes a repo file with
  // a file elsewhere on the origin's disk goes to the origin only).
  let ordered: HostReachCandidate[] | undefined;
  let repoKey: string | undefined;
  for (const path of paths) {
    const r = hostCandidatesFor(box, path, checkouts, () => true);
    if (!r.ok) return { kind: 'refused', error: r.error };
    repoKey ??= r.repo?.repoKey;
    const here = r.candidates.map((c) => {
      const label = labelOf(c.machineId);
      return { deviceId: c.machineId, ...(label ? { label } : {}), ...(c.folder ? { folder: c.folder } : {}) };
    });
    ordered =
      ordered === undefined
        ? here
        : ordered.filter((c) => here.some((h) => h.deviceId === c.deviceId));
  }
  if (!ordered || ordered.length === 0) {
    // No origin and no reported checkout: nothing says which PC holds the files.
    return { kind: 'unrouted' };
  }
  return { kind: 'routed', route: { candidates: ordered, ...(repoKey ? { repoKey } : {}) } };
}
