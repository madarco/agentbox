/**
 * Doctor probes + normalized credential status for the vercel provider,
 * assembled into `providerModule` in `index.ts`. Moved out of apps/cli so the
 * CLI dispatches to it generically (see `@agentbox/sandbox-core`'s `ProviderModule`).
 */

import { errSummary, type CheckResult, type CredStatusSummary } from '@agentbox/sandbox-core';
import { readVercelCredStatus } from './credentials.js';
import { readPreparedState } from './prepared-state.js';

export function readCredStatusSummary(): CredStatusSummary {
  const cred = readVercelCredStatus();
  return { configured: cred.auth !== 'none', label: cred.auth };
}

export async function doctorChecks(): Promise<CheckResult[]> {
  try {
    const cred = readVercelCredStatus();
    const credRes: CheckResult =
      cred.auth === 'none'
        ? {
            label: 'credentials',
            status: 'warn',
            detail: 'not configured',
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
          hint: '`agentbox prepare --provider vercel`',
        };
    return [credRes, snapRes];
  } catch (err) {
    return [{ label: 'credentials', status: 'warn', detail: errSummary(err) }];
  }
}
