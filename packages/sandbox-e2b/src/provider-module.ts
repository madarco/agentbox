/**
 * Doctor probes + normalized credential status for the e2b provider,
 * assembled into `providerModule` in `index.ts`. Moved out of apps/cli so the
 * CLI dispatches to it generically (see `@agentbox/sandbox-core`'s `ProviderModule`).
 */

import { errSummary, type CheckResult, type CredStatusSummary } from '@agentbox/sandbox-core';
import { readE2bCredStatus } from './credentials.js';
import { parseE2bSize } from './prepare.js';
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

/**
 * E2B fixes resources at TEMPLATE-build time and rejects per-create resources,
 * so any size that disagrees with the bake is discarded. Same comparison the
 * backend makes at provision — kept in step so the two can't drift.
 */
export function sizeIgnoredReason(size: string): string | null {
  let requested: string | undefined;
  try {
    const parsed = parseE2bSize(size);
    if (parsed) requested = `${String(parsed.cpuCount)}-${String(parsed.memoryMB / 1024)}`;
  } catch {
    // parseE2bSize THROWS on a malformed spec (unlike daytona's, which returns
    // undefined). A foreign value in the generic `box.size` isn't ours to
    // validate here — `prepare` surfaces it. Stay quiet.
    return null;
  }
  if (!requested) return null;
  const prepared = readPreparedState();
  // Nothing baked yet: `prepare` will build the template AT this size, so there
  // is no mismatch to report (same reasoning as daytona's).
  if (!prepared.base) return null;
  const baked = prepared.base.size;
  if (requested === baked) return null;
  return (
    `e2b: size '${requested}' is ignored at create time; this template was baked at ` +
    `${baked ?? 'the default size'}. E2B resources are fixed at bake time — re-bake with ` +
    `\`agentbox prepare --provider e2b --size ${requested} --force\` to change them.`
  );
}
