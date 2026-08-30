/**
 * The projection of `AGENT_SYNC_SPECS` that ctl consumes over the `agents.list`
 * RPC.
 *
 * A PROJECTION, not the raw table, for two reasons:
 *
 *  - `credential.hostBackup` is an absolute HOST path baked at module load
 *    (`join(STATE_DIR, 'claude-credentials.json')`). Inside a box it is
 *    meaningless, and shipping it leaks the host's home directory layout.
 *  - The box only needs what it acts on. Install recipes, docker volume names
 *    and host static-path sources are host-side concerns; sending them would
 *    make every one of them part of a wire contract for no reason.
 *
 * Deliberately delivered by RPC rather than a file the host writes into the box:
 * a file has to be written by the PROVIDER (cloud bootstrap, docker box-env, and
 * a hand-written equivalent in every community provider), which would make this
 * shape a contract each of them implements — so any future field would mean
 * updating all of them. Over RPC the shape stays host-side and providers stay
 * uninvolved.
 *
 * Forward compatibility runs one way: ctl must ignore fields it doesn't know, so
 * a newer host never breaks an older box. Mirrors how the in-box `agentbox.yaml`
 * parser warns on unknown keys instead of failing.
 */

import { AGENT_SYNC_SPECS } from './registry.js';

/** One file ctl watches in the box, and what the host should do when it changes. */
export interface AgentWatchDescriptor {
  /** Absolute in-box path. */
  path: string;
  /**
   * What the sync is FOR.
   *
   *  - `fanout`  — a rotating secret. The host accepts it newest-wins and
   *    re-distributes it to every other box. Correct ONLY for credentials: an
   *    OAuth refresh rotates the token, so one box refreshing kills every other
   *    copy unless the fresh blob is pushed back out.
   *  - `backup`  — everything else. Lands on the host and stops there. Fanning
   *    out non-credential content (session transcripts, logs) would copy one
   *    box's data into every other box.
   */
  sync: 'fanout' | 'backup';
  /** Validator selector for `fanout` payloads; absent for `backup`. */
  shape?: 'claude-oauth' | 'nonempty-json';
  /** Host destination for a `backup` watch, relative to the box's host workspace. */
  hostDest?: string;
}

/** What ctl needs to know about one agent. */
export interface AgentDescriptor {
  id: string;
  /** Files to watch in-box, with their intent. */
  watch: readonly AgentWatchDescriptor[];
}

/** The wire payload of `agents.list`. Versioned host-side; ctl tolerates extras. */
export interface AgentDescriptorPayload {
  schema: 1;
  agents: readonly AgentDescriptor[];
}

/**
 * Build the payload from the registry.
 *
 * Every agent's credential is a `fanout` watch — that is exactly today's
 * behaviour, restated as data. Additional watches come from the spec, and
 * default to `backup`: `fanout` has to be asked for, because getting it wrong
 * overwrites files in every other box.
 */
export function buildAgentDescriptors(): AgentDescriptorPayload {
  return {
    schema: 1,
    agents: AGENT_SYNC_SPECS.map((spec) => ({
      id: spec.id,
      watch: [
        {
          path: spec.credential.boxAbsPath,
          sync: 'fanout' as const,
          shape: spec.credential.realShape,
        },
        ...(spec.watch ?? []).map((w) => ({
          path: w.path,
          sync: w.sync ?? ('backup' as const),
          ...(w.hostDest ? { hostDest: w.hostDest } : {}),
        })),
      ],
    })),
  };
}
