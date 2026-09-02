/**
 * Persistent (always-on) boxes: who defaults to one, which providers can host
 * one, and the refusal text for the ones that can't.
 *
 * e2b and vercel run their boxes as Firecracker microVMs with a HARD per-session
 * cap (E2B Hobby 1h, Vercel Hobby ~45m). The host keepalive can push the
 * death-time out within that cap but cannot remove it, so a box created there
 * lapses whatever `persistent` says — hence a refusal by name rather than a
 * warning.
 */

import { isServiceAgent } from './sync/agent-spec.js';
import type { AgentCapabilities } from './sync/agent-spec.js';

/** Providers whose session cap makes an always-on box impossible. */
export const PERSISTENT_UNSUPPORTED: Readonly<Record<string, string>> = {
  e2b: 'E2B sandboxes carry a platform session cap (1h on Hobby, 24h on Pro) that the host keepalive can extend within, never remove — the box would lapse on its own',
  vercel:
    'Vercel Sandboxes carry a platform session cap (~45m on Hobby, ~5h on Pro+) that the host keepalive can extend within, never remove — the box would lapse on its own',
};

/**
 * The refusal message for `--persistent` / `box.persistent` on `provider`, or
 * `null` when the provider can host an always-on box.
 */
export function persistentRefusal(provider: string): string | null {
  const why = PERSISTENT_UNSUPPORTED[provider];
  if (!why) return null;
  return (
    `--persistent is not supported on ${provider}: ${why}. ` +
    'Use a provider with no session cap: docker, hetzner, digitalocean, remote-docker, or daytona.'
  );
}

/**
 * The `persistent` a create should carry, or `undefined` to leave the decision
 * to the config layers (`box.persistent`).
 *
 * The rule lives here, beside the refusal, so the whole always-on policy is one
 * file: who defaults to an always-on box, and which providers cannot host one.
 *
 * A **service agent** defaults to one. Its box hosts a daemon — a gateway that
 * is only useful while it is reachable — so an autopause or an idle lapse is an
 * outage, not a saving. That is derived from `caps.surface`, never from an agent
 * id: a new service agent gets the right default from its registry row alone.
 *
 * Returning `undefined` rather than `false` for the ordinary case is
 * load-bearing: `false` would OVERRIDE a user's `box.persistent = true`, turning
 * "no opinion" into an opt-out. Only an explicit `--no-persistent` says false.
 */
export function resolveCreatePersistent(input: {
  /** Registry row of the agent the box is FOR, if any. */
  spec?: { caps: AgentCapabilities } | undefined;
  /** `--persistent` / `--no-persistent`; `undefined` when neither was passed. */
  flag?: boolean | undefined;
}): boolean | undefined {
  if (input.flag !== undefined) return input.flag;
  if (input.spec && isServiceAgent(input.spec)) return true;
  return undefined;
}
