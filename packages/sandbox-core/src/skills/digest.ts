/**
 * The skills digest recorded on a cloud bake (docs/hub-skills-plan.md, Phase 1b).
 *
 * A cloud bake stages the baking machine's skills into its snapshot, so the base
 * is out of date when those skills change. The bake records a digest of them
 * (`base.skillsDigest`) plus the machine it was taken on (`base.skillsHost`):
 * a hash over sorted `<name>:<treeSha>` lines of the skills the hub's library
 * would hold — the ones the first seed uploads (discoverable, valid, no
 * secret-scan finding) — so a PC's digest equals the library's when the two hold
 * the same skills.
 *
 * Deliberately NOT folded into `contextSha256`. That hash is the cross-machine
 * identity bake sharing compares (a PC adopting a control box's bake and the
 * reverse), and two machines' skills differ, so folding them in would stop every
 * share for anyone with skills. Instead:
 *   - the machine that baked judges staleness against its own skills
 *     ({@link skillsStaleness}), and `prepare` re-bakes on a change
 *     ({@link skillsMatchForSkip});
 *   - a control box declines a PC's shared bake whose digest differs from its
 *     library (the hub's custody hydration).
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { tryGetMachineId } from '@agentbox/config';
import { discoverLocalSkills, type LocalSkill } from './discover.js';

/**
 * The per-skill cap the digest assumes (`skills.maxSkillBytes` default). A skill
 * over it is never uploaded, so it never counts. A user who raises the config
 * key sees a bigger skill counted by the seed but not here; harmless.
 */
const DIGEST_MAX_SKILL_BYTES = 50 * 1024 * 1024;

/** Whether the first seed would upload this skill as is. */
export function isLibraryEligible(s: LocalSkill): boolean {
  return s.treeSha !== '' && s.problems.length === 0 && s.findings.length === 0;
}

/** Digest of a skill set; '' for none. Order-independent. */
export function skillsDigest(entries: readonly { name: string; treeSha: string }[]): string {
  if (entries.length === 0) return '';
  const lines = entries
    .map((e) => `${e.name}:${e.treeSha}\n`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const h = createHash('sha256');
  for (const l of lines) h.update(l);
  return h.digest('hex');
}

// Discovery reads, hashes and scans every skill file. A hub enriching five
// providers' freshness in one request, or a create checking the base, would
// otherwise repeat it per call; skills don't change within seconds. Only a
// successful read is kept: a transient failure must not read as "no skills".
const MEMO_MS = 30_000;
let memo: { home: string; at: number; digest: string } | undefined;

/** Digest of this machine's library-eligible skills (memoized briefly per home). */
export async function localSkillsDigest(opts: { home?: string } = {}): Promise<string> {
  const home = opts.home ?? homedir();
  const now = Date.now();
  if (memo && memo.home === home && now - memo.at < MEMO_MS) return memo.digest;
  const skills = await discoverLocalSkills({ home, maxBytes: DIGEST_MAX_SKILL_BYTES });
  const digest = skillsDigest(skills.filter(isLibraryEligible));
  memo = { home, at: now, digest };
  return digest;
}

/** Drop the memo (tests, and a caller that just changed the skills on disk). */
export function resetSkillsDigestMemo(): void {
  memo = undefined;
}

/** What a bake records about the skills it staged. */
export interface SkillsStamp {
  skillsDigest: string;
  skillsHost?: string;
}

/**
 * The stamp for a bake about to run on this machine. A discovery failure yields
 * no stamp at all (the record then carries none and is never judged on skills),
 * rather than a wrong one.
 */
export async function bakeSkillsStamp(): Promise<SkillsStamp | Record<string, never>> {
  try {
    const skillsDigest = await localSkillsDigest();
    const host = tryGetMachineId();
    return { skillsDigest, ...(host ? { skillsHost: host } : {}) };
  } catch {
    return {};
  }
}

interface StampedEntry {
  skillsDigest?: string;
  skillsHost?: string;
}

/** Whether `entry` was stamped on THIS machine, so its skills are ours to judge. */
function stampedHere(entry: StampedEntry | null | undefined): entry is Required<StampedEntry> {
  if (!entry || entry.skillsDigest === undefined) return false;
  const here = tryGetMachineId();
  return entry.skillsHost !== undefined && here !== undefined && entry.skillsHost === here;
}

/**
 * `prepare`'s skip-fast: true unless the existing record was baked on this
 * machine with different skills. A record from before skills were tracked, or
 * one adopted from another machine, never forces a re-bake on this account.
 */
export function skillsMatchForSkip(
  entry: StampedEntry | null | undefined,
  stamp: SkillsStamp | Record<string, never>,
): boolean {
  if (!stampedHere(entry)) return true;
  if (!('skillsDigest' in stamp) || typeof stamp.skillsDigest !== 'string') return true;
  return entry.skillsDigest === stamp.skillsDigest;
}

/**
 * Freshness on the skills axis: a reason string when the base was baked on this
 * machine and its skills have changed since, else null. Never throws.
 */
export async function skillsStaleness(
  entry: StampedEntry | null | undefined,
): Promise<string | null> {
  if (!stampedHere(entry)) return null;
  try {
    const current = await localSkillsDigest();
    return current === entry.skillsDigest ? null : 'your skills changed since this base was baked';
  } catch {
    return null;
  }
}
