/**
 * Doctor probes + normalized credential status for the example provider,
 * assembled into `providerModule` in `index.ts`. The CLI dispatches to these
 * generically (see the SDK's `ProviderModule`), so `agentbox doctor` shows an
 * `example:` group with the same shape as the built-in providers.
 */

import { errSummary, type CheckResult, type CredStatusSummary } from '@madarco/agentbox-provider-sdk';
import { readExampleCredStatus } from './credentials.js';
import { readPreparedState } from './prepared-state.js';

export function readCredStatusSummary(): CredStatusSummary {
  const cred = readExampleCredStatus();
  return { configured: cred.auth !== 'none', label: cred.auth };
}

export async function doctorChecks(): Promise<CheckResult[]> {
  try {
    const cred = readExampleCredStatus();
    const credRes: CheckResult =
      cred.auth === 'none'
        ? {
            label: 'credentials',
            status: 'warn',
            detail: 'not configured (reuses the built-in Vercel creds)',
            hint: '`agentbox vercel login`',
          }
        : { label: 'credentials', status: 'ok', detail: `${cred.auth} (${cred.source})` };

    const prepared = readPreparedState();
    const snapRes: CheckResult = prepared.base?.snapshotId
      ? {
          label: 'base snapshot',
          status: 'ok',
          detail: `${prepared.base.snapshotId.slice(0, 16)}… (${prepared.base.cliVersion ?? '—'})`,
        }
      : {
          label: 'base snapshot',
          status: 'warn',
          detail: 'not baked',
          hint: '`agentbox prepare --provider example`',
        };
    return [credRes, snapRes];
  } catch (err) {
    return [{ label: 'credentials', status: 'warn', detail: errSummary(err) }];
  }
}
