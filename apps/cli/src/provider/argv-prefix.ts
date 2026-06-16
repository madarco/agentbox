/**
 * Provider-prefix argv sugar:
 *
 *   agentbox <provider> <subcmd> [...rest]
 *     where provider ∈ {docker, daytona, hetzner, vercel, e2b, islo}
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
 */
import { isKnownProvider } from './registry.js';

export const SUGARED_COMMANDS = ['create', 'claude', 'codex', 'opencode'] as const;
export type SugaredCommand = (typeof SUGARED_COMMANDS)[number];

function isSugared(name: string): name is SugaredCommand {
  return (SUGARED_COMMANDS as readonly string[]).includes(name);
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
