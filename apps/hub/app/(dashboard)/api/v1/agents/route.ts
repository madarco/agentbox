// GET /api/v1/agents — the coding agents a picker should offer, and whether this
// machine is set up for each. Read-only; drives agent discovery for clients
// (POST /boxes accepts an `agent`).
//
// Registry-driven rather than a hardcoded list, so an agent registered with
// `agentbox agent add` shows up here with no change to any client. `installed`
// means the host holds that agent's config dir or an AgentBox-saved login — a
// hint for which agents to offer first, NOT a gate: an agent installs on demand
// inside a box, so creating with an uninstalled one works.
//
// The catalog is read in the custom server's scope and handed across the
// `__AGENTBOX_HUB_SYSTEM` seam, because the registry lives behind
// @agentbox/sandbox-core, which depends on execa and cannot be imported by a
// route (it would ERR_MODULE_NOT_FOUND in the standalone build). When the seam
// is absent — the Postgres / hosted-plane read path, which carries no registry
// code — the route serves the agents built into this release and OMITS
// `installed`, since there is no host to answer for. Clients read an absent
// `installed` as "unknown", not as "no".
import { ok } from '../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The fallback catalog: the agents built into this release. Hardcoded (mirrors
// @agentbox/core's BUILTIN_AGENT_KINDS) for the same reason AGENTS in validate.ts
// is — a VALUE import of an @agentbox/* package pulls it into the Next bundle.
// The seam path above carries the real, registry-wide list, plugin agents
// included; this is only what a hub with no host scope can honestly say.
const FALLBACK_AGENTS: readonly { id: string; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'pi', label: 'Pi' },
];

export function GET(): Response {
  const sys = globalThis.__AGENTBOX_HUB_SYSTEM;
  if (sys) return ok({ agents: sys.agents() });
  return ok({ agents: FALLBACK_AGENTS });
}
