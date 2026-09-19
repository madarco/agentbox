/**
 * CLI-side wrapper over the shared model-auth gate.
 *
 * The decision (flag > config > ask) lives in `@agentbox/sandbox-core` so the
 * hub can run it for a tray/web create. What stays here is the CLI's context:
 * where "the user set this explicitly" comes from, and a terminal asker that
 * declines on a non-TTY.
 */

import {
  modelAuthEnvKey,
  modelAuthSourceId,
  type AgentSettings,
  type AgentSyncSpec,
} from '@agentbox/core';
import type { ConfigSource } from '@agentbox/config';
import {
  AGENT_SYNC_SPECS,
  findAgentSpec,
  MODEL_AUTH_NONE,
  MODEL_AUTH_SETTING,
  parseModelAuthValue,
  resolveModelAuth as resolveSharedModelAuth,
  type AvailableSource,
} from '@agentbox/sandbox-core';
import { clackAsker } from './ask-clack.js';

export { MODEL_AUTH_NONE, MODEL_AUTH_SETTING };

export interface ModelAuthGateArgs {
  spec: Pick<AgentSyncSpec, 'id' | 'modelAuth'>;
  /** `--model-auth <source...>` as typed, if passed. Repeatable and comma-splitting. */
  flags?: readonly string[];
  /** The agent's settings block, defaults applied. */
  settings: AgentSettings;
  /** Where each leaf came from; `default` means the user set nothing. */
  sources: Record<string, ConfigSource>;
  yes?: boolean;
  isTTY?: boolean;
  /** Injectable for tests: which sources this host can satisfy. */
  listAvailable?: (spec: ModelAuthGateArgs['spec']) => Promise<AvailableSource[]>;
}

/**
 * Help for `--model-auth`, rendered from the row so the text cannot drift from
 * the data. Lives here rather than in the service-command factory because every
 * agent that declares sources gets the flag now, not only a service one.
 */
export function modelAuthHelp(spec: Pick<AgentSyncSpec, 'id' | 'modelAuth'>): string {
  const sources = spec.modelAuth?.sources ?? [];
  if (sources.length === 0) return `not applicable: ${spec.id} uses no host login`;
  const values = ['none', ...sources.map((s) => modelAuthSourceId(s))].join('|');
  return (
    `which host model-provider logins to seed (${values}; repeatable or comma-separated; ` +
    `default: ${spec.id}.${MODEL_AUTH_SETTING}, else ask). ` +
    sources.map((s) => `${modelAuthSourceId(s)}: ${s.label}`).join('; ')
  );
}

/** The model-auth sources the create should seed, in declaration order. */
export async function resolveModelAuth(args: ModelAuthGateArgs): Promise<string[]> {
  const tty = args.isTTY ?? process.stdin.isTTY;
  return resolveSharedModelAuth({
    spec: args.spec,
    ...(args.flags !== undefined ? { flags: args.flags } : {}),
    settings: args.settings,
    configuredExplicitly:
      (args.sources[`${args.spec.id}.${MODEL_AUTH_SETTING}`] ?? 'default') !== 'default',
    // `-y` and a non-TTY both mean "don't ask", and the prompt's own fallback
    // decides what that yields: a login FILE is declined, provider API keys the
    // host already exports are kept. So a scripted create never silently gains
    // a subscription token, and never silently loses a key it has today.
    ask: clackAsker({ isTTY: !args.yes && !!tty }),
    ...(args.listAvailable ? { listAvailable: args.listAvailable } : {}),
  });
}

/**
 * The agents whose host login can be LENT to a box — the legal values of
 * `agentbox create --model-auth`.
 *
 * Not "every agent that has a credential file": the set is the union of the
 * `agent` sources the registry's rows actually DECLARE, so a box can only be
 * seeded with a login some agent is known to be able to consume. That is what
 * keeps `create` from handing out a login no agent may borrow — claude's OAuth
 * blob above all, whose consumer-side refresh would log the host out (see
 * `docs/model-auth-sources-plan.md`, measured fact 4).
 */
export function lendableAgentIds(): string[] {
  const out: string[] = [];
  for (const spec of AGENT_SYNC_SPECS) {
    for (const source of spec.modelAuth?.sources ?? []) {
      if (source.kind !== 'agent') continue;
      if (out.includes(source.agent)) continue;
      if (!findAgentSpec(source.agent)?.credential) continue;
      out.push(source.agent);
    }
  }
  return out;
}

/**
 * Help for `agentbox create --model-auth`, rendered from the registry.
 */
export function boxModelAuthHelp(): string {
  const values = [MODEL_AUTH_NONE, ...lendableAgentIds()].join('|');
  return (
    `seed this box with a host model-provider login (${values}; repeatable or comma-separated). ` +
    "The login lands at that agent's own path in the box; an agent added to the box later " +
    'imports it on its first start.'
  );
}

/**
 * `agentbox create --model-auth <source...>` — the same seed, with no consumer.
 *
 * `create` builds an AGENTLESS box, so there is no row to validate against, no
 * `<agent>.modelAuth` key to read and nothing to ask: the flag is explicit-only
 * and the legal ids are exactly {@link lendableAgentIds}. What the box gets is
 * the lender's login at the lender's own credential path, 0600, plus
 * `box.borrowedCredentials` naming it — which is what makes an agent added to
 * the box LATER run its (hash-gated) ingest at its first start seam, with no
 * second decision from the user.
 *
 * `env:` ids are refused rather than accepted-and-ignored: nothing consumes one
 * (phase 3 of the model-auth plan was dropped), so accepting one would promise
 * a seed that never happens.
 */
export function resolveBoxModelAuth(flags: readonly string[] | undefined): string[] {
  if (flags === undefined) return [];
  const wanted = parseModelAuthValue(flags);
  for (const id of wanted) {
    if (modelAuthEnvKey(id) !== undefined) {
      throw new Error(
        `--model-auth ${id} names an environment key, which \`agentbox create\` cannot seed — ` +
          `provider API keys already reach every box from your environment. ` +
          `Name a host login instead (${lendableAgentIds().join(', ')}).`,
      );
    }
    if (!lendableAgentIds().includes(findAgentSpec(id)?.id ?? id)) {
      throw new Error(
        `--model-auth ${id} is not a host login a box can borrow — ` +
          `\`agentbox create\` accepts ${[MODEL_AUTH_NONE, ...lendableAgentIds()].join(', ')}.`,
      );
    }
  }
  // Canonical ids, so an alias (`claude-code`) and its agent never look like two
  // different sources to the box record or the credential fan-out.
  return wanted.map((id) => findAgentSpec(id)?.id ?? id);
}
