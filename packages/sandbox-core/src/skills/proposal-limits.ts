/**
 * Limits on skills proposed from a box to the hub's library
 * (docs/hub-skills-plan.md, Phase 7). Shared so the CLI refuses a skill the hub
 * would refuse anyway, before pulling it out of the box.
 *
 * A pending proposal's tarball waits in the hub's memory until a human answers
 * (up to a day), so the caps bound that memory: a box can hold at most
 * {@link SKILL_PROPOSAL_LIMITS.perBox} of them at once, the hub at most
 * {@link SKILL_PROPOSAL_LIMITS.total}, and their tarballs together at most
 * {@link SKILL_PROPOSAL_LIMITS.totalBytes}. A real skill is a few KB.
 */
export const SKILL_PROPOSAL_LIMITS = {
  /** Pending proposals one box may have waiting. */
  perBox: 3,
  /** Pending proposals across every box. */
  total: 10,
  /** One proposal: its tarball, and the skill's files unpacked (bytes). */
  maxBytes: 8 * 1024 * 1024,
  /** Every pending proposal's tarball together (bytes). */
  totalBytes: 64 * 1024 * 1024,
} as const;
