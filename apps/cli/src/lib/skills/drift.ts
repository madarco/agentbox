/**
 * The "skills not in sync" notice: after a create that doesn't attach, a queued
 * `-i` run and `agentbox queue list`, one line names this PC's skills that
 * differ from the hub's library. A box only gets the hub's copy, so a skill
 * added or edited on the PC after the first seed is otherwise missing from
 * every new box without a word (an orchestrating agent polling the queue is the
 * reader this is for).
 *
 * Same definition as `agentbox skills`: `compareSkills` + `isOutOfSync`, so a
 * skill marked skipped never counts. Best-effort and bounded: any failure (no
 * hub, an error, a timeout) is one debug line and no notice.
 */
import { homedir } from 'node:os';
import { log } from '@clack/prompts';
import { loadEffectiveConfig } from '@agentbox/config';
import { discoverLocalSkills, isOutOfSync, type LocalSkill } from '@agentbox/sandbox-core';
import { HubApiClient } from '../../control-plane/hub-api-client.js';
import { compareSkills } from './sync.js';

export interface SkillsDrift {
  outOfSync: number;
  /** Every out-of-sync name, sorted. */
  names: string[];
  localOnly: string[];
  changed: string[];
  hubOnly: string[];
}

/** The `--json` shape. */
export interface SkillsDriftJson {
  outOfSync: number;
  names: string[];
}

const DEFAULT_TIMEOUT_MS = 2000;
/** How many names one notice lists before "+N more". */
const MAX_NAMED = 5;

/**
 * Compare this PC's skills with the hub's library. Null when the notice is off,
 * this PC has no skills, or the hub can't answer within the budget; a drift
 * with `outOfSync: 0` when everything is in sync.
 */
export async function checkSkillsDrift(
  opts: {
    /** The hub to compare against; default the configured one. */
    url?: string;
    /** This PC's skills when the caller already scanned them. */
    local?: LocalSkill[];
    /** Why there is no answer (a log file, never the terminal). */
    debug?: (line: string) => void;
    timeoutMs?: number;
    cwd?: string;
  } = {},
): Promise<SkillsDrift | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref();
  });
  try {
    const res = await Promise.race([runCheck(opts, timeoutMs), deadline]);
    if (res === 'timeout') {
      opts.debug?.(`skills notice skipped: no answer within ${String(timeoutMs)}ms`);
      return null;
    }
    return res;
  } catch (err) {
    opts.debug?.(`skills notice skipped: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function runCheck(
  opts: { url?: string; local?: LocalSkill[]; debug?: (line: string) => void; cwd?: string },
  timeoutMs: number,
): Promise<SkillsDrift | null> {
  const cfg = await loadEffectiveConfig(opts.cwd ?? process.cwd()).catch(() => null);
  if (cfg && !cfg.effective.skills.notice) return null;
  const maxBytes = cfg?.effective.skills.maxSkillBytes ?? 50 * 1024 * 1024;
  const local = opts.local ?? (await discoverLocalSkills({ home: homedir(), maxBytes }));
  if (local.length === 0) {
    opts.debug?.('skills notice skipped: no skills on this PC');
    return null;
  }
  // Lazy, like autoSeedSkills: control-plane.ts sits in a module cycle with hub.ts.
  const { resolveHubApiTarget } = await import('../../commands/control-plane.js');
  const target = await resolveHubApiTarget(opts.url, { quiet: true });
  if (!target) {
    opts.debug?.('skills notice skipped: no hub could be resolved');
    return null;
  }
  const listing = await new HubApiClient(target).listSkills({ timeoutMs });
  return driftFromRows(compareSkills(local, listing.skills, listing.skipped ?? []));
}

export function driftFromRows(rows: readonly { name: string; status: string }[]): SkillsDrift {
  const pick = (status: string): string[] =>
    rows.filter((r) => r.status === status).map((r) => r.name);
  const names = rows
    .filter((r) => isOutOfSync(r.status))
    .map((r) => r.name)
    .sort();
  return {
    outOfSync: names.length,
    names,
    localOnly: pick('local-only'),
    changed: pick('differs'),
    hubOnly: pick('hub-only'),
  };
}

/** The one notice line; null when everything is in sync. */
export function describeDrift(d: SkillsDrift): string | null {
  if (d.outOfSync === 0) return null;
  let budget = MAX_NAMED;
  const groups: string[] = [];
  for (const [label, names] of [
    ['on this PC only', d.localOnly],
    ['changed', d.changed],
    ['on the hub only', d.hubOnly],
  ] as const) {
    if (names.length === 0 || budget === 0) continue;
    const shown = names.slice(0, budget);
    budget -= shown.length;
    groups.push(`${label}: ${shown.join(', ')}`);
  }
  const more = d.outOfSync - (MAX_NAMED - budget);
  const detail = groups.join('; ') + (more > 0 ? `; +${String(more)} more` : '');
  return (
    `skills: ${String(d.outOfSync)} not in sync with the hub (${detail}). ` +
    "Boxes get the hub's copy. Run `agentbox skills` to sync."
  );
}

export function driftJson(d: SkillsDrift | null): SkillsDriftJson | null {
  return d ? { outOfSync: d.outOfSync, names: d.names } : null;
}

/**
 * Print the notice: the CLI's warning style on a terminal, one plain stderr line
 * otherwise, so a script parsing stdout is untouched while an orchestrating
 * agent (which reads both) still sees it.
 */
export function printSkillsNotice(d: SkillsDrift | null): void {
  const line = d ? describeDrift(d) : null;
  if (!line) return;
  if (process.stdout.isTTY) log.warn(line);
  else process.stderr.write(line + '\n');
}
