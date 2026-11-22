// Named LLM accounts on a hub create (docs/llm-accounts-plan.md, Phase 3).
// Resolved HERE, against this machine's account store and the project's config
// (never the repo's agentbox.yaml): the box's agent plus every borrowed lender,
// whose account must be a login. A remote control box has no account store yet
// (Phase 5), so a named account is refused there with a message naming it.
import { loadEffectiveConfig } from '@agentbox/config';
import { namedAccounts } from '@agentbox/core';
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
  // An agentless box carries only its lenders, so only they can be named.
  const agents = o.agent ? [o.agent, ...lenders] : lenders;
  const r = await resolveBoxAccounts({
    agents,
    ...(o.accounts ? { flags: o.accounts } : {}),
    config: await loadEffectiveConfig(o.workspace),
    loginOnly: lenders,
  });
  return r.accounts;
}

/**
 * Why a box may not become the project's DEFAULT checkpoint, or null. A box on
 * a named account carries that account's login in its filesystem (cloud), so
 * every later default box would run — and refresh, and post — account B as if
 * it were the owner's default (#437 review, finding 7).
 */
export function setDefaultCheckpointRefusal(box: {
  name: string;
  accounts?: Readonly<Record<string, string>>;
}): string | null {
  const named = namedAccounts(box.accounts);
  if (!named) return null;
  const list = Object.entries(named)
    .map(([a, n]) => `${a}=${n}`)
    .join(', ');
  return `box ${box.name} runs on a named account (${list}); a project default checkpoint must come from a box on the default account`;
}
