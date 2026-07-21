/**
 * Doctor probes + normalized credential status for the e2b provider,
 * assembled into `providerModule` in `index.ts`. Moved out of apps/cli so the
 * CLI dispatches to it generically (see `@agentbox/sandbox-core`'s `ProviderModule`).
 */

import { errSummary, type CheckResult, type CredStatusSummary } from '@agentbox/sandbox-core';
import { readE2bCredStatus } from './credentials.js';
import { readPreparedState } from './prepared-state.js';

export function readCredStatusSummary(): CredStatusSummary {
  const cred = readE2bCredStatus();
  return { configured: cred.auth !== 'none', label: cred.auth };
}

export async function doctorChecks(): Promise<CheckResult[]> {
  try {
    const cred = readE2bCredStatus();
    const credRes: CheckResult =
      cred.auth === 'none'
        ? {
            label: 'credentials',
            status: 'warn',
            detail: 'not configured',
            hint: '`agentbox e2b login`',
          }
        : { label: 'credentials', status: 'ok', detail: `${cred.auth} (${cred.source})` };

    const prepared = readPreparedState();
    const tmplRes: CheckResult = prepared.base?.templateId
      ? {
          label: 'base template',
          status: 'ok',
          detail: `${prepared.base.templateName ?? prepared.base.templateId} (${prepared.base.cliVersion ?? '—'})`,
        }
      : {
          label: 'base template',
          status: 'warn',
          detail: 'not baked',
          hint: '`agentbox prepare --provider e2b`',
        };
    return [credRes, tmplRes];
  } catch (err) {
    return [{ label: 'credentials', status: 'warn', detail: errSummary(err) }];
  }
}
