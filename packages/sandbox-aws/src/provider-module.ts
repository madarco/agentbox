/**
 * Doctor probes + normalized credential status for the aws provider, assembled
 * into `providerModule` in `index.ts`. Lives here (not in apps/cli) so the CLI
 * dispatches to it generically — see `ProviderModule` in `@agentbox/sandbox-core`.
 */

import { errSummary, type CheckResult, type CredStatusSummary } from '@agentbox/sandbox-core';
import { detectPortless, portlessDoctorRow } from '@agentbox/sandbox-cloud';
import { readAwsCredStatus } from './credentials.js';
import { readPreparedState } from './prepared-state.js';

export function readCredStatusSummary(): CredStatusSummary {
  const s = readAwsCredStatus();
  if (s.source === 'none') return { configured: false };
  return { configured: true, label: s.profile ? `profile ${s.profile}` : 'access key' };
}

export async function doctorChecks(): Promise<CheckResult[]> {
  try {
    const cred = readAwsCredStatus();
    const credRes: CheckResult =
      cred.source === 'none'
        ? {
            label: 'credentials',
            status: 'warn',
            detail: 'no AWS profile or access key configured',
            hint: '`agentbox aws login`',
          }
        : {
            label: 'credentials',
            status: 'ok',
            detail: `${cred.profile ? `profile ${cred.profile}` : 'access key'} from ${cred.source}` +
              (cred.region ? ` (${cred.region})` : ''),
          };

    const prepared = readPreparedState();
    const baseRes: CheckResult = prepared.base?.amiId
      ? {
          label: 'base AMI',
          status: 'ok',
          // The region matters enough to always show: an AMI cannot boot an
          // instance in a different region, and that mismatch is the most
          // confusing failure this provider has.
          detail: `${prepared.base.amiId} in ${prepared.base.region} (${prepared.base.cliVersion ?? '—'})`,
        }
      : {
          label: 'base AMI',
          status: 'warn',
          detail: 'not baked',
          hint: '`agentbox prepare --provider aws`',
        };

    // Host Portless mints the <box>.localhost alias for the SSH-forwarded port;
    // without it aws web URLs degrade to raw loopback.
    const portlessRes = portlessDoctorRow(await detectPortless());
    return [credRes, baseRes, portlessRes];
  } catch (err) {
    return [{ label: 'credentials', status: 'warn', detail: errSummary(err) }];
  }
}
