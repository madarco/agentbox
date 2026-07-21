/**
 * Doctor probes + normalized credential status for the digitalocean provider,
 * assembled into `providerModule` in `index.ts`. Moved out of apps/cli so the
 * CLI dispatches to it generically (see `@agentbox/sandbox-core`'s `ProviderModule`).
 */

import { errSummary, type CheckResult, type CredStatusSummary } from '@agentbox/sandbox-core';
import { detectPortless, portlessDoctorRow } from '@agentbox/sandbox-cloud';
import { readDigitalOceanCredStatus } from './credentials.js';
import { readPreparedState } from './prepared-state.js';

export function readCredStatusSummary(): CredStatusSummary {
  return { configured: readDigitalOceanCredStatus().source !== 'none' };
}

export async function doctorChecks(): Promise<CheckResult[]> {
  try {
    const cred = readDigitalOceanCredStatus();
    const credRes: CheckResult =
      cred.source === 'none'
        ? {
            label: 'credentials',
            status: 'warn',
            detail: 'DIGITALOCEAN_TOKEN not set',
            hint: '`agentbox digitalocean login`',
          }
        : { label: 'credentials', status: 'ok', detail: `token from ${cred.source}` };

    const prepared = readPreparedState();
    const snapRes: CheckResult = prepared.base?.imageId
      ? {
          label: 'base snapshot',
          status: 'ok',
          detail: `snapshot ${String(prepared.base.imageId)} (${prepared.base.cliVersion ?? '—'})`,
        }
      : {
          label: 'base snapshot',
          status: 'warn',
          detail: 'not baked',
          hint: '`agentbox prepare --provider digitalocean`',
        };
    // Host Portless mints the <box>.localhost alias for the SSH-forwarded port;
    // without it digitalocean web URLs degrade to raw loopback.
    const portlessRes = portlessDoctorRow(await detectPortless());
    return [credRes, snapRes, portlessRes];
  } catch (err) {
    return [{ label: 'credentials', status: 'warn', detail: errSummary(err) }];
  }
}
