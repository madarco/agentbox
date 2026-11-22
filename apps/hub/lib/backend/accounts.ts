// Named LLM accounts on a hub create (docs/llm-accounts-plan.md, Phase 3).
// Resolved HERE, against this machine's account store and the project's config
// (never the repo's agentbox.yaml): the box's agent plus every borrowed lender,
// whose account must be a login. A remote control box has no account store yet
// (Phase 5), so a named account is refused there with a message naming it.
import { loadEffectiveConfig } from '@agentbox/config';
import { resolveBoxAccounts } from '@agentbox/sandbox-core';

export async function resolveCreateAccounts(o: {
  workspace: string;
  agent?: string;
  /** The client's `opts.accounts` (flags). */
  accounts?: Record<string, string>;
  /** Resolved model-auth sources; `env:` ids carry no account. */
  borrowCredentials: readonly string[];
}): Promise<Record<string, string>> {
  const lenders = o.borrowCredentials.filter((id) => !id.startsWith('env:'));
  const agents = o.agent
    ? [o.agent, ...lenders]
    : [...new Set([...Object.keys(o.accounts ?? {}), ...lenders])];
  const r = await resolveBoxAccounts({
    agents,
    ...(o.accounts ? { flags: o.accounts } : {}),
    config: await loadEffectiveConfig(o.workspace),
    loginOnly: lenders,
  });
  return r.accounts;
}
