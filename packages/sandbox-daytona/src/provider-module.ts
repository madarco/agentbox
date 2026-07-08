/**
 * Doctor probes + normalized credential status for the daytona provider,
 * assembled into `providerModule` in `index.ts`. Moved out of apps/cli so the
 * CLI dispatches to it generically (see `@agentbox/sandbox-core`'s `ProviderModule`).
 */

import { errSummary, type CheckResult, type CredStatusSummary } from '@agentbox/sandbox-core';
import { getDaytonaStatus } from './status.js';

export async function readCredStatusSummary(): Promise<CredStatusSummary> {
  const status = await getDaytonaStatus();
  return { configured: status.configured };
}

export async function doctorChecks(): Promise<CheckResult[]> {
  try {
    const status = await getDaytonaStatus();
    if (!status.configured) {
      return [
        {
          label: 'credentials',
          status: 'warn',
          // The SDK's reason is a paragraph (env-var enumeration) — doctor just
          // needs the vercel/e2b-style one-liner; `prepare --status` keeps it.
          detail: 'not configured',
          hint: '`agentbox daytona login`',
        },
      ];
    }
    const credRes: CheckResult = { label: 'credentials', status: 'ok', detail: 'configured' };
    const snapRes: CheckResult =
      status.snapshots.length > 0
        ? {
            label: 'base snapshot',
            status: 'ok',
            detail: `${String(status.snapshots.length)} agentbox snapshot(s)`,
          }
        : {
            label: 'base snapshot',
            status: 'warn',
            detail: 'none',
            hint: '`agentbox prepare --provider daytona`',
          };
    return [credRes, snapRes];
  } catch (err) {
    return [{ label: 'credentials', status: 'warn', detail: errSummary(err) }];
  }
}
