/**
 * The skills digest folded into a cloud base's fingerprint
 * (docs/hub-skills-plan.md, Phase 1b).
 *
 * A cloud bake stages the baking machine's skills into its snapshot, so a base
 * is out of date when those skills change. The digest is a hash over sorted
 * `<name>:<treeSha>` lines of the skills the hub's library would hold — the ones
 * the first seed uploads (discoverable, valid, no secret-scan finding) — so a
 * PC's digest equals the library's when the two hold the same skills. No skills
 * digests to '' and folds nothing, so a machine without skills keeps the exact
 * fingerprint it had before this existed.
 *
 * Which skills count is decided once, by {@link bakeSkillsDigest}: this
 * machine's own, unless {@link SKILLS_DIGEST_ENV} names another digest. The hub
 * sets that variable to its LIBRARY digest only when its machine has no eligible
 * skills of its own (a deployed control box), so a VPS adopts a PC's shared bake
 * exactly when its skills match the library. On a PC the CLI and the hub share
 * one prepared-state and bake from one home, so both use the home.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { discoverLocalSkills, type LocalSkill } from './discover.js';

/** Set by the hub when the library, not this machine's home, decides the digest. */
export const SKILLS_DIGEST_ENV = 'AGENTBOX_SKILLS_DIGEST';

/**
 * The per-skill cap the digest assumes (`skills.maxSkillBytes` default). A skill
 * over it is never uploaded, so it never counts. A user who raises the config
 * key sees a bigger skill counted by the seed but not here; harmless, since the
 * digest only ever over-reports staleness for that one skill.
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
// otherwise repeat it per call; skills don't change within seconds.
const MEMO_MS = 30_000;
let memo: { home: string; at: number; digest: Promise<string> } | undefined;

/** Digest of this machine's library-eligible skills (memoized briefly per home). */
export function localSkillsDigest(opts: { home?: string } = {}): Promise<string> {
  const home = opts.home ?? homedir();
  const now = Date.now();
  if (memo && memo.home === home && now - memo.at < MEMO_MS) return memo.digest;
  const digest = discoverLocalSkills({ home, maxBytes: DIGEST_MAX_SKILL_BYTES })
    .then((skills) => skillsDigest(skills.filter(isLibraryEligible)))
    .catch(() => '');
  memo = { home, at: now, digest };
  return digest;
}

/** The digest to fold into a cloud base fingerprint on this machine, right now. */
export async function bakeSkillsDigest(): Promise<string> {
  const override = process.env[SKILLS_DIGEST_ENV];
  if (override !== undefined) return override;
  return localSkillsDigest();
}

/** Drop the memo (tests, and a caller that just changed the skills on disk). */
export function resetSkillsDigestMemo(): void {
  memo = undefined;
}
