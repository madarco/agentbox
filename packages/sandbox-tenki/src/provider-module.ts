/**
 * Doctor probes + normalized credential status for the tenki provider,
 * assembled into `providerModule` in `index.ts`. Moved out of apps/cli so the
 * CLI dispatches to it generically (see `@agentbox/sandbox-core`'s `ProviderModule`).
 */

import { errSummary, type CheckResult, type CredStatusSummary } from '@agentbox/sandbox-core';
import { readTenkiCredStatus } from './credentials.js';
import { readPreparedState } from './prepared-state.js';

export function readCredStatusSummary(): CredStatusSummary {
  const cred = readTenkiCredStatus();
  return { configured: cred.auth !== 'none', label: cred.auth };
}

export async function doctorChecks(): Promise<CheckResult[]> {
  try {
    const cred = readTenkiCredStatus();
    const credRes: CheckResult =
      cred.auth === 'none'
        ? {
            label: 'credentials',
            status: 'warn',
            detail: 'not configured',
            hint: '`agentbox tenki login`',
          }
        : { label: 'credentials', status: 'ok', detail: `${cred.auth} (${cred.source})` };

    const prepared = readPreparedState();
    const baseRes: CheckResult = prepared.base?.image
      ? {
          label: 'base image',
          status: 'ok',
          detail: `${prepared.base.imageName ?? prepared.base.image} (${prepared.base.cliVersion ?? '—'})`,
        }
      : {
          label: 'base image',
          status: 'warn',
          detail: 'not prepared',
          hint: '`agentbox prepare --provider tenki`',
        };
    return [credRes, baseRes];
  } catch (err) {
    return [{ label: 'credentials', status: 'warn', detail: errSummary(err) }];
  }
}
