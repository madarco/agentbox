/**
 * Doctor probes + normalized credential status for the daytona provider,
 * assembled into `providerModule` in `index.ts`. Moved out of apps/cli so the
 * CLI dispatches to it generically (see `@agentbox/sandbox-core`'s `ProviderModule`).
 */

import { loadEffectiveConfig, resolveDaytonaClass } from '@agentbox/config';
import { errSummary, type CheckResult, type CredStatusSummary } from '@agentbox/sandbox-core';
import { readPreparedDaytonaState } from './prepared-state.js';
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
    return [credRes, await baseSnapshotCheck(status.snapshots.length)];
  } catch (err) {
    return [{ label: 'credentials', status: 'warn', detail: errSummary(err) }];
  }
}

/**
 * A snapshot existing isn't enough: a snapshot's class is immutable and can only
 * create sandboxes of that same class, so a container base with
 * `box.daytonaClass: linux-vm` configured is unusable — every create would fail.
 * Counting snapshots would report that as healthy, so compare the class too.
 */
async function baseSnapshotCheck(snapshotCount: number): Promise<CheckResult> {
  if (snapshotCount === 0) {
    return {
      label: 'base snapshot',
      status: 'warn',
      detail: 'none',
      hint: '`agentbox prepare --provider daytona`',
    };
  }
  const prepared = readPreparedDaytonaState();
  // Absent `class` = a snapshot baked before classes existed, which was
  // necessarily a container.
  const bakedClass = prepared?.base ? (prepared.extras?.class ?? 'container') : undefined;

  let wantClass: string | undefined;
  try {
    wantClass = resolveDaytonaClass((await loadEffectiveConfig(process.cwd())).effective);
  } catch {
    // No project config to read (e.g. doctor run outside a project) — the count
    // is still worth reporting; just don't claim anything about the class.
  }

  if (bakedClass && wantClass && bakedClass !== wantClass) {
    return {
      label: 'base snapshot',
      status: 'warn',
      detail: `baked as '${bakedClass}' but box.daytonaClass is '${wantClass}' — creates will fail`,
      hint: '`agentbox prepare --provider daytona --force`',
    };
  }
  return {
    label: 'base snapshot',
    status: 'ok',
    detail: `${String(snapshotCount)} agentbox snapshot(s)${bakedClass ? ` (base: ${bakedClass})` : ''}`,
  };
}
