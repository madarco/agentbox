/**
 * Doctor probes + normalized credential status for the hetzner provider,
 * assembled into `providerModule` in `index.ts`. Moved out of apps/cli so the
 * CLI dispatches to it generically (see `@agentbox/sandbox-core`'s `ProviderModule`).
 */

import { errSummary, type CheckResult, type CredStatusSummary } from '@agentbox/sandbox-core';
import { detectPortless, portlessDoctorRow } from '@agentbox/sandbox-cloud';
import { readHetznerCredStatus } from './credentials.js';
import { readPreparedState } from './prepared-state.js';

export function readCredStatusSummary(): CredStatusSummary {
  return { configured: readHetznerCredStatus().source !== 'none' };
}

export async function doctorChecks(): Promise<CheckResult[]> {
  try {
    const cred = readHetznerCredStatus();
    const credRes: CheckResult =
      cred.source === 'none'
        ? {
            label: 'credentials',
            status: 'warn',
            detail: 'HCLOUD_TOKEN not set',
            hint: '`agentbox hetzner login`',
          }
        : { label: 'credentials', status: 'ok', detail: `token from ${cred.source}` };

    const prepared = readPreparedState();
    const snapRes: CheckResult = prepared.base?.imageId
      ? {
          label: 'base snapshot',
          status: 'ok',
          detail: `image ${String(prepared.base.imageId)} (${prepared.base.cliVersion ?? '—'})`,
        }
      : {
          label: 'base snapshot',
          status: 'warn',
          detail: 'not baked',
          hint: '`agentbox prepare --provider hetzner`',
        };
    // Host Portless mints the <box>.localhost alias for the SSH-forwarded port;
    // without it hetzner web URLs degrade to raw loopback.
    const portlessRes = portlessDoctorRow(await detectPortless());
    return [credRes, snapRes, portlessRes];
  } catch (err) {
    return [{ label: 'credentials', status: 'warn', detail: errSummary(err) }];
  }
}
