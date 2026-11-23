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
  allAgentLlmHosts,
  boxAccount,
  findAgentSpec,
  llmProxyLaunchPreamble,
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

/**
 * The account `agent` runs on in the box running as `container`, or undefined
 * for `default`. Throws when the registry cannot be read: an install that cannot
 * tell must not fall back to pushing the owner's default login.
 */
export async function boxAccountForContainer(
  agent: string,
  container: string,
): Promise<string | undefined> {
  const state = await readState();
  const box = state.boxes.find((b) => dockerField(b, 'container') === container);
  const account = boxAccount(box, agent);
  return account === 'default' ? undefined : account;
}

/**
 * Prefix `cmd` (a tmux session command) with the LLM split-proxy preamble when
 * the box running as `container` was created with `llm.proxy: forward` and
 * `agent` declares model hosts (llm-accounts Phase 7); `cmd` unchanged
 * otherwise. The proxy is recorded on the box at create, never read from
 * current config.
 */
export async function withSessionLlmProxy(
  agent: string,
  container: string,
  cmd: string,
): Promise<string> {
  let box;
  try {
    box = (await readState()).boxes.find((b) => dockerField(b, 'container') === container);
  } catch {
    return cmd;
  }
  if (!box?.llmProxy || !findAgentSpec(agent)?.llmHosts?.length) return cmd;
  // Every agent's hosts: one split proxy serves the whole box (see the cloud seam).
  const preamble = llmProxyLaunchPreamble(box.llmProxy, allAgentLlmHosts());
  return preamble ? `${preamble}exec ${cmd}` : cmd;
}
