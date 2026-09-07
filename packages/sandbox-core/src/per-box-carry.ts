/**
 * Per-box carry: the host files an agent needs a SEPARATE copy of for every box
 * it runs in (`AgentSyncSpec.clone.perBoxCarry`).
 *
 * The problem it solves is specific. A bot's channel tokens — the Telegram bot
 * token, the Discord secret — are what make it a distinct identity to the
 * outside world. A project-wide `carry:` entry hands the same token to every box
 * created from that project, so a spawned second bot answers as the first one.
 * Keying the SOURCE path by box name (`~/.agentbox/openclaw/<box>.env`) makes a
 * per-bot secret the default rather than a convention someone has to remember.
 *
 * Resolved here rather than in `apps/cli`'s `resolveCarry` for two reasons: the
 * hub runs clones and cannot import apps/cli, and these entries are declared by
 * the agent rather than by the user, so they never face the carry prompt (the
 * gate exists to ask about the USER's files leaving their machine; this is the
 * agent asking for a path it named itself, under `~/.agentbox/`).
 */

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { AgentPerBoxCarry, AgentSyncSpec, ResolvedCarryEntry } from '@agentbox/core';
import { substitutePlaceholders } from '@agentbox/core';

export interface PerBoxCarryContext {
  /** The FINAL box name — the same value `{{AGENTBOX_BOX_NAME}}` renders to. */
  boxName: string;
  /** Host home, injectable for tests. */
  home?: string;
}

/** One entry whose host file is missing. */
export interface MissingPerBoxCarry {
  /** The host path, placeholders expanded — what the user has to create. */
  path: string;
  /** What the spec asked for, for a message that matches the yaml. */
  rawSrc: string;
  optional: boolean;
}

export interface PerBoxCarryResolution {
  entries: ResolvedCarryEntry[];
  missing: MissingPerBoxCarry[];
}

/** Expand `~/` and `{{AGENTBOX_BOX_NAME}}` in a spec-declared host path. */
export function perBoxCarrySrc(src: string, ctx: PerBoxCarryContext): string {
  const home = ctx.home ?? homedir();
  const named = substitutePlaceholders(src, { AGENTBOX_BOX_NAME: ctx.boxName });
  if (named.startsWith('~/')) return resolve(home, named.slice(2));
  if (isAbsolute(named)) return resolve(named);
  // A relative source has no anchor here (the agent, not the user, wrote it and
  // there is no project dir in scope), so refuse rather than guess a cwd.
  throw new Error(`perBoxCarry src must be absolute or start with "~/": ${src}`);
}

/**
 * Resolve one agent's `perBoxCarry` entries against a box name.
 *
 * Never throws for a missing file — it reports them, because the two callers
 * want opposite things: a create logs an optional miss and continues, a clone
 * refuses. Deciding here would force one of them to un-decide it.
 */
export async function resolvePerBoxCarry(
  spec: Pick<AgentSyncSpec, 'clone'> | undefined,
  ctx: PerBoxCarryContext,
): Promise<PerBoxCarryResolution> {
  const declared: readonly AgentPerBoxCarry[] = spec?.clone?.perBoxCarry ?? [];
  const entries: ResolvedCarryEntry[] = [];
  const missing: MissingPerBoxCarry[] = [];
  for (const item of declared) {
    const absSrc = perBoxCarrySrc(item.src, ctx);
    let bytes: number | undefined;
    try {
      const st = await stat(absSrc);
      // A directory would silently change the copy's shape (tar of a tree, not a
      // file) and no agent has asked for one; refuse rather than half-support it.
      if (!st.isFile()) {
        throw new Error(`perBoxCarry src is not a regular file: ${absSrc}`);
      }
      bytes = st.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      missing.push({ path: absSrc, rawSrc: item.src, optional: item.optional === true });
      continue;
    }
    entries.push({
      rawSrc: item.src,
      rawDest: item.dest,
      absSrc,
      // `~/` is expanded in the box, against the box user's own $HOME — the box
      // user's uid differs per provider, so the host must not guess the path.
      absDest: item.dest,
      kind: 'file',
      bytes,
      ...(item.mode !== undefined ? { mode: item.mode } : {}),
      optional: item.optional === true,
    });
  }
  return { entries, missing };
}

/**
 * The refusal a CLONE raises when a per-box file is absent.
 *
 * `optional` is deliberately ignored: on a first box there is nobody to collide
 * with, but a clone exists precisely because a second bot is being made, and
 * letting it boot with no channel secrets produces a bot that either does
 * nothing or — if the workspace's own config names the source's token — answers
 * as the bot it was cloned from.
 */
export function clonePerBoxCarryRefusal(
  missing: readonly MissingPerBoxCarry[],
  boxName: string,
): string | null {
  if (missing.length === 0) return null;
  const paths = missing.map((m) => m.path).join(', ');
  return (
    `${boxName} needs its own secrets before it can be a separate bot — create ${paths} ` +
    `(0600) and run this again`
  );
}

/**
 * Merge an agent's declared per-box entries into the user-approved `carry:`
 * list for one create.
 *
 * Appended, so a user entry with the same destination is applied first and the
 * agent's own file wins — the agent declared the path it reads, and a user who
 * targets it deliberately is doing something the agent cannot know about.
 *
 * A missing OPTIONAL source is logged rather than skipped silently: "your bot
 * has no channel tokens" is the single most likely reason a fresh box does
 * nothing, and the log line names the exact path to create.
 */
export async function withPerBoxCarry(
  approved: readonly ResolvedCarryEntry[] | undefined,
  specs: readonly (Pick<AgentSyncSpec, 'clone'> | undefined)[],
  ctx: PerBoxCarryContext,
  onLog?: (line: string) => void,
): Promise<ResolvedCarryEntry[]> {
  const out = [...(approved ?? [])];
  for (const spec of specs) {
    if (!spec?.clone?.perBoxCarry?.length) continue;
    const { entries, missing } = await resolvePerBoxCarry(spec, ctx);
    const required = missing.filter((m) => !m.optional);
    if (required.length > 0) {
      throw new Error(
        `carry: ${ctx.boxName} needs ${required.map((m) => m.path).join(', ')} — create the file and run this again`,
      );
    }
    for (const m of missing) {
      onLog?.(`carry: no ${m.path} — ${ctx.boxName} starts without it`);
    }
    for (const e of entries) onLog?.(`carry: ${e.absSrc} -> ${e.rawDest} (per-box)`);
    out.push(...entries);
  }
  return out;
}
