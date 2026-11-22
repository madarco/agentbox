import type { BoxRegistration } from './types.js';

/**
 * The origin stamp of a (re-)registration. Most re-registers (start, resume,
 * rehydrate) send no origin at all, and one from another PC must not claim the
 * box: the repo key is refreshed when sent, the origin machine is kept from
 * the first registration that named one.
 */
export function mergeRegistrationOrigin(
  body: {
    repoKey?: unknown;
    originMachineId?: unknown;
    originMachineLabel?: unknown;
    originFolder?: unknown;
  },
  existing:
    | Pick<BoxRegistration, 'repoKey' | 'originMachineId' | 'originMachineLabel' | 'originFolder'>
    | undefined,
): Pick<BoxRegistration, 'repoKey' | 'originMachineId' | 'originMachineLabel' | 'originFolder'> {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  const repoKey = str(body.repoKey) ?? existing?.repoKey;
  const kept = existing?.originMachineId !== undefined;
  const originMachineId = kept ? existing.originMachineId : str(body.originMachineId);
  const originMachineLabel = kept
    ? existing.originMachineLabel
    : originMachineId
      ? str(body.originMachineLabel)
      : undefined;
  const originFolder = kept
    ? existing.originFolder
    : originMachineId
      ? str(body.originFolder)
      : undefined;
  return {
    ...(repoKey ? { repoKey } : {}),
    ...(originMachineId ? { originMachineId } : {}),
    ...(originMachineLabel ? { originMachineLabel } : {}),
    ...(originFolder ? { originFolder } : {}),
  };
}
