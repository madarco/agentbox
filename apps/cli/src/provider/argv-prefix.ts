/**
 * Provider-prefix argv sugar:
 *
 *   agentbox <provider> <subcmd> [...rest]
 *     where provider ∈ the known providers, or a `docker:<host>` spec
 *     and   subcmd   ∈ SUGARED_COMMANDS
 *
 *   ↓ rewritten before commander parses
 *
 *   agentbox <subcmd> --provider <provider> [...rest]
 *
 * Anything that doesn't match (e.g. `agentbox daytona login`, `agentbox hetzner
 * firewall sync foo`, `agentbox create`) is returned unchanged.
 *
 * The `--provider <provider>` is prepended *before* the rest of the args, so
 * an explicit `--provider <flag>` later in the original argv keeps the
 * commander last-one-wins behavior: `agentbox daytona create --provider
 * hetzner` resolves to hetzner.
 *
 * A host-qualified spec rides the same path — `agentbox docker:buildbox claude`
 * becomes `claude --provider docker:buildbox`, and the create command parses the
 * host back out of it (see `./spec.ts`). It is NOT expanded to `--remote-host`
 * here, so that the last-one-wins property above still holds for the whole spec.
 */
import { agentIds } from '@agentbox/sandbox-core';
import { isKnownProvider } from './registry.js';

/**
 * `create` plus every agent, from the registry — an agent added to
 * `AGENT_SYNC_SPECS` is sugared without a second edit here. Computed lazily:
 * this module is imported while commander is still being assembled, and the
 * rewrite runs once per process, so there is nothing to memoise.
 */
export function sugaredCommands(): string[] {
  return ['create', ...agentIds()];
}

function isSugared(name: string): boolean {
  return sugaredCommands().includes(name);
}

export function rewriteProviderPrefix(argv: readonly string[]): string[] {
  // argv layout from process.argv: [node, scriptPath, ...userArgs].
  if (argv.length < 4) return [...argv];
  const provider = argv[2];
  const subcmd = argv[3];
  if (typeof provider !== 'string' || typeof subcmd !== 'string') return [...argv];
  if (!isKnownProvider(provider) || !isSugared(subcmd)) return [...argv];

  const head = argv.slice(0, 2);
  const rest = argv.slice(4);
  return [...head, subcmd, '--provider', provider, ...rest];
}
