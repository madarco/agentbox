/**
 * "Machine M has repo R checked out at folder F", as a hub-level fact,
 * independent of workspaces (docs/box-sources-plan.md §4). Keyed on the machine
 * id (#418) and the repo key (`repoKey` in `@agentbox/config`), so two PCs with
 * the same repo at different paths are two rows under one key.
 */
export interface CheckoutRecord {
  /** Alias-expanded repo key, computed by the reporting machine. */
  repoKey: string;
  /** `getMachineId()` of the reporter. Required: a hostname vouches for nothing. */
  machineId: string;
  /** Absolute, realpath'd folder on that machine. */
  folder: string;
  /** `getMachineLabel()` at the last report, display only. */
  label: string;
  /** ISO time of the last report that named this checkout. */
  seenAt: string;
  /** Branch checked out at the last report, informational. */
  head?: string;
}

/** One machine's report: what it has, and what it found gone. */
export interface CheckoutReport {
  machineId: string;
  label: string;
  entries: { repoKey: string; folder: string; head?: string }[];
  /**
   * Checkouts this machine reported before and no longer finds on disk. Only
   * the reporter can say so: the hub cannot stat a PC.
   */
  removed?: { repoKey: string; folder: string }[];
}

export interface CheckoutFilter {
  repoKey?: string;
  machineId?: string;
}
