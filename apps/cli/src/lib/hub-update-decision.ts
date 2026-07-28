/**
 * Whether `agentbox self-update` should also update a deployed control box.
 *
 * A remote control box runs its own copy of AgentBox. Updating only the laptop
 * leaves the two on different builds — which is exactly how a fixed bug appears
 * to persist: the CLI is current, the hub that actually performs cloud creates
 * is not. `hub status` already nags about the drift; self-update is where it can
 * be closed.
 *
 * Kept pure (no fs, no network) so the rules are testable; the caller reads the
 * deploy record and probes the hub.
 */

export type HubUpdateDecision =
  | { update: true; url: string; from: string | undefined; to: string }
  | { update: false; reason: 'no-control-box' | 'local' | 'flag' | 'already-current' };

export interface HubUpdateInput {
  /** `deploy.json`, or null when this machine never deployed a control box. */
  record: { provider?: string; url?: string } | null;
  /** Version the control box reports now; undefined when it didn't answer. */
  liveVersion: string | undefined;
  /** Version this machine will be on after the self-update. */
  targetVersion: string;
  skipHubFlag: boolean;
}

export function decideHubUpdate(input: HubUpdateInput): HubUpdateDecision {
  if (input.skipHubFlag) return { update: false, reason: 'flag' };
  const record = input.record;
  if (!record?.url) return { update: false, reason: 'no-control-box' };
  // An exposed control box IS this machine's hub — the post-update refresh
  // already restarts it, and `hub update` would only restart it again.
  if (record.provider === 'local') return { update: false, reason: 'local' };
  // A hub that didn't answer still gets updated: unreachable is a reason to
  // redeploy, not to skip. Only a confirmed match is a no-op.
  if (input.liveVersion !== undefined && input.liveVersion === input.targetVersion) {
    return { update: false, reason: 'already-current' };
  }
  return { update: true, url: record.url, from: input.liveVersion, to: input.targetVersion };
}

/** The plan line for this decision. */
export function describeHubUpdate(d: HubUpdateDecision): string | null {
  if (d.update) {
    return `hub: update the control box at ${d.url} (${d.from ?? 'unknown'} → ${d.to})`;
  }
  switch (d.reason) {
    case 'flag':
      return 'hub: skipped (--skip-hub)';
    case 'already-current':
      return 'hub: control box already on this build';
    // Nothing to say: there is no remote control box to update, or it is this
    // machine's own hub (already covered by the relay/hub reload above).
    case 'no-control-box':
    case 'local':
      return null;
  }
}
