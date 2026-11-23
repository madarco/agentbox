/**
 * `--llm-proxy <off|forward>` on the create flows (llm-accounts Phase 7).
 */
import type { EffectiveConfig } from '@agentbox/config';

export const LLM_PROXY_FLAG_HELP =
  "route the box's LLM traffic through the hub's egress proxy: `forward` (the agent's model hosts leave from the hub's IP; cloud boxes need llm.proxyUrl) or `off`. Default: llm.proxy. Fixed at create.";

export type LlmProxyFlag = 'off' | 'forward';

/** The flag's value, or undefined when absent; throws on anything else. */
export function parseLlmProxyFlag(raw: unknown): LlmProxyFlag | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'off' || raw === 'forward') return raw;
  throw new Error(`--llm-proxy must be 'off' or 'forward' (got '${String(raw)}')`);
}

/**
 * The mode a create sends to a hub: the flag, else this project's `llm.proxy`
 * when it is on (the hub has no project config). `off` from config is left to
 * the hub's own default, which is `off` too unless that hub was set otherwise.
 */
export function edgeLlmProxyMode(raw: unknown, cfg: EffectiveConfig): LlmProxyFlag | undefined {
  return parseLlmProxyFlag(raw) ?? (cfg.llm.proxy === 'forward' ? 'forward' : undefined);
}
