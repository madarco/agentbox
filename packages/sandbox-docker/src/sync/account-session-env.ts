/**
 * The launch-seam half of the account env policy (llm-accounts Phase 3).
 *
 * `docker exec` re-forwards the HOST's auth env at every session start, so a
 * box on a named account would get the host's API key back on top of its own
 * container env. Each agent's session starter filters what it forwards through
 * here; the box's account comes from its record, never current config.
 */
import { dockerField } from '@agentbox/core';
import {
  accountEnvPolicy,
  applyAccountEnv,
  boxAccount,
  NO_ACCOUNT_ENV,
  readState,
  resolveAgentSpec,
  type AccountEnvPolicy,
} from '@agentbox/sandbox-core';

/** The account env policy of `agent` in the box running as `container`. */
export async function sessionAccountPolicy(
  agent: string,
  container: string,
): Promise<AccountEnvPolicy> {
  try {
    const state = await readState();
    const box = state.boxes.find((b) => dockerField(b, 'container') === container);
    const account = boxAccount(box, agent);
    return await accountEnvPolicy(resolveAgentSpec(agent), account);
  } catch {
    return NO_ACCOUNT_ENV;
  }
}

/** The host env to forward at a session start, after the box's account policy. */
export async function sessionForwardEnv(
  agent: string,
  container: string,
  forwarded: Record<string, string>,
): Promise<Record<string, string>> {
  return applyAccountEnv(forwarded, await sessionAccountPolicy(agent, container));
}
