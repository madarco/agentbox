/**
 * Doctor probes + normalized credential status for the daytona provider,
 * assembled into `providerModule` in `index.ts`. Moved out of apps/cli so the
 * CLI dispatches to it generically (see `@agentbox/sandbox-core`'s `ProviderModule`).
 */

import { loadEffectiveConfig, resolveDaytonaClass } from '@agentbox/config';
import { errSummary, type CheckResult, type CredStatusSummary } from '@agentbox/sandbox-core';
import { parseDaytonaSize } from './backend.js';
import { readPreparedDaytonaState } from './prepared-state.js';
import { getDaytonaStatus, hasDaytonaCredentials } from './status.js';

export function readCredStatusSummary(): CredStatusSummary {
  // Credentials only — no network. This runs in the install wizard's provider
  // step just to answer "logged in?", and it used to fetch the whole snapshot +
  // volume inventory to do it.
  return { configured: hasDaytonaCredentials().configured };
}

export async function doctorChecks(): Promise<CheckResult[]> {
  try {
    // Snapshots only: the rows below render the snapshot count and nothing else,
    // so the volume list was a second API round-trip whose result was discarded.
    const status = await getDaytonaStatus({ volumes: false });
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

/**
 * Daytona fixes resources when the SNAPSHOT is baked and rejects them on the
 * create call (`backend.ts` deletes `resources` on the snapshot path), so a
 * size that disagrees with the bake is discarded. Same comparison the backend
 * makes at provision — kept in step so the two can't drift.
 */
export function sizeIgnoredReason(size: string): string | null {
  const parsed = parseDaytonaSize(size);
  // A foreign spec (a hetzner server type sitting in the generic `box.size`)
  // isn't ours to judge — `prepare` surfaces that. Stay quiet.
  if (!parsed) return null;
  const requested = `${String(parsed.cpu)}-${String(parsed.memory)}-${String(parsed.disk)}`;
  const prepared = readPreparedDaytonaState();
  // Nothing baked yet: `prepare` will bake AT this size, so there is no
  // mismatch to report. Warning here would tell a first-run user their brand
  // new setting is ignored, which is the opposite of true.
  if (!prepared?.base) return null;
  // `effectiveSize` names real numbers even for a default bake; `size` (the
  // requested spec) is the fallback for snapshots baked before it was recorded.
  const baked = prepared.extras?.effectiveSize ?? prepared.extras?.size;
  if (requested === baked) return null;
  return (
    `daytona: size '${requested}' is ignored on the snapshot path; this snapshot was baked at ` +
    `${baked ?? 'the default size'}. Daytona resources are fixed at bake time — re-bake with ` +
    `\`agentbox prepare --provider daytona --size ${requested} --force\` to change them.`
  );
}
