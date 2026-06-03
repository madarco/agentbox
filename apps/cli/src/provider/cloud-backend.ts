/**
 * Lazily resolve a cloud `CloudBackend` by provider name. Dynamic imports keep
 * the heavy provider SDKs (Daytona/Hetzner/Vercel) off the docker hot path.
 * Returns `null` for `docker` (no cloud backend) and any unknown name.
 */
import type { CloudBackend, ProviderName } from '@agentbox/core';

export async function cloudBackendForProvider(
  provider: ProviderName,
): Promise<CloudBackend | null> {
  switch (provider) {
    case 'daytona':
      return (await import('@agentbox/sandbox-daytona')).daytonaBackend;
    case 'hetzner':
      return (await import('@agentbox/sandbox-hetzner')).hetznerBackend;
    case 'vercel':
      return (await import('@agentbox/sandbox-vercel')).vercelBackend;
    case 'e2b':
      return (await import('@agentbox/sandbox-e2b')).e2bBackend;
    default:
      return null;
  }
}

/**
 * Compute the CURRENT build-context fingerprint for a cloud provider's base
 * image / snapshot — same shape as `cloudBackendForProvider` but resolves the
 * provider package's `*BaseFingerprintLive()` helper instead of the backend.
 * Dynamic imports keep the cloud SDKs off the docker hot path.
 *
 * Returns `undefined` for docker (its base self-heals via `ensureImage`) and
 * any provider whose live computation fails (typically a dev tree without
 * `pnpm -w build` — callers degrade to "can't tell, don't nag").
 */
export async function currentCloudBaseFingerprintLive(
  provider: ProviderName,
): Promise<string | undefined> {
  switch (provider) {
    case 'daytona':
      return (await import('@agentbox/sandbox-daytona')).currentDaytonaBaseFingerprintLive();
    case 'hetzner':
      return (await import('@agentbox/sandbox-hetzner')).currentHetznerBaseFingerprintLive();
    case 'vercel':
      return (await import('@agentbox/sandbox-vercel')).currentVercelBaseFingerprintLive();
    case 'e2b':
      return (await import('@agentbox/sandbox-e2b')).currentE2bBaseFingerprintLive();
    default:
      return undefined;
  }
}
